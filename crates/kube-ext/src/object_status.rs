//! Live status for a batch of object refs (GitOps inventories, Helm
//! manifests). Warm watcher caches answer first; the rest costs a bounded
//! number of one-shot LIST pages. Never starts a watch.

use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::{stream, StreamExt};
use kube::api::{Api, DynamicObject, ListParams};
use kube::core::{ApiResource, GroupVersionKind};
use kube::discovery::{ApiGroup, Discovery, Scope};
use kube::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::registry::{self, DiscoveredCrd, ResourceKindEntry, RowProjector};
use crate::watcher::{NsScope, ResourceWatcher, RowJson};

pub const MAX_REFS: usize = 5000;
pub const LIST_PAGE_SIZE: u32 = 500;
/// LIST pages per call across every kind — the apiserver cost ceiling.
pub const MAX_LIST_REQUESTS: usize = 20;
/// Up to this many namespaces are listed one by one; more go cluster-wide.
pub const PER_NAMESPACE_LIST_MAX: usize = 3;
const LIST_CONCURRENCY: usize = 4;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ObjectRef {
    pub group: String,
    pub kind: String,
    #[serde(default)]
    pub namespace: Option<String>,
    pub name: String,
}

/// Why a ref has no authoritative answer. A confirmed absence is not an
/// error: it's `found: false` + `status: "Missing"`.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StatusError {
    Forbidden,
    Truncated,
    NamespaceRequired,
    Discovery,
    Timeout,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ObjectStatus {
    pub group: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    pub kind_id: Option<String>,
    pub found: bool,
    pub status: Option<String>,
    pub ready: Option<String>,
    pub error: Option<StatusError>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct ObjectStatuses {
    pub items: Vec<ObjectStatus>,
    pub truncated: bool,
}

/// A warm, initially-synced watcher the caller already owns.
pub struct CachedSlot {
    pub kind_id: String,
    pub scope: NsScope,
    pub watcher: Arc<ResourceWatcher>,
}

pub struct CacheView {
    pub kind_id: String,
    pub scope: NsScope,
    pub rows: Vec<RowJson>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct KindKey {
    pub group: String,
    pub kind: String,
    pub namespaced: bool,
}

/// `(group, kind, namespaced)` behind a registry id, without discovery.
/// Synthetic kinds (Helm) have no backing object and yield `None`.
pub fn parse_kind_id(id: &str) -> Option<KindKey> {
    if let Some(p) = crate::well_known::parse_id(id) {
        return Some(KindKey {
            group: p.group,
            kind: p.kind,
            namespaced: p.namespaced,
        });
    }
    if let Some(rest) = id.strip_prefix("crd:") {
        let parts: Vec<&str> = rest.split('|').collect();
        let [group, _, _, kind, scope] = parts.as_slice() else {
            return None;
        };
        return Some(KindKey {
            group: (*group).to_owned(),
            kind: (*kind).to_owned(),
            namespaced: *scope == "ns",
        });
    }
    let e = registry::lookup_builtin(id).filter(|e| e.project.is_some())?;
    Some(KindKey {
        group: e.meta.group.to_owned(),
        kind: e.meta.kind.to_owned(),
        namespaced: e.meta.namespaced,
    })
}

pub fn covers(scope: &NsScope, namespaced: bool, ns: &str) -> bool {
    match scope {
        NsScope::All => true,
        NsScope::One(s) => namespaced && s == ns,
    }
}

/// `None` = one cluster-wide LIST; `Some(ns)` = one LIST per namespace.
pub fn plan_lists(namespaced: bool, namespaces: &BTreeSet<String>) -> Vec<Option<String>> {
    if !namespaced || namespaces.is_empty() || namespaces.len() > PER_NAMESPACE_LIST_MAX {
        return vec![None];
    }
    namespaces.iter().cloned().map(Some).collect()
}

/// `(namespace, name)` membership with `&str` lookups, so scanning thousands
/// of rows allocates only on hits.
#[derive(Debug, Default)]
pub struct KeySet {
    by_ns: HashMap<String, HashSet<String>>,
    len: usize,
}

impl KeySet {
    pub fn insert(&mut self, ns: &str, name: &str) {
        if self
            .by_ns
            .entry(ns.to_owned())
            .or_default()
            .insert(name.to_owned())
        {
            self.len += 1;
        }
    }

    pub fn contains(&self, ns: &str, name: &str) -> bool {
        self.by_ns.get(ns).is_some_and(|s| s.contains(name))
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

pub type Key = (String, String);

#[derive(Deserialize)]
struct RowKey<'a> {
    #[serde(borrow, default)]
    name: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    namespace: Option<Cow<'a, str>>,
}

/// Parse only the rows `wanted` names; the rest are key-scanned and skipped.
pub fn index_rows(rows: &[RowJson], wanted: &KeySet, namespaced: bool) -> HashMap<Key, Value> {
    let mut out = HashMap::with_capacity(wanted.len());
    for row in rows {
        let Ok(k) = serde_json::from_str::<RowKey>(row.get()) else {
            continue;
        };
        let name = k.name.as_deref().unwrap_or_default();
        let ns = if namespaced {
            k.namespace.as_deref().unwrap_or_default()
        } else {
            ""
        };
        if !wanted.contains(ns, name) {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(row.get()) {
            out.insert((ns.to_owned(), name.to_owned()), v);
        }
        if out.len() == wanted.len() {
            break;
        }
    }
    out
}

fn str_at<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && *s != "—")
}

fn int_at(row: &Value, key: &str) -> Option<i64> {
    row.get(key).and_then(Value::as_i64)
}

fn replica_status(
    ready: i64,
    desired: i64,
    zero_is_suspended: bool,
) -> (Option<String>, Option<String>) {
    let status = if desired <= 0 {
        if zero_is_suspended {
            "Suspended"
        } else {
            "Healthy"
        }
    } else if ready >= desired {
        "Healthy"
    } else {
        "Progressing"
    };
    (Some(status.to_owned()), Some(format!("{ready}/{desired}")))
}

fn parse_ratio(s: &str) -> Option<(i64, i64)> {
    let (r, d) = s.split_once('/')?;
    Some((r.trim().parse().ok()?, d.trim().parse().ok()?))
}

/// A failing container's reason outranks the pod phase, like `kubectl get`.
fn pod_status(row: &Value) -> Option<String> {
    let containers = row
        .get("container_states")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let failing = |kind_ok: fn(&str) -> bool| {
        containers.iter().find_map(|c| {
            let kind = c.get("kind").and_then(Value::as_str).unwrap_or("main");
            let state = c.get("state").and_then(Value::as_str)?;
            (kind_ok(kind) && !matches!(state, "Running" | "Completed" | "Waiting" | "Unknown"))
                .then(|| state.to_owned())
        })
    };
    failing(|k| k != "init")
        .or_else(|| failing(|k| k == "init"))
        .or_else(|| str_at(row, "phase").map(str::to_owned))
}

fn gateway_condition(v: &str) -> Option<String> {
    match v {
        "True" => Some("Ready".to_owned()),
        "False" => Some("NotReady".to_owned()),
        _ => None,
    }
}

/// Row → `(status, ready)` in the vocabulary `theme.ts::statusBucket` colours.
/// `(None, None)` means "present, no health signal".
pub fn normalize(kind_id: &str, row: &Value) -> (Option<String>, Option<String>) {
    let owned = |k: &str| str_at(row, k).map(str::to_owned);
    match kind_id {
        "pods" => (pod_status(row), owned("ready")),
        "deployments" | "statefulsets" => match str_at(row, "ready").and_then(parse_ratio) {
            Some((r, d)) => replica_status(r, d, true),
            None => (None, owned("ready")),
        },
        "daemonsets" => match (int_at(row, "ready"), int_at(row, "desired")) {
            (Some(r), Some(d)) => replica_status(r, d, false),
            _ => (None, None),
        },
        "replicasets" | "replicationcontrollers" => {
            match (int_at(row, "ready"), int_at(row, "desired")) {
                (Some(r), Some(d)) => replica_status(r, d, true),
                _ => (None, None),
            }
        }
        "jobs" => (owned("phase"), owned("completions")),
        "cronjobs" => {
            let suspended = row.get("suspend").and_then(Value::as_bool) == Some(true);
            (
                Some(if suspended { "Suspended" } else { "Active" }.to_owned()),
                None,
            )
        }
        "persistentvolumeclaims" | "persistentvolumes" | "namespaces" | "nodes" => {
            (owned("phase"), None)
        }
        id if id.starts_with("wkcrd:") => (
            owned("health")
                .or_else(|| owned("phase"))
                .or_else(|| owned("sync"))
                .or_else(|| str_at(row, "programmed").and_then(gateway_condition))
                .or_else(|| str_at(row, "accepted").and_then(gateway_condition)),
            None,
        ),
        _ => (None, None),
    }
}

fn pending(r: ObjectRef) -> ObjectStatus {
    ObjectStatus {
        group: r.group,
        kind: r.kind,
        namespace: r.namespace,
        name: r.name,
        kind_id: None,
        found: false,
        status: None,
        ready: None,
        error: None,
    }
}

fn settle(item: &mut ObjectStatus, kind_id: &str, row: Option<&Value>) {
    item.kind_id = Some(kind_id.to_owned());
    item.error = None;
    match row {
        Some(v) => {
            let (status, ready) = normalize(kind_id, v);
            item.found = true;
            item.status = status;
            item.ready = ready;
        }
        None => {
            item.found = false;
            item.status = Some("Missing".to_owned());
            item.ready = None;
        }
    }
}

fn ref_key(item: &ObjectStatus, namespaced: bool) -> Option<Key> {
    if !namespaced {
        return Some((String::new(), item.name.clone()));
    }
    let ns = item.namespace.as_deref().filter(|s| !s.is_empty())?;
    Some((ns.to_owned(), item.name.clone()))
}

type Gk = (String, String);

/// Input refs grouped by `(group, kind)`, capped at [`MAX_REFS`].
pub struct Batch {
    pub items: Vec<ObjectStatus>,
    pub truncated: bool,
    groups: HashMap<Gk, Vec<usize>>,
}

impl Batch {
    pub fn new(refs: Vec<ObjectRef>) -> Self {
        let truncated = refs.len() > MAX_REFS;
        let mut items: Vec<ObjectStatus> = refs.into_iter().map(pending).collect();
        let mut groups: HashMap<Gk, Vec<usize>> = HashMap::new();
        for (i, item) in items.iter_mut().enumerate() {
            if i >= MAX_REFS {
                item.error = Some(StatusError::Truncated);
                continue;
            }
            groups
                .entry((item.group.clone(), item.kind.clone()))
                .or_default()
                .push(i);
        }
        Self {
            items,
            truncated,
            groups,
        }
    }

    pub fn pending_count(&self) -> usize {
        self.groups.values().map(Vec::len).sum()
    }

    fn wants(&self, gk: &Gk) -> bool {
        self.groups.get(gk).is_some_and(|v| !v.is_empty())
    }

    /// Answer every ref a covering cache can; covered refs are settled
    /// (found or Missing) and leave the pending set.
    pub fn apply_cache(&mut self, views: &[CacheView]) {
        let mut by_gk: HashMap<Gk, Vec<(&CacheView, bool)>> = HashMap::new();
        for v in views {
            if let Some(k) = parse_kind_id(&v.kind_id) {
                by_gk
                    .entry((k.group, k.kind))
                    .or_default()
                    .push((v, k.namespaced));
            }
        }
        for (gk, slots) in by_gk {
            let Some(idxs) = self.groups.get_mut(&gk) else {
                continue;
            };
            let namespaced = slots[0].1;
            let mut assigned: Vec<(KeySet, Vec<(usize, Key)>)> =
                slots.iter().map(|_| Default::default()).collect();
            idxs.retain(|&i| {
                let item = &mut self.items[i];
                let Some(key) = ref_key(item, namespaced) else {
                    item.error = Some(StatusError::NamespaceRequired);
                    return false;
                };
                let Some(s) = slots
                    .iter()
                    .position(|(v, _)| covers(&v.scope, namespaced, &key.0))
                else {
                    return true;
                };
                assigned[s].0.insert(&key.0, &key.1);
                assigned[s].1.push((i, key));
                false
            });
            for ((view, _), (wanted, refs)) in slots.iter().zip(assigned) {
                if refs.is_empty() {
                    continue;
                }
                let found = index_rows(&view.rows, &wanted, namespaced);
                for (i, key) in refs {
                    settle(&mut self.items[i], &view.kind_id, found.get(&key));
                }
            }
        }
    }

    fn fail_group(&mut self, gk: &Gk, err: StatusError) {
        for i in self.groups.remove(gk).unwrap_or_default() {
            self.items[i].error = Some(err);
        }
    }

    fn miss_group(&mut self, gk: &Gk) {
        for i in self.groups.remove(gk).unwrap_or_default() {
            let item = &mut self.items[i];
            item.found = false;
            item.status = Some("Missing".to_owned());
        }
    }

    /// Split pending refs of resolved kinds into LIST jobs.
    fn list_jobs(&mut self, kinds: &HashMap<Gk, ResolvedKind>) -> Vec<ListJob> {
        let mut jobs = Vec::new();
        for (gk, kind) in kinds {
            let Some(idxs) = self.groups.remove(gk) else {
                continue;
            };
            let mut keyed = Vec::with_capacity(idxs.len());
            let mut namespaces = BTreeSet::new();
            for i in idxs {
                match ref_key(&self.items[i], kind.namespaced) {
                    Some(key) => {
                        namespaces.insert(key.0.clone());
                        keyed.push((i, key));
                    }
                    None => self.items[i].error = Some(StatusError::NamespaceRequired),
                }
            }
            if keyed.is_empty() {
                continue;
            }
            for scope in plan_lists(kind.namespaced, &namespaces) {
                let mut wanted = KeySet::default();
                let mut refs = Vec::new();
                for (i, key) in &keyed {
                    if scope.as_deref().is_none_or(|ns| ns == key.0) {
                        wanted.insert(&key.0, &key.1);
                        refs.push((*i, key.clone()));
                    }
                }
                jobs.push(ListJob {
                    kind: kind.clone(),
                    namespace: scope,
                    wanted,
                    refs,
                });
            }
        }
        jobs
    }

    /// Settle a job's refs from its outcome. Absence is only "Missing" when
    /// the LIST ran to completion.
    pub fn apply_outcome(&mut self, kind_id: &str, refs: &[(usize, Key)], outcome: &ListOutcome) {
        for (i, key) in refs {
            let item = &mut self.items[*i];
            match outcome.found.get(key) {
                Some(v) => settle(item, kind_id, Some(v)),
                None if outcome.complete => settle(item, kind_id, None),
                None => {
                    item.kind_id = Some(kind_id.to_owned());
                    let err = outcome.error.unwrap_or(StatusError::Truncated);
                    self.truncated |= err == StatusError::Truncated;
                    item.error = Some(err);
                }
            }
        }
    }

    pub fn finish(self) -> ObjectStatuses {
        ObjectStatuses {
            items: self.items,
            truncated: self.truncated,
        }
    }
}

#[derive(Clone)]
struct ResolvedKind {
    kind_id: String,
    namespaced: bool,
    ar: ApiResource,
    project: RowProjector,
}

impl ResolvedKind {
    fn from_entry(e: &ResourceKindEntry) -> Option<Self> {
        let m = &e.meta;
        Some(Self {
            kind_id: m.id.to_owned(),
            namespaced: m.namespaced,
            ar: ApiResource::from_gvk_with_plural(
                &GroupVersionKind::gvk(m.group, m.version, m.kind),
                m.plural,
            ),
            project: e.project.clone()?,
        })
    }
}

struct ListJob {
    kind: ResolvedKind,
    namespace: Option<String>,
    wanted: KeySet,
    refs: Vec<(usize, Key)>,
}

#[derive(Debug, Default)]
pub struct ListOutcome {
    pub found: HashMap<Key, Value>,
    pub complete: bool,
    pub error: Option<StatusError>,
}

fn take_budget(budget: &AtomicUsize) -> bool {
    budget
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |b| b.checked_sub(1))
        .is_ok()
}

fn classify(e: &kube::Error) -> StatusError {
    match e {
        kube::Error::Api(s) if s.code == 403 || s.code == 401 => StatusError::Forbidden,
        _ => StatusError::Failed,
    }
}

async fn run_list(client: Client, job: &ListJob, budget: &AtomicUsize) -> ListOutcome {
    let api: Api<DynamicObject> = match &job.namespace {
        Some(ns) => Api::namespaced_with(client, ns, &job.kind.ar),
        None => Api::all_with(client, &job.kind.ar),
    };
    let mut out = ListOutcome::default();
    let mut token: Option<String> = None;
    loop {
        if !take_budget(budget) {
            return out;
        }
        let mut lp = ListParams::default().limit(LIST_PAGE_SIZE);
        if let Some(t) = token.take() {
            lp = lp.continue_token(&t);
        }
        let page = match tokio::time::timeout(REQUEST_TIMEOUT, api.list(&lp)).await {
            Ok(Ok(page)) => page,
            Ok(Err(e)) => {
                let err = classify(&e);
                if err == StatusError::Failed {
                    tracing::warn!(kind = %job.kind.kind_id, error = %e, "object status: list failed");
                }
                out.error = Some(err);
                return out;
            }
            Err(_) => {
                out.error = Some(StatusError::Timeout);
                return out;
            }
        };
        for obj in &page.items {
            let name = obj.metadata.name.as_deref().unwrap_or_default();
            let ns = if job.kind.namespaced {
                obj.metadata.namespace.as_deref().unwrap_or_default()
            } else {
                ""
            };
            if !job.wanted.contains(ns, name) {
                continue;
            }
            if let Some(row) = (job.kind.project)(obj) {
                out.found.insert((ns.to_owned(), name.to_owned()), row);
            }
        }
        token = page.metadata.continue_.filter(|t| !t.is_empty());
        if token.is_none() || out.found.len() == job.wanted.len() {
            out.complete = true;
            return out;
        }
    }
}

type Discovered = Result<Option<(ApiResource, bool)>, StatusError>;

fn pick(g: &ApiGroup, kind: &str) -> Option<(ApiResource, bool)> {
    g.recommended_kind(kind)
        .map(|(ar, caps)| (ar, caps.scope == Scope::Namespaced))
}

async fn discover_kinds(client: &Client, gks: &[Gk]) -> HashMap<Gk, Discovered> {
    let names: BTreeSet<&str> = gks.iter().map(|gk| gk.0.as_str()).collect();
    let names: Vec<&str> = names.into_iter().collect();
    let mut out = HashMap::new();
    let run = Discovery::new(client.clone()).filter(&names).run();
    match tokio::time::timeout(REQUEST_TIMEOUT, run).await {
        Ok(Ok(d)) => {
            for gk in gks {
                out.insert(gk.clone(), Ok(d.get(&gk.0).and_then(|g| pick(g, &gk.1))));
            }
            return out;
        }
        Ok(Err(e)) => {
            tracing::debug!(error = %e, "object status: filtered discovery failed, retrying per group");
        }
        Err(_) => {
            for gk in gks {
                out.insert(gk.clone(), Err(StatusError::Timeout));
            }
            return out;
        }
    }
    // One broken aggregated API fails the whole filtered run; isolate it.
    for name in names {
        let res = match tokio::time::timeout(REQUEST_TIMEOUT, kube::discovery::group(client, name))
            .await
        {
            Ok(Ok(g)) => Ok(Some(g)),
            Ok(Err(kube::Error::Discovery(_))) => Ok(None),
            Ok(Err(e)) => {
                tracing::warn!(group = %name, error = %e, "object status: group discovery failed");
                Err(StatusError::Discovery)
            }
            Err(_) => Err(StatusError::Timeout),
        };
        for gk in gks.iter().filter(|gk| gk.0 == name) {
            let v = match &res {
                Ok(Some(g)) => Ok(pick(g, &gk.1)),
                Ok(None) => Ok(None),
                Err(e) => Err(*e),
            };
            out.insert(gk.clone(), v);
        }
    }
    out
}

/// Resolve pending `(group, kind)`s: built-ins from the registry, the rest
/// through one discovery pass. Kinds the apiserver doesn't serve settle as
/// Missing.
async fn resolve_kinds(client: &Client, batch: &mut Batch) -> HashMap<Gk, ResolvedKind> {
    let mut out = HashMap::new();
    let mut unresolved: Vec<Gk> = Vec::new();
    let gks: Vec<Gk> = batch.groups.keys().cloned().collect();
    for gk in gks {
        if !batch.wants(&gk) {
            continue;
        }
        match registry::lookup_by_gk(&gk.0, &gk.1).and_then(ResolvedKind::from_entry) {
            Some(k) => {
                out.insert(gk, k);
            }
            None => unresolved.push(gk),
        }
    }
    if unresolved.is_empty() {
        return out;
    }
    for (gk, found) in discover_kinds(client, &unresolved).await {
        let (ar, namespaced) = match found {
            Ok(Some(v)) => v,
            Ok(None) => {
                batch.miss_group(&gk);
                continue;
            }
            Err(e) => {
                batch.fail_group(&gk, e);
                continue;
            }
        };
        let entry = ResourceKindEntry::from_dynamic_crd(DiscoveredCrd {
            group: ar.group,
            version: ar.version,
            plural: ar.plural,
            kind: ar.kind,
            namespaced,
            printer_columns: Vec::new(),
        });
        match ResolvedKind::from_entry(&entry) {
            Some(k) => {
                out.insert(gk, k);
            }
            None => batch.miss_group(&gk),
        }
    }
    out
}

pub async fn resolve_object_statuses(
    client: Client,
    refs: Vec<ObjectRef>,
    slots: Vec<CachedSlot>,
) -> ObjectStatuses {
    let mut batch = Batch::new(refs);
    let views: Vec<CacheView> = slots
        .into_iter()
        .filter(|s| s.watcher.init_done())
        .filter(|s| parse_kind_id(&s.kind_id).is_some_and(|k| batch.wants(&(k.group, k.kind))))
        .map(|s| CacheView {
            rows: s.watcher.snapshot(),
            kind_id: s.kind_id,
            scope: s.scope,
        })
        .collect();
    batch.apply_cache(&views);
    drop(views);
    if batch.pending_count() == 0 {
        return batch.finish();
    }

    let kinds = resolve_kinds(&client, &mut batch).await;
    let jobs = batch.list_jobs(&kinds);
    let budget = AtomicUsize::new(MAX_LIST_REQUESTS);
    let outcomes: Vec<(ListJob, ListOutcome)> = stream::iter(jobs)
        .map(|job| {
            let client = client.clone();
            let budget = &budget;
            async move {
                let outcome = run_list(client, &job, budget).await;
                (job, outcome)
            }
        })
        .buffer_unordered(LIST_CONCURRENCY)
        .collect()
        .await;
    for (job, outcome) in &outcomes {
        batch.apply_outcome(&job.kind.kind_id, &job.refs, outcome);
    }
    batch.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn r(group: &str, kind: &str, ns: Option<&str>, name: &str) -> ObjectRef {
        ObjectRef {
            group: group.into(),
            kind: kind.into(),
            namespace: ns.map(Into::into),
            name: name.into(),
        }
    }

    fn row(v: Value) -> RowJson {
        RowJson::from_value(&v).unwrap()
    }

    fn st(kind_id: &str, v: Value) -> (Option<String>, Option<String>) {
        normalize(kind_id, &v)
    }

    fn s(v: &str) -> Option<String> {
        Some(v.to_owned())
    }

    #[test]
    fn normalize_pod_prefers_failing_container_reason() {
        let ok = json!({"phase":"Running","ready":"1/1","container_states":[{"kind":"main","state":"Running"}]});
        assert_eq!(st("pods", ok), (s("Running"), s("1/1")));
        let crash = json!({"phase":"Running","ready":"0/1","container_states":[
            {"kind":"init","state":"Completed"},{"kind":"main","state":"CrashLoopBackOff"}]});
        assert_eq!(st("pods", crash).0, s("CrashLoopBackOff"));
        let init = json!({"phase":"Pending","container_states":[
            {"kind":"init","state":"ImagePullBackOff"},{"kind":"main","state":"Waiting"}]});
        assert_eq!(st("pods", init).0, s("ImagePullBackOff"));
        let creating = json!({"phase":"Pending","container_states":[{"kind":"main","state":"ContainerCreating"}]});
        assert_eq!(st("pods", creating).0, s("ContainerCreating"));
        assert_eq!(st("pods", json!({})), (None, None));
    }

    #[test]
    fn normalize_replica_kinds() {
        assert_eq!(
            st("deployments", json!({"ready":"3/3"})),
            (s("Healthy"), s("3/3"))
        );
        assert_eq!(
            st("deployments", json!({"ready":"1/3"})).0,
            s("Progressing")
        );
        assert_eq!(st("statefulsets", json!({"ready":"0/0"})).0, s("Suspended"));
        assert_eq!(st("deployments", json!({"ready":"x"})), (None, s("x")));
        assert_eq!(
            st("daemonsets", json!({"ready":2,"desired":3})),
            (s("Progressing"), s("2/3"))
        );
        assert_eq!(
            st("daemonsets", json!({"ready":0,"desired":0})).0,
            s("Healthy")
        );
        assert_eq!(
            st("replicasets", json!({"ready":0,"desired":0})).0,
            s("Suspended")
        );
        assert_eq!(
            st("replicationcontrollers", json!({"ready":2,"desired":2})).0,
            s("Healthy")
        );
        assert_eq!(st("replicasets", json!({})), (None, None));
    }

    #[test]
    fn normalize_phase_kinds_and_crds() {
        assert_eq!(
            st("jobs", json!({"phase":"Failed","completions":"0/1"})),
            (s("Failed"), s("0/1"))
        );
        assert_eq!(st("cronjobs", json!({"suspend":true})).0, s("Suspended"));
        assert_eq!(st("cronjobs", json!({"suspend":false})).0, s("Active"));
        assert_eq!(
            st("persistentvolumeclaims", json!({"phase":"Bound"})).0,
            s("Bound")
        );
        assert_eq!(st("nodes", json!({"phase":"NotReady"})).0, s("NotReady"));
        let wk = "wkcrd:applications|argoproj.io|v1alpha1|applications|Application|ns";
        assert_eq!(
            st(wk, json!({"health":"Degraded","sync":"Synced"})).0,
            s("Degraded")
        );
        assert_eq!(st(wk, json!({"phase":"Stalled"})).0, s("Stalled"));
        assert_eq!(st(wk, json!({"sync":"OutOfSync"})).0, s("OutOfSync"));
        assert_eq!(st(wk, json!({"programmed":"False"})).0, s("NotReady"));
        assert_eq!(st(wk, json!({"accepted":"True"})).0, s("Ready"));
        assert_eq!(st(wk, json!({"health":"—"})).0, None);
        assert_eq!(
            st("crd:x.io|v1|foos|Foo|ns", json!({"phase":"Ready"})),
            (None, None)
        );
        assert_eq!(st("configmaps", json!({"name":"c"})), (None, None));
        assert_eq!(st("services", json!({"phase":"Running"})), (None, None));
    }

    #[test]
    fn parse_kind_id_covers_all_id_forms() {
        let k = parse_kind_id("pods").unwrap();
        assert_eq!(
            (k.group.as_str(), k.kind.as_str(), k.namespaced),
            ("", "Pod", true)
        );
        assert!(!parse_kind_id("nodes").unwrap().namespaced);
        let k = parse_kind_id("crd:x.io|v1|foos|Foo|cluster").unwrap();
        assert_eq!(
            (k.group.as_str(), k.kind.as_str(), k.namespaced),
            ("x.io", "Foo", false)
        );
        let k = parse_kind_id(
            "wkcrd:kustomizations|kustomize.toolkit.fluxcd.io|v1|kustomizations|Kustomization|ns",
        )
        .unwrap();
        assert_eq!(k.kind, "Kustomization");
        assert!(k.namespaced);
        assert!(parse_kind_id("helm_releases").is_none());
        assert!(parse_kind_id("crd:bad").is_none());
        assert!(parse_kind_id("nope").is_none());
    }

    #[test]
    fn scope_coverage() {
        assert!(covers(&NsScope::All, true, "a"));
        assert!(covers(&NsScope::All, false, ""));
        assert!(covers(&NsScope::One("a".into()), true, "a"));
        assert!(!covers(&NsScope::One("a".into()), true, "b"));
        assert!(!covers(&NsScope::One("a".into()), false, ""));
    }

    #[test]
    fn plan_lists_per_namespace_up_to_cap() {
        let ns = |v: &[&str]| v.iter().map(|s| (*s).to_owned()).collect::<BTreeSet<_>>();
        assert_eq!(plan_lists(false, &ns(&[""])), vec![None]);
        assert_eq!(
            plan_lists(true, &ns(&["a", "b"])),
            vec![Some("a".to_owned()), Some("b".to_owned())]
        );
        assert_eq!(plan_lists(true, &ns(&["a", "b", "c", "d"])), vec![None]);
        assert_eq!(plan_lists(true, &ns(&[])), vec![None]);
    }

    #[test]
    fn index_rows_parses_only_wanted() {
        let rows = vec![
            row(json!({"uid":"1","name":"a","namespace":"x","ready":"1/1"})),
            row(json!({"uid":"2","name":"b","namespace":"x"})),
            row(json!({"uid":"3","name":"a","namespace":"y"})),
        ];
        let mut wanted = KeySet::default();
        wanted.insert("x", "a");
        wanted.insert("x", "zzz");
        let found = index_rows(&rows, &wanted, true);
        assert_eq!(found.len(), 1);
        assert_eq!(found[&("x".to_owned(), "a".to_owned())]["uid"], "1");
        let cluster = vec![row(json!({"uid":"n","name":"node1","namespace":null}))];
        let mut w = KeySet::default();
        w.insert("", "node1");
        assert_eq!(index_rows(&cluster, &w, false).len(), 1);
    }

    #[test]
    fn batch_caps_refs_and_keeps_order() {
        let refs: Vec<ObjectRef> = (0..MAX_REFS + 2)
            .map(|i| r("", "Pod", Some("x"), &format!("p{i}")))
            .collect();
        let b = Batch::new(refs);
        assert!(b.truncated);
        assert_eq!(b.pending_count(), MAX_REFS);
        assert_eq!(b.items[MAX_REFS + 1].name, format!("p{}", MAX_REFS + 1));
        assert_eq!(b.items[MAX_REFS].error, Some(StatusError::Truncated));
        assert_eq!(b.items[0].error, None);
    }

    #[test]
    fn apply_cache_settles_covered_refs_only() {
        let mut b = Batch::new(vec![
            r("apps", "Deployment", Some("prod"), "web"),
            r("apps", "Deployment", Some("prod"), "gone"),
            r("apps", "Deployment", Some("dev"), "api"),
            r("apps", "Deployment", None, "nons"),
            r("", "ConfigMap", Some("prod"), "cfg"),
            r("", "Node", Some("ignored"), "n1"),
        ]);
        let views = vec![
            CacheView {
                kind_id: "deployments".into(),
                scope: NsScope::One("prod".into()),
                rows: vec![row(json!({"name":"web","namespace":"prod","ready":"2/2"}))],
            },
            CacheView {
                kind_id: "nodes".into(),
                scope: NsScope::All,
                rows: vec![row(json!({"name":"n1","phase":"Ready"}))],
            },
            CacheView {
                kind_id: "helm_releases".into(),
                scope: NsScope::All,
                rows: vec![],
            },
        ];
        b.apply_cache(&views);
        let it = &b.items;
        assert!(it[0].found);
        assert_eq!(it[0].status, s("Healthy"));
        assert_eq!(it[0].kind_id, s("deployments"));
        assert!(!it[1].found);
        assert_eq!(it[1].status, s("Missing"));
        assert_eq!(it[2].kind_id, None, "dev not covered by a prod-only cache");
        assert_eq!(it[3].error, Some(StatusError::NamespaceRequired));
        assert_eq!(it[4].kind_id, None);
        assert_eq!(
            it[5].status,
            s("Ready"),
            "cluster-scoped ignores ref namespace"
        );
        assert_eq!(b.pending_count(), 2);
    }

    #[test]
    fn list_jobs_split_by_namespace_and_outcomes_settle() {
        let mut b = Batch::new(vec![
            r("apps", "Deployment", Some("a"), "x"),
            r("apps", "Deployment", Some("b"), "y"),
            r("apps", "Deployment", Some("b"), "z"),
        ]);
        let gk: Gk = ("apps".into(), "Deployment".into());
        let kind = ResolvedKind::from_entry(registry::lookup_by_gk("apps", "Deployment").unwrap())
            .unwrap();
        let kinds = HashMap::from([(gk, kind)]);
        let mut jobs = b.list_jobs(&kinds);
        jobs.sort_by(|l, r| l.namespace.cmp(&r.namespace));
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[1].wanted.len(), 2);
        assert_eq!(b.pending_count(), 0);

        let complete = ListOutcome {
            found: HashMap::from([(("a".into(), "x".into()), json!({"ready":"1/1"}))]),
            complete: true,
            error: None,
        };
        b.apply_outcome("deployments", &jobs[0].refs, &complete);
        let partial = ListOutcome {
            found: HashMap::from([(("b".into(), "y".into()), json!({"ready":"0/1"}))]),
            complete: false,
            error: None,
        };
        b.apply_outcome("deployments", &jobs[1].refs, &partial);
        assert_eq!(b.items[0].status, s("Healthy"));
        assert_eq!(b.items[1].status, s("Progressing"));
        assert_eq!(b.items[2].error, Some(StatusError::Truncated));
        assert_eq!(b.items[2].status, None);
        assert!(b.truncated);

        let mut b = Batch::new(vec![r("apps", "Deployment", Some("a"), "x")]);
        let jobs = b.list_jobs(&kinds);
        let forbidden = ListOutcome {
            error: Some(StatusError::Forbidden),
            ..Default::default()
        };
        b.apply_outcome("deployments", &jobs[0].refs, &forbidden);
        assert_eq!(b.items[0].error, Some(StatusError::Forbidden));
        assert_eq!(b.items[0].status, None);
        assert!(!b.truncated);
    }

    #[test]
    fn budget_is_shared_and_never_underflows() {
        let b = AtomicUsize::new(2);
        assert!(take_budget(&b));
        assert!(take_budget(&b));
        assert!(!take_budget(&b));
        assert_eq!(b.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn wire_shape_is_snake_case() {
        let mut item = pending(r("", "Pod", Some("x"), "p"));
        item.error = Some(StatusError::NamespaceRequired);
        let v = serde_json::to_value(&item).unwrap();
        assert_eq!(v["error"], "namespace_required");
        assert_eq!(v["kind_id"], Value::Null);
        let parsed: ObjectRef =
            serde_json::from_value(json!({"group":"","kind":"Pod","name":"p"})).unwrap();
        assert_eq!(parsed.namespace, None);
    }
}
