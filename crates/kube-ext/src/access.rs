//! RBAC awareness — see CLAUDE.md "RBAC awareness".

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use futures::future::{BoxFuture, FutureExt, Shared};
use k8s_openapi::api::authentication::v1::{SelfSubjectReview, SelfSubjectReviewStatus};
use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
    SelfSubjectRulesReview, SelfSubjectRulesReviewSpec,
};
use kube::api::{Api, PostParams};
use kube::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tokio::task::AbortHandle;

use crate::fetch::FetchError;

const TTL: Duration = Duration::from_mins(5);
/// Webhook authorizers cache their own "unauthorized" answers about this long.
const INCONCLUSIVE_TTL: Duration = Duration::from_secs(30);
const CONCURRENCY: usize = 16;
const REVIEW_TIMEOUT: Duration = Duration::from_secs(10);
const PRUNE_FLOOR: usize = 4096;

/// One `ResourceAttributes` tuple. Empty strings mean "unset": an empty
/// namespace on a namespaced resource asks about every namespace.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attr {
    pub verb: String,
    pub group: String,
    pub resource: String,
    pub subresource: String,
    pub namespace: String,
    pub name: String,
}

impl Attr {
    fn new(verb: &str, group: &str, resource: &str, sub: &str, ns: &str, name: &str) -> Self {
        Self {
            verb: verb.to_owned(),
            group: group.to_owned(),
            resource: resource.to_owned(),
            subresource: sub.to_owned(),
            namespace: ns.to_owned(),
            name: name.to_owned(),
        }
    }

    /// "delete deployments.apps in prod" — the phrase a denial tooltip shows.
    pub fn describe(&self) -> String {
        let mut what = self.resource.clone();
        if !self.subresource.is_empty() {
            what.push('/');
            what.push_str(&self.subresource);
        }
        if !self.group.is_empty() {
            what.push('.');
            what.push_str(&self.group);
        }
        let name = if self.name.is_empty() {
            String::new()
        } else {
            format!(" \"{}\"", self.name)
        };
        let scope = if self.namespace.is_empty() {
            " (cluster-wide)".to_owned()
        } else {
            format!(" in {}", self.namespace)
        };
        format!("{} {what}{name}{scope}", self.verb)
    }

    /// Broader attributes that, when allowed, imply this one: any namespace,
    /// then any name. RBAC is purely additive, so an allow at the wider scope
    /// settles the narrow one without a request of its own.
    fn broadening(&self) -> Vec<Attr> {
        let mut out = Vec::with_capacity(3);
        if !self.namespace.is_empty() {
            out.push(Attr {
                namespace: String::new(),
                name: String::new(),
                ..self.clone()
            });
        }
        if !self.name.is_empty() {
            out.push(Attr {
                name: String::new(),
                ..self.clone()
            });
        }
        out.push(self.clone());
        out
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Access {
    Allowed,
    /// `reason` names the first missing permission.
    Denied {
        reason: String,
    },
    /// The check itself failed. Callers must treat this as allowed — the
    /// apiserver stays the final arbiter, and a broken review API must not
    /// lock the operator out of their own cluster.
    Unknown {
        error: String,
    },
}

/// What one review returned, before caching.
#[derive(Clone, Debug)]
pub enum Reviewed {
    Allowed,
    Denied,
    /// Nobody allowed and an authorizer errored (webhook timeout). Deny, but
    /// ask again soon.
    Inconclusive,
    /// SSAR itself is unavailable (404) or forbidden (hardened clusters drop
    /// `system:basic-user`). Disables checking until `invalidate`.
    Unsupported(String),
    Failed(String),
}

pub type Reviewer = Arc<dyn Fn(Attr) -> BoxFuture<'static, Reviewed> + Send + Sync>;

/// `(allowed, expires)`, or why the review couldn't answer.
type Answer = Result<(bool, Instant), String>;
type Flight = Shared<BoxFuture<'static, Answer>>;

struct State {
    entries: HashMap<Attr, (bool, Instant)>,
    flights: HashMap<Attr, (Flight, AbortHandle)>,
    unsupported: Option<String>,
    /// Bumped by `invalidate`; answers from an older generation aren't kept.
    generation: u64,
    prune_at: usize,
}

impl State {
    fn fresh(&self, attr: &Attr, now: Instant) -> Option<(bool, Instant)> {
        if self.unsupported.is_some() {
            return None;
        }
        self.entries
            .get(attr)
            .copied()
            .filter(|&(_, expires)| expires > now)
    }

    fn remember(&mut self, attr: Attr, allowed: bool, expires: Instant) {
        if self.entries.len() >= self.prune_at {
            let now = Instant::now();
            self.entries.retain(|_, &mut (_, e)| e > now);
            self.prune_at = (self.entries.len() * 2).max(PRUNE_FLOOR);
        }
        self.entries.insert(attr, (allowed, expires));
    }
}

/// Per-cluster decision cache. Lives on the cluster entry, so a reconnect
/// (new credentials, new identity) starts empty.
pub struct AccessCache {
    reviewer: Reviewer,
    limit: Arc<Semaphore>,
    state: Arc<Mutex<State>>,
}

impl AccessCache {
    pub fn new(client: Client) -> Self {
        Self::with_reviewer(Arc::new(move |attr| {
            let client = client.clone();
            async move { review(client, attr).await }.boxed()
        }))
    }

    pub fn with_reviewer(reviewer: Reviewer) -> Self {
        Self {
            reviewer,
            limit: Arc::new(Semaphore::new(CONCURRENCY)),
            state: Arc::new(Mutex::new(State {
                entries: HashMap::new(),
                flights: HashMap::new(),
                unsupported: None,
                generation: 0,
                prune_at: PRUNE_FLOOR,
            })),
        }
    }

    /// Forget every decision — after the operator fixes RBAC and asks again.
    /// Reviews still out are aborted, so they don't hold slots ahead of fresh ones.
    pub fn invalidate(&self) {
        let mut s = lock(&self.state);
        s.entries.clear();
        for (_, (_, task)) in s.flights.drain() {
            task.abort();
        }
        s.unsupported = None;
        s.generation += 1;
    }

    /// Every action's decision, in request order.
    pub async fn check(&self, requests: &[AccessRequest]) -> Vec<Access> {
        let plans: Vec<Result<Plan, String>> = requests.iter().map(plan).collect();
        let mut index: HashMap<&Attr, usize> = HashMap::new();
        let mut uniq: Vec<&Attr> = Vec::new();
        for p in plans.iter().flatten() {
            for a in p.all.iter().chain(p.any.iter().flatten()) {
                index.entry(a).or_insert_with(|| {
                    uniq.push(a);
                    uniq.len() - 1
                });
            }
        }
        let mut verdicts: Vec<Option<Verdict>> = vec![None; uniq.len()];
        {
            let s = lock(&self.state);
            let now = Instant::now();
            for (v, a) in verdicts.iter_mut().zip(&uniq) {
                *v = s.fresh(a, now).map(|(allowed, _)| Verdict::of(allowed));
            }
        }
        let misses: Vec<usize> = (0..uniq.len()).filter(|&i| verdicts[i].is_none()).collect();
        if !misses.is_empty() {
            let resolved =
                futures::future::join_all(misses.iter().map(|&i| self.resolve(uniq[i]))).await;
            for (i, v) in misses.into_iter().zip(resolved) {
                verdicts[i] = Some(v);
            }
        }
        let verdict = |a: &Attr| verdicts[index[a]].as_ref().unwrap_or(&Verdict::Allowed);
        plans
            .iter()
            .map(|plan| match plan {
                Ok(p) => combine(p, verdict),
                Err(error) => Access::Unknown {
                    error: error.clone(),
                },
            })
            .collect()
    }

    /// Checks one attribute, widest scope first.
    async fn resolve(&self, attr: &Attr) -> Verdict {
        let generation = {
            let s = lock(&self.state);
            if let Some((allowed, _)) = s.fresh(attr, Instant::now()) {
                return Verdict::of(allowed);
            }
            s.generation
        };
        for candidate in attr.broadening() {
            match self.decide(&candidate).await {
                Ok((true, expires)) => {
                    // Remember the narrow answer too, so the next ask skips
                    // the walk. It expires with the answer it came from.
                    let mut s = lock(&self.state);
                    if s.generation == generation && candidate != *attr {
                        s.remember(attr.clone(), true, expires);
                    }
                    return Verdict::Allowed;
                }
                Ok((false, _)) => {}
                Err(error) => return Verdict::Unknown(error),
            }
        }
        Verdict::Denied
    }

    async fn decide(&self, attr: &Attr) -> Answer {
        let flight = {
            let mut s = lock(&self.state);
            if let Some(error) = &s.unsupported {
                return Err(error.clone());
            }
            if let Some(hit) = s.fresh(attr, Instant::now()) {
                return Ok(hit);
            }
            let generation = s.generation;
            s.flights
                .entry(attr.clone())
                .or_insert_with(|| self.launch(attr.clone(), generation))
                .0
                .clone()
        };
        flight.await
    }

    /// One review on its own task: it finishes (freeing its permit) even when
    /// every caller has gone. The generation guard covers a task already past
    /// its last await when `invalidate` aborts it.
    fn launch(&self, attr: Attr, generation: u64) -> (Flight, AbortHandle) {
        let reviewer = self.reviewer.clone();
        let limit = self.limit.clone();
        let state = self.state.clone();
        let task = tokio::spawn(async move {
            let reviewed = match limit.acquire_owned().await {
                Ok(_permit) => tokio::time::timeout(REVIEW_TIMEOUT, reviewer(attr.clone()))
                    .await
                    .unwrap_or_else(|_| Reviewed::Failed("access review timed out".into())),
                Err(_) => Reviewed::Failed("access cache closed".into()),
            };
            let now = Instant::now();
            let answer = match &reviewed {
                Reviewed::Allowed => Ok((true, now + TTL)),
                Reviewed::Denied => Ok((false, now + TTL)),
                Reviewed::Inconclusive => Ok((false, now + INCONCLUSIVE_TTL)),
                Reviewed::Unsupported(e) | Reviewed::Failed(e) => Err(e.clone()),
            };
            let mut s = lock(&state);
            if s.generation == generation {
                s.flights.remove(&attr);
                match (&reviewed, &answer) {
                    (Reviewed::Unsupported(e), _) => s.unsupported = Some(e.clone()),
                    (_, Ok((allowed, expires))) => s.remember(attr, *allowed, *expires),
                    _ => {}
                }
            }
            answer
        });
        let abort = task.abort_handle();
        let flight = async move {
            task.await
                .unwrap_or_else(|e| Err(format!("access review aborted: {e}")))
        }
        .boxed()
        .shared();
        (flight, abort)
    }
}

/// The cluster went away: queued reviews give up and running ones stop, so
/// none outlives its connection.
impl Drop for AccessCache {
    fn drop(&mut self) {
        self.limit.close();
        for (_, (_, task)) in lock(&self.state).flights.drain() {
            task.abort();
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One attribute's answer; the reason text is only built for the denial a
/// request actually reports.
#[derive(Clone, Debug)]
enum Verdict {
    Allowed,
    Denied,
    Unknown(String),
}

impl Verdict {
    fn of(allowed: bool) -> Self {
        if allowed {
            Self::Allowed
        } else {
            Self::Denied
        }
    }
}

fn denied(attr: &Attr) -> Access {
    Access::Denied {
        reason: format!("cannot {}", attr.describe()),
    }
}

/// The first denied attribute of `attrs`, else the first unknown error.
fn first_blocker<'a>(
    attrs: &'a [Attr],
    verdict: &impl Fn(&'a Attr) -> &'a Verdict,
) -> Result<Option<&'a str>, &'a Attr> {
    let mut unknown = None;
    for a in attrs {
        match verdict(a) {
            Verdict::Denied => return Err(a),
            Verdict::Unknown(e) => {
                unknown.get_or_insert(e.as_str());
            }
            Verdict::Allowed => {}
        }
    }
    Ok(unknown)
}

/// Every `all` attribute and every attribute of one `any` group. A denial
/// outranks an unknown, which outranks an allow; the first denial in plan
/// order explains.
fn combine<'a>(p: &'a Plan, verdict: impl Fn(&'a Attr) -> &'a Verdict) -> Access {
    let mut unknown = match first_blocker(&p.all, &verdict) {
        Err(a) => return denied(a),
        Ok(u) => u,
    };
    if !p.any.is_empty() {
        let mut first_denial = None;
        let mut any_unknown = None;
        let mut allowed = false;
        for group in &p.any {
            match first_blocker(group, &verdict) {
                Ok(None) => {
                    allowed = true;
                    break;
                }
                Ok(Some(e)) => {
                    any_unknown.get_or_insert(e);
                }
                Err(a) => {
                    first_denial.get_or_insert(a);
                }
            }
        }
        if !allowed {
            match (any_unknown, first_denial) {
                (Some(e), _) => {
                    unknown.get_or_insert(e);
                }
                (None, Some(a)) => return denied(a),
                (None, None) => {}
            }
        }
    }
    match unknown {
        Some(e) => Access::Unknown {
            error: e.to_owned(),
        },
        None => Access::Allowed,
    }
}

async fn review(client: Client, attr: Attr) -> Reviewed {
    let opt = |s: &str| (!s.is_empty()).then(|| s.to_owned());
    let ssar = SelfSubjectAccessReview {
        spec: SelfSubjectAccessReviewSpec {
            resource_attributes: Some(ResourceAttributes {
                verb: Some(attr.verb.clone()),
                group: Some(attr.group.clone()),
                resource: Some(attr.resource.clone()),
                subresource: opt(&attr.subresource),
                namespace: opt(&attr.namespace),
                name: opt(&attr.name),
                ..Default::default()
            }),
            non_resource_attributes: None,
        },
        ..Default::default()
    };
    let api: Api<SelfSubjectAccessReview> = Api::all(client);
    match api.create(&PostParams::default(), &ssar).await {
        Ok(r) => match r.status {
            Some(s) if s.allowed => Reviewed::Allowed,
            // Even with `denied` set: a webhook's `failurePolicy: Deny` on a
            // timeout answers that way.
            Some(s) if s.evaluation_error.as_deref().is_some_and(|e| !e.is_empty()) => {
                Reviewed::Inconclusive
            }
            Some(_) => Reviewed::Denied,
            None => Reviewed::Failed("access review returned no status".into()),
        },
        Err(kube::Error::Api(e)) if e.code == 403 || e.code == 404 => {
            Reviewed::Unsupported(format!(
                "permission checks unavailable on this cluster: {}",
                e.message
            ))
        }
        Err(e) => Reviewed::Failed(e.to_string()),
    }
}

// ── Actions ────────────────────────────────────────────────────────────────

/// A UI verb. Each maps to every API request the backend makes for it, so a
/// grayed-out button means the action would really fail, not that some
/// unrelated verb is missing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Get,
    List,
    Watch,
    Create,
    Update,
    Patch,
    Delete,
    Logs,
    Exec,
    Attach,
    PortForward,
    Evict,
    Restart,
    Cordon,
    Drain,
    NodeShell,
    NodeProxy,
    Trigger,
    Rerun,
    Suspend,
    HelmInstall,
    HelmUpgrade,
    HelmRollback,
    HelmUninstall,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessRequest {
    pub kind_id: String,
    pub action: Action,
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// `(group, plural, namespaced)` for any kind id the rail can show.
pub fn kind_target(kind_id: &str) -> Option<(String, String, bool)> {
    match kind_id {
        // Synthetic: release state lives in `helm.sh/release.v1` Secrets.
        "helm_releases" | "helm_charts" => return Some((String::new(), "secrets".into(), true)),
        _ => {}
    }
    if let Some(p) = crate::well_known::parse_id(kind_id) {
        return Some((p.group, p.plural, p.namespaced));
    }
    if let Some(rest) = kind_id.strip_prefix("crd:") {
        let parts: Vec<&str> = rest.split('|').collect();
        return (parts.len() == 5).then(|| (parts[0].into(), parts[2].into(), parts[4] == "ns"));
    }
    crate::registry::lookup_builtin(kind_id).map(|e| {
        (
            e.meta.group.to_owned(),
            e.meta.plural.to_owned(),
            e.meta.namespaced,
        )
    })
}

/// Workloads whose logs and port-forwards resolve to their pods through
/// their selector (`log_pods::workload_selector`, `portforward::resolve_pod`).
const POD_OWNERS: &[&str] = &[
    "deployments",
    "statefulsets",
    "daemonsets",
    "replicasets",
    "jobs",
];

/// What an action needs: every `all` attribute, plus every attribute of one
/// `any` group when set.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub all: Vec<Attr>,
    pub any: Vec<Vec<Attr>>,
}

pub fn plan(req: &AccessRequest) -> Result<Plan, String> {
    // A pod restart is a rollout restart of whatever owns it, and the owner
    // is only resolved when it runs (a Deployment through its ReplicaSet).
    if req.kind_id == "pods" && req.action == Action::Restart {
        let ns = req.namespace.as_deref().unwrap_or("");
        let apps = |verb: &str, res: &str| Attr::new(verb, "apps", res, "", ns, "");
        return Ok(Plan {
            all: vec![Attr::new(
                "get",
                "",
                "pods",
                "",
                ns,
                req.name.as_deref().unwrap_or(""),
            )],
            any: vec![
                vec![apps("patch", "deployments"), apps("get", "replicasets")],
                vec![apps("patch", "statefulsets")],
                vec![apps("patch", "daemonsets")],
            ],
        });
    }
    requirements(req).map(|all| Plan {
        all,
        any: Vec::new(),
    })
}

/// Every request `action` makes on `kind_id`. All must be allowed.
pub fn requirements(req: &AccessRequest) -> Result<Vec<Attr>, String> {
    let (group, plural, namespaced) =
        kind_target(&req.kind_id).ok_or_else(|| format!("unknown kind: {}", req.kind_id))?;
    let helm = req.kind_id == "helm_releases" || req.kind_id == "helm_charts";
    // Release Secrets are `sh.helm.release.v1.<release>.v<N>`, never the
    // release name itself.
    let name = if helm {
        ""
    } else {
        req.name.as_deref().unwrap_or("")
    };
    let ns = if namespaced {
        req.namespace.as_deref().unwrap_or("")
    } else if group.is_empty() && plural == "namespaces" {
        // The apiserver authorizes `/api/v1/namespaces/X` within namespace X,
        // so a RoleBinding there can grant it.
        name
    } else {
        ""
    };
    let own = |verb: &str| Attr::new(verb, &group, &plural, "", ns, name);
    let own_sub = |verb: &str, sub: &str| Attr::new(verb, &group, &plural, sub, ns, name);
    let core = |verb: &str, resource: &str, sub: &str, name: &str| {
        Attr::new(verb, "", resource, sub, ns, name)
    };
    let slices = |ns: &str| Attr::new("list", "discovery.k8s.io", "endpointslices", "", ns, "");
    // kube-rs streams over a WebSocket GET: the apiserver authorizes `get`,
    // and since 1.35 also `create` (AuthorizePodWebsocketUpgradeCreatePermission).
    let stream = |sub: &str, pod: &str| {
        vec![
            core("get", "pods", sub, pod),
            core("create", "pods", sub, pod),
        ]
    };
    let is = |id: &str| req.kind_id == id;
    let unsupported = || Err(format!("{:?} doesn't apply to {}", req.action, req.kind_id));

    Ok(match req.action {
        // Repo chart details come from the local `helm show`; the catalog
        // watches release Secrets for the cluster's own charts.
        Action::Get if is("helm_charts") => Vec::new(),
        Action::Get if helm => vec![own("get"), own("list")],
        Action::List | Action::Watch if helm => vec![own("list"), own("watch")],
        Action::Get => vec![own("get")],
        Action::List => vec![own("list")],
        Action::Watch => vec![own("list"), own("watch")],
        Action::Create if helm => return unsupported(),
        Action::Update if helm => return unsupported(),
        Action::Patch if helm => return unsupported(),
        Action::Delete if is("helm_charts") => return unsupported(),
        Action::Create => vec![own("create")],
        Action::Update => vec![own("update")],
        Action::Patch => vec![own("patch")],
        // Helm's Secrets driver reads each revision before deleting it.
        Action::Delete | Action::HelmUninstall if helm => {
            vec![own("list"), own("get"), own("delete")]
        }
        Action::Delete => vec![own("delete")],
        Action::Logs if is("pods") => vec![
            core("get", "pods", "", name),
            core("get", "pods", "log", name),
        ],
        Action::Logs if POD_OWNERS.contains(&req.kind_id.as_str()) => vec![
            own("get"),
            core("list", "pods", "", ""),
            core("watch", "pods", "", ""),
            core("get", "pods", "log", ""),
        ],
        // The terminal runs `kubectl exec`/`attach`, which falls back to SPDY
        // (POST → `create`) when a WebSocket upgrade is refused.
        Action::Exec if is("pods") => vec![
            core("get", "pods", "", name),
            core("create", "pods", "exec", name),
        ],
        Action::Attach if is("pods") => vec![
            core("get", "pods", "", name),
            core("create", "pods", "attach", name),
        ],
        Action::PortForward if is("pods") => stream("portforward", name),
        Action::PortForward if is("services") => {
            let mut v = vec![own("get"), slices(ns)];
            v.extend(stream("portforward", ""));
            v
        }
        Action::PortForward if POD_OWNERS.contains(&req.kind_id.as_str()) => {
            let mut v = vec![own("get"), core("list", "pods", "", "")];
            v.extend(stream("portforward", ""));
            v
        }
        // Forward every Service of the namespace `name`.
        Action::PortForward if is("namespaces") => {
            let svc = |verb: &str| Attr::new(verb, "", "services", "", name, "");
            let pf = |verb: &str| Attr::new(verb, "", "pods", "portforward", name, "");
            vec![
                svc("list"),
                svc("watch"),
                svc("get"),
                slices(name),
                pf("get"),
                pf("create"),
            ]
        }
        Action::Evict if is("pods") => vec![core("create", "pods", "eviction", name)],
        Action::Restart
            if matches!(
                req.kind_id.as_str(),
                "deployments" | "statefulsets" | "daemonsets"
            ) =>
        {
            vec![own("patch")]
        }
        Action::Cordon if is("nodes") => vec![own("patch")],
        Action::Drain if is("nodes") => vec![
            own("patch"),
            Attr::new("list", "", "pods", "", "", ""),
            Attr::new("create", "", "pods", "eviction", "", ""),
        ],
        // `kubectl debug node/<n> -it -n <ns>` creates a privileged pod there,
        // waits for it (list + watch on its name), attaches, and the app
        // deletes it on close.
        Action::NodeShell if is("nodes") => {
            let shell_ns = req.namespace.as_deref().unwrap_or("default");
            let pod = |verb: &str, sub: &str| Attr::new(verb, "", "pods", sub, shell_ns, "");
            vec![
                own("get"),
                pod("create", ""),
                pod("list", ""),
                pod("watch", ""),
                pod("create", "attach"),
                pod("delete", ""),
            ]
        }
        Action::NodeProxy if is("nodes") => vec![own_sub("get", "proxy")],
        Action::Trigger if is("cronjobs") => {
            vec![own("get"), Attr::new("create", "batch", "jobs", "", ns, "")]
        }
        Action::Rerun if is("jobs") => {
            vec![own("get"), Attr::new("create", "batch", "jobs", "", ns, "")]
        }
        Action::Suspend if is("jobs") || is("cronjobs") => vec![own("patch")],
        // Helm keeps one Secret per revision: an install creates one; an
        // upgrade/rollback reads the history, creates the next, supersedes
        // the last, and deletes the oldest past `--history-max` (10).
        // An install records its result by updating the Secret it created.
        Action::HelmInstall if helm => vec![own("list"), own("create"), own("update")],
        Action::HelmUpgrade | Action::HelmRollback if is("helm_releases") => vec![
            own("list"),
            own("get"),
            own("create"),
            own("update"),
            own("delete"),
        ],
        _ => return unsupported(),
    })
}

// ── Identity and rule listing (inspection) ────────────────────────────────

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub username: Option<String>,
    pub uid: Option<String>,
    pub groups: Vec<String>,
    pub extra: BTreeMap<String, Vec<String>>,
}

/// `kubectl auth whoami`. Needs `authentication.k8s.io/v1` (Kubernetes 1.28+).
pub async fn whoami(client: Client) -> Result<Identity, FetchError> {
    let api: Api<SelfSubjectReview> = Api::all(client);
    let r = api
        .create(&PostParams::default(), &SelfSubjectReview::default())
        .await?;
    Ok(identity_from(r.status))
}

fn identity_from(status: Option<SelfSubjectReviewStatus>) -> Identity {
    let Some(u) = status.and_then(|s| s.user_info) else {
        return Identity::default();
    };
    Identity {
        username: u.username,
        uid: u.uid,
        groups: u.groups.unwrap_or_default(),
        extra: u.extra.unwrap_or_default(),
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub verbs: Vec<String>,
    pub api_groups: Vec<String>,
    pub resources: Vec<String>,
    pub resource_names: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NonResourceRule {
    pub verbs: Vec<String>,
    pub urls: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RulesReview {
    pub namespace: String,
    pub rules: Vec<Rule>,
    pub non_resource_rules: Vec<NonResourceRule>,
    /// The authorizer chain had a member that can't enumerate rules (GKE
    /// IAM, EKS access entries, Azure RBAC). Grants may be missing.
    pub incomplete: bool,
    pub evaluation_error: Option<String>,
}

/// `kubectl auth can-i --list -n <namespace>`.
pub async fn rules(client: Client, namespace: &str) -> Result<RulesReview, FetchError> {
    let api: Api<SelfSubjectRulesReview> = Api::all(client);
    let review = SelfSubjectRulesReview {
        spec: SelfSubjectRulesReviewSpec {
            namespace: Some(namespace.to_owned()),
        },
        ..Default::default()
    };
    let r = api.create(&PostParams::default(), &review).await?;
    let status = r.status.unwrap_or_default();
    let mut rules: Vec<Rule> = status
        .resource_rules
        .into_iter()
        .map(|r| Rule {
            verbs: r.verbs,
            api_groups: r.api_groups.unwrap_or_default(),
            resources: r.resources.unwrap_or_default(),
            resource_names: r.resource_names.unwrap_or_default(),
        })
        .collect();
    rules.sort_by(|a, b| {
        (&a.api_groups, &a.resources, &a.resource_names).cmp(&(
            &b.api_groups,
            &b.resources,
            &b.resource_names,
        ))
    });
    rules.dedup();
    let mut non_resource_rules: Vec<NonResourceRule> = status
        .non_resource_rules
        .into_iter()
        .map(|r| NonResourceRule {
            verbs: r.verbs,
            urls: r.non_resource_urls.unwrap_or_default(),
        })
        .collect();
    non_resource_rules.sort_by(|a, b| a.urls.cmp(&b.urls));
    non_resource_rules.dedup();
    Ok(RulesReview {
        namespace: namespace.to_owned(),
        rules,
        non_resource_rules,
        incomplete: status.incomplete,
        evaluation_error: status.evaluation_error.filter(|e| !e.is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;

    /// Reviewer allowing exactly the listed attributes and counting calls.
    fn fake(allowed: Vec<Attr>) -> (AccessCache, Arc<AtomicUsize>, Arc<Mutex<Vec<Attr>>>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (c, s) = (calls.clone(), seen.clone());
        let cache = AccessCache::with_reviewer(Arc::new(move |attr: Attr| {
            c.fetch_add(1, Ordering::SeqCst);
            lock(&s).push(attr.clone());
            let ok = allowed.contains(&attr);
            async move {
                if ok {
                    Reviewed::Allowed
                } else {
                    Reviewed::Denied
                }
            }
            .boxed()
        }));
        (cache, calls, seen)
    }

    fn req(kind: &str, action: Action, ns: Option<&str>, name: Option<&str>) -> AccessRequest {
        AccessRequest {
            kind_id: kind.into(),
            action,
            namespace: ns.map(Into::into),
            name: name.map(Into::into),
        }
    }

    fn a(verb: &str, group: &str, res: &str, sub: &str, ns: &str, name: &str) -> Attr {
        Attr::new(verb, group, res, sub, ns, name)
    }

    #[tokio::test]
    async fn cluster_wide_allow_settles_every_namespace_with_one_review() {
        let (cache, calls, _) = fake(vec![a("delete", "", "pods", "", "", "")]);
        for ns in ["a", "b", "c"] {
            let r = cache
                .check(&[req("pods", Action::Delete, Some(ns), Some("p"))])
                .await;
            assert_eq!(r, vec![Access::Allowed]);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn namespace_grant_found_after_cluster_wide_denial() {
        let (cache, calls, seen) = fake(vec![a("delete", "", "pods", "", "team", "")]);
        let r = cache
            .check(&[req("pods", Action::Delete, Some("team"), Some("p"))])
            .await;
        assert_eq!(r, vec![Access::Allowed]);
        assert_eq!(
            *lock(&seen),
            vec![
                a("delete", "", "pods", "", "", ""),
                a("delete", "", "pods", "", "team", ""),
            ]
        );
        // The narrow answer is kept, so the next ask skips the walk.
        assert!(lock(&cache.state)
            .entries
            .contains_key(&a("delete", "", "pods", "", "team", "p")));
        cache
            .check(&[req("pods", Action::Delete, Some("team"), Some("p"))])
            .await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn resource_name_grant_is_checked_last() {
        let (cache, _, _) = fake(vec![a("update", "", "configmaps", "", "ns", "only-me")]);
        let ok = cache
            .check(&[req(
                "configmaps",
                Action::Update,
                Some("ns"),
                Some("only-me"),
            )])
            .await;
        assert_eq!(ok, vec![Access::Allowed]);
        let other = cache
            .check(&[req("configmaps", Action::Update, Some("ns"), Some("other"))])
            .await;
        assert_eq!(
            other,
            vec![Access::Denied {
                reason: "cannot update configmaps \"other\" in ns".into()
            }]
        );
    }

    #[tokio::test]
    async fn every_requirement_must_hold() {
        // create pods/portforward without get: the WebSocket upgrade is refused.
        let (cache, _, _) = fake(vec![a("create", "", "pods", "portforward", "", "")]);
        let r = cache
            .check(&[req("pods", Action::PortForward, Some("ns"), Some("p"))])
            .await;
        assert_eq!(
            r,
            vec![Access::Denied {
                reason: "cannot get pods/portforward \"p\" in ns".into()
            }]
        );
    }

    #[tokio::test]
    async fn pod_restart_needs_patch_on_any_owner_kind() {
        let (cache, _, _) = fake(vec![
            a("get", "", "pods", "", "", ""),
            a("patch", "apps", "statefulsets", "", "db", ""),
        ]);
        let ok = cache
            .check(&[req("pods", Action::Restart, Some("db"), Some("db-0"))])
            .await;
        assert_eq!(ok, vec![Access::Allowed]);
        let no = cache
            .check(&[req("pods", Action::Restart, Some("web"), Some("w"))])
            .await;
        assert_eq!(
            no,
            vec![Access::Denied {
                reason: "cannot patch deployments.apps in web".into()
            }]
        );
    }

    #[tokio::test]
    async fn unsupported_review_api_degrades_to_unknown_once() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let cache = AccessCache::with_reviewer(Arc::new(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
            async { Reviewed::Unsupported("nope".into()) }.boxed()
        }));
        let r = cache
            .check(&[
                req("pods", Action::Delete, None, None),
                req("nodes", Action::Patch, None, None),
            ])
            .await;
        assert!(r.iter().all(|x| matches!(x, Access::Unknown { .. })));
        cache
            .check(&[req("secrets", Action::Get, None, None)])
            .await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "disabled after the first answers"
        );
        cache.invalidate();
        cache
            .check(&[req("secrets", Action::Get, None, None)])
            .await;
        assert_eq!(calls.load(Ordering::SeqCst), 3, "invalidate re-enables it");
    }

    #[tokio::test]
    async fn transient_failure_is_not_cached() {
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let cache = AccessCache::with_reviewer(Arc::new(move |_| {
            let n = c.fetch_add(1, Ordering::SeqCst);
            async move {
                if n == 0 {
                    Reviewed::Failed("timeout".into())
                } else {
                    Reviewed::Allowed
                }
            }
            .boxed()
        }));
        let q = [req("nodes", Action::Get, None, None)];
        assert!(matches!(cache.check(&q).await[0], Access::Unknown { .. }));
        assert_eq!(cache.check(&q).await, vec![Access::Allowed]);
    }

    #[tokio::test]
    async fn invalidate_forgets_decisions() {
        let (cache, calls, _) = fake(vec![]);
        let q = [req("nodes", Action::Cordon, None, Some("n1"))];
        cache.check(&q).await;
        let before = calls.load(Ordering::SeqCst);
        cache.check(&q).await;
        assert_eq!(calls.load(Ordering::SeqCst), before);
        cache.invalidate();
        cache.check(&q).await;
        assert!(calls.load(Ordering::SeqCst) > before);
    }

    #[tokio::test]
    async fn concurrent_identical_reviews_share_one_request() {
        let (cache, calls, _) = fake(vec![a("list", "", "pods", "", "", "")]);
        let q = [req("pods", Action::List, None, None)];
        let (x, y) = tokio::join!(cache.check(&q), cache.check(&q));
        assert_eq!(x, y);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn answer_from_before_invalidate_is_not_kept() {
        let gate = Arc::new(Notify::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let (g, c) = (gate.clone(), calls.clone());
        let cache = Arc::new(AccessCache::with_reviewer(Arc::new(move |_| {
            let n = c.fetch_add(1, Ordering::SeqCst);
            let g = g.clone();
            async move {
                if n == 0 {
                    g.notified().await;
                }
                Reviewed::Denied
            }
            .boxed()
        })));
        let q = || [req("nodes", Action::Get, None, None)];
        let first = tokio::spawn({
            let cache = cache.clone();
            async move { cache.check(&q()).await }
        });
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        cache.invalidate();
        gate.notify_one();
        first.await.unwrap();
        cache.check(&q()).await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "the stale deny was re-asked"
        );
    }

    /// Cluster-scoped CRD kinds: each asks one distinct attribute.
    fn distinct(n: usize) -> Vec<AccessRequest> {
        (0..n)
            .map(|i| {
                let kind = format!("crd:example.com|v1|w{i}|W|cluster");
                req(&kind, Action::Get, None, None)
            })
            .collect()
    }

    /// Reviewer holding every `w*` review until the gate opens.
    fn gated(gate: Arc<Semaphore>) -> AccessCache {
        AccessCache::with_reviewer(Arc::new(move |attr: Attr| {
            let gate = gate.clone();
            async move {
                if attr.resource.starts_with('w') {
                    if let Ok(p) = gate.acquire().await {
                        p.forget();
                    }
                }
                Reviewed::Allowed
            }
            .boxed()
        }))
    }

    #[tokio::test]
    async fn abandoned_reviews_still_free_their_slots() {
        let gate = Arc::new(Semaphore::new(0));
        let cache = gated(gate.clone());
        let stuck = distinct(CONCURRENCY);
        let gave_up = tokio::time::timeout(Duration::from_millis(20), cache.check(&stuck)).await;
        assert!(gave_up.is_err());
        gate.add_permits(CONCURRENCY);
        let next = [req("nodes", Action::Get, None, None)];
        let fresh = tokio::time::timeout(Duration::from_secs(2), cache.check(&next)).await;
        assert_eq!(fresh.expect("a slot came free"), vec![Access::Allowed]);
    }

    #[tokio::test]
    async fn invalidate_frees_the_slots_of_stale_reviews() {
        let gate = Arc::new(Semaphore::new(0));
        let cache = gated(gate);
        let stuck = distinct(CONCURRENCY + 4);
        let _ = tokio::time::timeout(Duration::from_millis(20), cache.check(&stuck)).await;
        cache.invalidate();
        let next = [req("nodes", Action::Get, None, None)];
        let fresh = tokio::time::timeout(Duration::from_secs(2), cache.check(&next)).await;
        assert_eq!(
            fresh.expect("stale reviews held every slot"),
            vec![Access::Allowed]
        );
    }

    #[tokio::test]
    async fn dropping_the_cache_stops_its_reviews() {
        let gate = Arc::new(Semaphore::new(0));
        let cache = gated(gate.clone());
        let pending = distinct(CONCURRENCY + 4);
        let _ = tokio::time::timeout(Duration::from_millis(20), cache.check(&pending)).await;
        let state = cache.state.clone();
        drop(cache);
        for _ in 0..50 {
            if Arc::strong_count(&state) == 1 {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("review tasks outlived the cache");
    }

    /// A fake apiserver answering every SSAR with `code` and `body`.
    fn ssar_client(code: u16, body: &'static str) -> Client {
        let svc = tower::service_fn(move |_req: http::Request<kube::client::Body>| async move {
            Ok::<_, std::convert::Infallible>(
                http::Response::builder()
                    .status(code)
                    .body(kube::client::Body::from(body.as_bytes().to_vec()))
                    .unwrap(),
            )
        });
        Client::new(svc, "default")
    }

    #[tokio::test]
    async fn review_maps_every_ssar_answer() {
        const HEAD: &str = r#""apiVersion":"authorization.k8s.io/v1","kind":"SelfSubjectAccessReview","metadata":{},"spec":{}"#;
        let ok = |status: &str| -> &'static str {
            Box::leak(format!("{{{HEAD},\"status\":{status}}}").into_boxed_str())
        };
        let forbidden = r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"forbidden","reason":"Forbidden","code":403}"#;
        let attr = a("get", "", "pods", "", "", "");
        let run = |code, body| review(ssar_client(code, body), attr.clone());
        assert!(matches!(
            run(201, ok(r#"{"allowed":true}"#)).await,
            Reviewed::Allowed
        ));
        assert!(matches!(
            run(201, ok(r#"{"allowed":false}"#)).await,
            Reviewed::Denied
        ));
        assert!(matches!(
            run(
                201,
                ok(r#"{"allowed":false,"evaluationError":"webhook timeout"}"#)
            )
            .await,
            Reviewed::Inconclusive
        ));
        assert!(matches!(
            run(
                201,
                ok(r#"{"allowed":false,"denied":true,"evaluationError":"x"}"#)
            )
            .await,
            Reviewed::Inconclusive
        ));
        assert!(matches!(
            run(403, forbidden).await,
            Reviewed::Unsupported(_)
        ));
        let missing = r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"not found","reason":"NotFound","code":404}"#;
        assert!(matches!(run(404, missing).await, Reviewed::Unsupported(_)));
        let no_status: &'static str = Box::leak(format!("{{{HEAD}}}").into_boxed_str());
        assert!(matches!(run(201, no_status).await, Reviewed::Failed(_)));
        let boom = r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"boom","reason":"InternalError","code":500}"#;
        assert!(matches!(run(500, boom).await, Reviewed::Failed(_)));
    }

    #[tokio::test]
    async fn inconclusive_denial_is_kept_briefly() {
        let cache =
            AccessCache::with_reviewer(Arc::new(|_| async { Reviewed::Inconclusive }.boxed()));
        let r = cache.check(&[req("nodes", Action::Get, None, None)]).await;
        assert!(matches!(r[0], Access::Denied { .. }));
        let s = lock(&cache.state);
        let &(allowed, expires) = s.entries.values().next().unwrap();
        assert!(!allowed);
        assert!(expires <= Instant::now() + INCONCLUSIVE_TTL);
    }

    #[test]
    fn expired_entries_are_pruned_once_the_map_is_big() {
        let (cache, _, _) = fake(vec![]);
        let mut s = lock(&cache.state);
        let past = Instant::now();
        for i in 0..PRUNE_FLOOR {
            let name = i.to_string();
            s.entries
                .insert(a("get", "", "pods", "", "", &name), (true, past));
        }
        s.remember(a("get", "", "nodes", "", "", ""), true, past + TTL);
        assert_eq!(s.entries.len(), 1);
    }

    #[tokio::test]
    async fn pod_restart_through_a_deployment_needs_its_replica_set() {
        let (cache, _, _) = fake(vec![
            a("get", "", "pods", "", "", ""),
            a("patch", "apps", "deployments", "", "", ""),
        ]);
        let r = cache
            .check(&[req("pods", Action::Restart, Some("web"), Some("w"))])
            .await;
        assert_eq!(
            r,
            vec![Access::Denied {
                reason: "cannot get replicasets.apps in web".into()
            }]
        );
    }

    #[tokio::test]
    async fn unknown_kind_is_unknown_not_denied() {
        let (cache, _, _) = fake(vec![]);
        let r = cache.check(&[req("nope", Action::Get, None, None)]).await;
        assert!(matches!(r[0], Access::Unknown { .. }));
    }

    #[test]
    fn requirements_map_actions_to_real_requests() {
        let r = |kind, action, ns| requirements(&req(kind, action, ns, None)).unwrap();
        assert_eq!(
            r("namespaces", Action::PortForward, None).len(),
            6,
            "namespace forward needs services list/watch/get, slices, pods/portforward"
        );
        // Cluster-scoped kinds ignore a stray namespace.
        assert_eq!(
            r("nodes", Action::Cordon, Some("x")),
            vec![a("patch", "", "nodes", "", "", "")]
        );
        assert_eq!(
            r("cronjobs", Action::Trigger, Some("x")),
            vec![
                a("get", "batch", "cronjobs", "", "x", ""),
                a("create", "batch", "jobs", "", "x", ""),
            ]
        );
        assert_eq!(
            r("helm_releases", Action::HelmUninstall, Some("x")),
            vec![
                a("list", "", "secrets", "", "x", ""),
                a("get", "", "secrets", "", "x", ""),
                a("delete", "", "secrets", "", "x", ""),
            ]
        );
        assert_eq!(
            r("nodes", Action::NodeShell, None)[1],
            a("create", "", "pods", "", "default", "")
        );
        assert_eq!(
            r(
                "crd:example.com|v1|widgets|Widget|ns",
                Action::Delete,
                Some("x")
            ),
            vec![a("delete", "example.com", "widgets", "", "x", "")]
        );
        assert_eq!(
            r(
                "wkcrd:argo-app|argoproj.io|v1alpha1|applications|Application|ns",
                Action::Patch,
                Some("argocd")
            ),
            vec![a("patch", "argoproj.io", "applications", "", "argocd", "")]
        );
    }

    #[test]
    fn namespace_objects_are_authorized_within_themselves() {
        let r = requirements(&req("namespaces", Action::Patch, None, Some("team"))).unwrap();
        assert_eq!(r, vec![a("patch", "", "namespaces", "", "team", "team")]);
        let list = requirements(&req("namespaces", Action::List, None, None)).unwrap();
        assert_eq!(list, vec![a("list", "", "namespaces", "", "", "")]);
    }

    #[test]
    fn helm_requirements_ignore_the_release_name() {
        let r = requirements(&req(
            "helm_releases",
            Action::HelmUpgrade,
            Some("x"),
            Some("web"),
        ))
        .unwrap();
        assert!(r.iter().all(|x| x.name.is_empty()), "{r:?}");
        assert!(
            r.contains(&a("delete", "", "secrets", "", "x", "")),
            "history-max"
        );
        // The catalog watches release Secrets for the cluster's charts.
        assert_eq!(
            requirements(&req("helm_charts", Action::Watch, Some("x"), None)).unwrap(),
            vec![
                a("list", "", "secrets", "", "x", ""),
                a("watch", "", "secrets", "", "x", ""),
            ]
        );
        assert!(requirements(&req("helm_charts", Action::Get, None, None))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn pod_owner_actions_match_what_the_backend_resolves() {
        for kind in ["cronjobs", "services", "replicationcontrollers"] {
            assert!(requirements(&req(kind, Action::Logs, Some("x"), None)).is_err());
        }
        let svc = requirements(&req("services", Action::PortForward, Some("x"), None)).unwrap();
        assert!(svc.contains(&a(
            "list",
            "discovery.k8s.io",
            "endpointslices",
            "",
            "x",
            ""
        )));
        let shell = requirements(&req("nodes", Action::NodeShell, None, Some("n"))).unwrap();
        assert!(shell.contains(&a("watch", "", "pods", "", "default", "")));
        assert!(!shell.contains(&a("get", "", "pods", "", "default", "")));
    }

    #[test]
    fn requirements_reject_actions_that_dont_apply() {
        for (kind, action) in [
            ("configmaps", Action::Exec),
            ("pods", Action::Cordon),
            ("helm_charts", Action::Delete),
            ("helm_releases", Action::Patch),
            ("services", Action::Evict),
        ] {
            assert!(
                requirements(&req(kind, action, None, None)).is_err(),
                "{kind} {action:?}"
            );
        }
    }

    #[test]
    fn combine_ranks_denied_over_unknown_and_keeps_first_reason() {
        let x = a("get", "", "pods", "", "n", "");
        let y = a("list", "", "pods", "", "n", "");
        let z = a("patch", "apps", "deployments", "", "n", "");
        let unknown = || Verdict::Unknown("e".into());
        let run = |plan: &Plan, vs: [Verdict; 3]| {
            let m: HashMap<Attr, Verdict> = [x.clone(), y.clone(), z.clone()]
                .into_iter()
                .zip(vs)
                .collect();
            combine(plan, |at| &m[at])
        };
        let all = Plan {
            all: vec![x.clone(), y.clone()],
            any: vec![],
        };
        assert_eq!(
            run(&all, [unknown(), Verdict::Denied, Verdict::Allowed]),
            denied(&y)
        );
        assert!(matches!(
            run(&all, [Verdict::Allowed, unknown(), Verdict::Allowed]),
            Access::Unknown { .. }
        ));
        let any = Plan {
            all: vec![x.clone()],
            any: vec![vec![y.clone()], vec![z.clone()]],
        };
        assert_eq!(
            run(&any, [Verdict::Allowed, Verdict::Denied, Verdict::Allowed]),
            Access::Allowed
        );
        assert_eq!(
            run(&any, [Verdict::Allowed, Verdict::Denied, Verdict::Denied]),
            denied(&y)
        );
        assert_eq!(
            combine(&Plan::default(), |_| &Verdict::Denied),
            Access::Allowed
        );
    }

    #[test]
    fn describe_reads_like_kubectl() {
        assert_eq!(
            a("patch", "apps", "deployments", "scale", "", "").describe(),
            "patch deployments/scale.apps (cluster-wide)"
        );
    }

    #[test]
    fn access_serializes_tagged() {
        assert_eq!(
            serde_json::to_value(Access::Denied { reason: "r".into() }).unwrap(),
            serde_json::json!({"state": "denied", "reason": "r"})
        );
        assert_eq!(
            serde_json::to_value(Access::Allowed).unwrap(),
            serde_json::json!({"state": "allowed"})
        );
    }

    #[test]
    fn identity_tolerates_missing_status() {
        assert_eq!(identity_from(None).username, None);
    }
}
