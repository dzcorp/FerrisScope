//! Resource registry: descriptors for every kind ferrisscope can browse.
//!
//! Each kind exposes a [`KindSpec`] that knows (a) what kube type to watch and
//! (b) how to project an instance into a flat JSON object the UI can render
//! into a column-driven table. The descriptor itself ([`ResourceKind`]) is
//! sent to the frontend so it can build navigation + table headers without
//! hard-coding any kind metadata.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use kube::{
    api::DynamicObject,
    core::{ApiResource, GroupVersionKind},
    Client, Resource,
};
use serde::Serialize;
use serde_json::Value;

use crate::watcher::ResourceWatcher;
use ferrisscope_core::cluster::ListStrategy;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Category {
    Workloads,
    Network,
    Config,
    Storage,
    Access,
    Cluster,
    /// Application-level packaging on top of raw Kubernetes — Helm releases
    /// today, Argo Applications / Flux Kustomizations later. Synthetic
    /// kinds: not single-resource watches, derived from existing data
    /// (e.g. Helm releases come from Secrets of type `helm.sh/release.v1`).
    Apps,
    /// CRDs and (eventually) browsing of their custom resources. Sits at
    /// the bottom of the rail so it doesn't compete visually with the
    /// well-known kinds above.
    CustomResources,
}

impl Category {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Workloads => "Workloads",
            Self::Network => "Network",
            Self::Config => "Config",
            Self::Storage => "Storage",
            Self::Access => "Access",
            Self::Cluster => "Cluster",
            Self::Apps => "Apps",
            Self::CustomResources => "CustomResources",
        }
    }
}

impl Serialize for Category {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnDef {
    /// Stable id, also the JSON key the projection writes.
    pub id: &'static str,
    pub header: &'static str,
    /// Hint for the renderer; UI may ignore.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ColumnKind>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ColumnKind {
    Text,
    Number,
    /// RFC3339 timestamp; UI computes a live "age" string.
    Age,
    /// "Status" pill style.
    Phase,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourceKind {
    pub id: &'static str,
    pub group: &'static str,
    pub version: &'static str,
    pub kind: &'static str,
    pub plural: &'static str,
    pub namespaced: bool,
    pub category: Category,
    pub columns: Vec<ColumnDef>,
}

/// What every kind module implements. The associated type pins the kube
/// resource; `project` flattens it into a JSON object whose keys must match
/// the registered [`ColumnDef::id`]s.
pub trait KindSpec: Send + Sync + 'static {
    type K: Resource<DynamicType = ()>
        + Clone
        + serde::de::DeserializeOwned
        + std::fmt::Debug
        + Send
        + Sync
        + 'static;

    fn meta() -> ResourceKind;
    fn project(obj: &Self::K) -> Value;
}

/// Boxed factory so the registry can be a flat array of kinds without each
/// entry being a different type.
pub struct ResourceKindEntry {
    pub meta: ResourceKind,
    pub start: Box<dyn Fn(Client, ListStrategy) -> Arc<ResourceWatcher> + Send + Sync>,
}

impl ResourceKindEntry {
    pub fn from_spec<S: KindSpec>() -> Self {
        Self {
            meta: S::meta(),
            start: Box::new(|client, strategy| {
                Arc::new(ResourceWatcher::start::<S>(client, strategy))
            }),
        }
    }

    /// Build a synthetic entry from a discovered CRD. Strings are leaked
    /// because [`ResourceKind`] uses `&'static str` for compile-time-known
    /// kinds; the leak is bounded by the cluster's CRD count + lifetime
    /// (not unbounded growth) so it's an acceptable trade for not having
    /// to refactor the typed registry. Revisit if/when we add a
    /// per-CRD-version owned-string `ResourceKindOwned` variant.
    ///
    /// If a well-known override matches `(group, kind)`, the resulting
    /// entry carries the override's stable `wkcrd:` id, target category,
    /// columns, and projection — promoting the kind out of the catch-all
    /// Custom Resources bucket into the right rail section.
    pub fn from_dynamic_crd(crd: DiscoveredCrd) -> Self {
        if let Some(wk) = crate::well_known::lookup_by_gk(&crd.group, &crd.kind) {
            return Self::from_well_known(wk, &crd);
        }

        let id: &'static str = leak(format!(
            "crd:{}|{}|{}|{}|{}",
            crd.group,
            crd.version,
            crd.plural,
            crd.kind,
            if crd.namespaced { "ns" } else { "cluster" },
        ));
        let group: &'static str = leak(crd.group.clone());
        let version: &'static str = leak(crd.version.clone());
        let kind_str: &'static str = leak(crd.kind.clone());
        let plural: &'static str = leak(crd.plural.clone());

        // Cache the printer columns for this id so a later id-only `lookup`
        // (e.g. after the user clicks a saved kind) can reconstruct the same
        // entry. When missing — cold start with no recent discovery — we
        // fall back to the basic name/namespace/age set.
        let printer_columns = if crd.printer_columns.is_empty() {
            cached_printer_columns(id)
        } else {
            cache_printer_columns(id, &crd.printer_columns);
            crd.printer_columns.clone()
        };

        let columns = if printer_columns.is_empty() {
            default_dynamic_columns(crd.namespaced)
        } else {
            dynamic_columns_with_printer(crd.namespaced, &printer_columns)
        };

        let meta = ResourceKind {
            id,
            group,
            version,
            kind: kind_str,
            plural,
            namespaced: crd.namespaced,
            category: Category::CustomResources,
            columns,
        };

        let ar = ApiResource::from_gvk_with_plural(
            &GroupVersionKind {
                group: crd.group.clone(),
                version: crd.version.clone(),
                kind: crd.kind.clone(),
            },
            &crd.plural,
        );
        let namespaced = crd.namespaced;
        let log_id = id.to_owned();
        let projector = Arc::new(DynamicProjector::new(printer_columns));
        let start: Box<dyn Fn(Client, ListStrategy) -> Arc<ResourceWatcher> + Send + Sync> =
            Box::new(move |client, strategy| {
                let p = projector.clone();
                Arc::new(ResourceWatcher::start_dynamic(
                    client,
                    ar.clone(),
                    namespaced,
                    log_id.clone(),
                    Arc::new(move |obj: &DynamicObject| p.project(obj)),
                    strategy,
                ))
            });
        Self { meta, start }
    }

    fn from_well_known(wk: &'static crate::well_known::WellKnownCrd, crd: &DiscoveredCrd) -> Self {
        let id: &'static str = leak(crate::well_known::make_id(
            wk.short_id,
            &crd.group,
            &crd.version,
            &crd.plural,
            &crd.kind,
            crd.namespaced,
        ));
        let version: &'static str = leak(crd.version.clone());
        let plural: &'static str = leak(crd.plural.clone());
        let meta = ResourceKind {
            id,
            group: wk.group,
            version,
            kind: wk.kind,
            plural,
            namespaced: crd.namespaced,
            category: wk.category,
            columns: (wk.columns)(),
        };
        let ar = ApiResource::from_gvk_with_plural(
            &GroupVersionKind {
                group: crd.group.clone(),
                version: crd.version.clone(),
                kind: crd.kind.clone(),
            },
            &crd.plural,
        );
        let namespaced = crd.namespaced;
        let log_id = id.to_owned();
        let project_fn = wk.project;
        let start: Box<dyn Fn(Client, ListStrategy) -> Arc<ResourceWatcher> + Send + Sync> =
            Box::new(move |client, strategy| {
                Arc::new(ResourceWatcher::start_dynamic(
                    client,
                    ar.clone(),
                    namespaced,
                    log_id.clone(),
                    Arc::new(project_fn),
                    strategy,
                ))
            });
        Self { meta, start }
    }
}

/// Intern + leak. Repeated calls with the same string return the same
/// `&'static str`, so the per-CRD allocation is paid once per unique
/// string for the app's lifetime — not once per `lookup` call.
fn leak(s: String) -> &'static str {
    static POOL: OnceLock<Mutex<HashMap<String, &'static str>>> = OnceLock::new();
    let pool = POOL.get_or_init(|| Mutex::new(HashMap::new()));
    let mut g = pool.lock().expect("string-intern pool poisoned");
    if let Some(existing) = g.get(&s) {
        return existing;
    }
    let leaked: &'static str = Box::leak(s.clone().into_boxed_str());
    g.insert(s, leaked);
    leaked
}

/// Process-wide cache of the `printer_columns` field of every CRD we've
/// discovered, keyed by `crd:` id. The id encodes group/version/plural/kind/scope
/// but not the printer columns (would explode the id length and re-encoding
/// JSONPaths through `|`-split is brittle). Discovery populates this; `lookup`
/// reads from it when reconstructing a [`ResourceKindEntry`] by id.
///
/// Reconstruction without a cache hit is still valid — the row falls back to
/// the default name/namespace/age columns. So a cold reconnect after restart
/// degrades gracefully until the next `discover_crds` call repopulates it.
fn printer_column_cache() -> &'static Mutex<HashMap<String, Vec<DiscoveredPrinterColumn>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Vec<DiscoveredPrinterColumn>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_printer_columns(id: &str, cols: &[DiscoveredPrinterColumn]) {
    let mut g = printer_column_cache()
        .lock()
        .expect("printer-column cache poisoned");
    g.insert(id.to_owned(), cols.to_vec());
}

fn cached_printer_columns(id: &str) -> Vec<DiscoveredPrinterColumn> {
    printer_column_cache()
        .lock()
        .expect("printer-column cache poisoned")
        .get(id)
        .cloned()
        .unwrap_or_default()
}

fn default_dynamic_columns(namespaced: bool) -> Vec<ColumnDef> {
    let mut cols = vec![ColumnDef {
        id: "name",
        header: "Name",
        kind: Some(ColumnKind::Text),
    }];
    if namespaced {
        cols.push(ColumnDef {
            id: "namespace",
            header: "Namespace",
            kind: Some(ColumnKind::Text),
        });
    }
    cols.push(ColumnDef {
        id: "creation_timestamp",
        header: "Age",
        kind: Some(ColumnKind::Age),
    });
    cols
}

/// Build the column set when the CRD ships `additionalPrinterColumns`:
/// `Name [, Namespace], <printer columns…>, Age`. Column ids are the cached
/// `pcN` slot names (see [`DynamicProjector`]) so the projector and the
/// header list agree without re-parsing JSONPaths.
fn dynamic_columns_with_printer(
    namespaced: bool,
    printer: &[DiscoveredPrinterColumn],
) -> Vec<ColumnDef> {
    let mut cols = vec![ColumnDef {
        id: "name",
        header: "Name",
        kind: Some(ColumnKind::Text),
    }];
    if namespaced {
        cols.push(ColumnDef {
            id: "namespace",
            header: "Namespace",
            kind: Some(ColumnKind::Text),
        });
    }
    for (idx, c) in printer.iter().enumerate() {
        // The kubectl printer-column "Age" is conventionally rendered live
        // by the table — match by name + type so it doesn't duplicate the
        // tail "Age" column we add below.
        if c.name.eq_ignore_ascii_case("age") && c.type_ == "date" {
            continue;
        }
        let id: &'static str = leak(format!("pc{idx}"));
        let header: &'static str = leak(c.name.clone());
        let kind = match c.type_.as_str() {
            "integer" | "number" => Some(ColumnKind::Number),
            "date" => Some(ColumnKind::Age),
            _ => Some(ColumnKind::Text),
        };
        cols.push(ColumnDef { id, header, kind });
    }
    cols.push(ColumnDef {
        id: "creation_timestamp",
        header: "Age",
        kind: Some(ColumnKind::Age),
    });
    cols
}

/// Per-kind projector closure state. Pre-compiles the JSONPaths once so
/// every row projection is just a tree walk.
struct DynamicProjector {
    printer: Vec<(String, Vec<String>, String)>, // (slot id "pcN", path segments, type)
}

impl DynamicProjector {
    fn new(printer: Vec<DiscoveredPrinterColumn>) -> Self {
        let printer = printer
            .into_iter()
            .enumerate()
            .filter_map(|(idx, c)| {
                if c.name.eq_ignore_ascii_case("age") && c.type_ == "date" {
                    return None;
                }
                let segs = parse_jsonpath_segments(&c.json_path)?;
                Some((format!("pc{idx}"), segs, c.type_))
            })
            .collect();
        Self { printer }
    }

    fn project(&self, obj: &DynamicObject) -> Value {
        let meta = &obj.metadata;
        let mut out = serde_json::Map::new();
        out.insert(
            "name".into(),
            Value::String(meta.name.clone().unwrap_or_default()),
        );
        out.insert(
            "namespace".into(),
            meta.namespace
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
        );
        out.insert(
            "creation_timestamp".into(),
            meta.creation_timestamp
                .as_ref()
                .map(|t| Value::String(t.0.to_string()))
                .unwrap_or(Value::Null),
        );
        for (slot, segs, ty) in &self.printer {
            let v = walk_jsonpath(&obj.data, segs);
            out.insert(slot.clone(), coerce_printer_value(v, ty));
        }
        Value::Object(out)
    }
}

/// Parse the dotted-path subset of JSONPath kubectl uses for printer
/// columns: `.spec.replicas`, `.status.conditions[0].status`. We support
/// dotted segment names, numeric `[idx]` indexing, and a leading dot.
/// Anything else (filters, `..`, wildcards) returns `None` and the column
/// renders as `—`.
fn parse_jsonpath_segments(path: &str) -> Option<Vec<String>> {
    let s = path.trim();
    let s = s.strip_prefix('.').unwrap_or(s);
    if s.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for raw in s.split('.') {
        if raw.is_empty() {
            return None;
        }
        // Split off any `[N]` suffixes.
        let mut rest = raw;
        let head_end = rest.find('[').unwrap_or(rest.len());
        let head = &rest[..head_end];
        if head.is_empty() {
            return None;
        }
        if !head
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return None;
        }
        out.push(head.to_owned());
        rest = &rest[head_end..];
        while let Some(stripped) = rest.strip_prefix('[') {
            let close = stripped.find(']')?;
            let inner = &stripped[..close];
            if inner.chars().all(|c| c.is_ascii_digit()) && !inner.is_empty() {
                out.push(inner.to_owned());
            } else {
                return None;
            }
            rest = &stripped[close + 1..];
        }
        if !rest.is_empty() {
            return None;
        }
    }
    Some(out)
}

fn walk_jsonpath<'a>(root: &'a Value, segs: &[String]) -> Option<&'a Value> {
    let mut cur = root;
    for seg in segs {
        cur = match cur {
            Value::Object(map) => map.get(seg)?,
            Value::Array(arr) => {
                let idx: usize = seg.parse().ok()?;
                arr.get(idx)?
            }
            _ => return None,
        };
    }
    Some(cur)
}

fn coerce_printer_value(v: Option<&Value>, ty: &str) -> Value {
    match v {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(s)) => Value::String(s.clone()),
        Some(Value::Bool(b)) => Value::String(b.to_string()),
        Some(Value::Number(n)) => match ty {
            "integer" | "number" => Value::Number(n.clone()),
            _ => Value::String(n.to_string()),
        },
        // Arrays/objects render as a compact JSON string — rare for printer
        // columns but keeps us total. Truncate so a runaway shape can't
        // wedge the table layout.
        Some(other) => {
            let mut s = serde_json::to_string(other).unwrap_or_default();
            if s.len() > 64 {
                s.truncate(64);
                s.push('…');
            }
            Value::String(s)
        }
    }
}

/// Plain-data view of a CRD that the dynamic-entry constructor needs.
/// Sourced from `apiextensions.k8s.io/v1` CRDs: pick the storage version
/// (or first served if no storage flag set) for `version`.
#[derive(Debug, Clone)]
pub struct DiscoveredCrd {
    pub group: String,
    pub version: String,
    pub plural: String,
    pub kind: String,
    pub namespaced: bool,
    /// `additionalPrinterColumns` for the served version we picked. Used to
    /// project per-row table columns for arbitrary CRDs without a hand-written
    /// `KindSpec`. Empty when the CRD doesn't declare any.
    pub printer_columns: Vec<DiscoveredPrinterColumn>,
}

#[derive(Debug, Clone)]
pub struct DiscoveredPrinterColumn {
    pub name: String,
    /// Simple JSONPath expression as declared in the CRD (e.g. `.spec.replicas`,
    /// `.status.phase`). We support the dotted-path subset; anything fancier
    /// (filters, recursive descent) renders as `—`.
    pub json_path: String,
    /// `string` / `integer` / `boolean` / `date` / `number` — used to pick
    /// a [`ColumnKind`] hint and (for `date`) trigger live-age formatting.
    pub type_: String,
}

/// Synthetic kind for Helm releases. Not a `KindSpec` because it watches
/// Secrets with a type filter and aggregates by `(namespace, release-name)`
/// — see [`ResourceWatcher::start_helm_releases`].
pub fn helm_releases_entry() -> ResourceKindEntry {
    ResourceKindEntry {
        meta: crate::kinds::helm_releases::meta(),
        start: Box::new(|client, strategy| {
            Arc::new(ResourceWatcher::start_helm_releases(client, strategy))
        }),
    }
}

/// Synthetic kind for Helm charts — derived from the same release secrets
/// `helm_releases` watches, deduplicated by `(chart_name, chart_version)`.
/// Catalog of "charts already deployed somewhere in this cluster"; the
/// detail panel exposes an Install action that runs `helm install` against
/// a chart extracted from one of the existing release secrets.
pub fn helm_charts_entry() -> ResourceKindEntry {
    ResourceKindEntry {
        meta: crate::kinds::helm_charts::meta(),
        start: Box::new(|client, strategy| {
            Arc::new(ResourceWatcher::start_helm_charts(client, strategy))
        }),
    }
}

/// All kinds the app currently knows how to browse. Order is the navigation order.
pub fn registry() -> Vec<ResourceKindEntry> {
    vec![
        ResourceKindEntry::from_spec::<crate::kinds::pods::PodSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::deployments::DeploymentSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::replica_sets::ReplicaSetSpec>(),
        ResourceKindEntry::from_spec::<
            crate::kinds::replication_controllers::ReplicationControllerSpec,
        >(),
        ResourceKindEntry::from_spec::<crate::kinds::stateful_sets::StatefulSetSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::daemon_sets::DaemonSetSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::jobs::JobSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::cron_jobs::CronJobSpec>(),
        ResourceKindEntry::from_spec::<
            crate::kinds::horizontal_pod_autoscalers::HorizontalPodAutoscalerSpec,
        >(),
        ResourceKindEntry::from_spec::<crate::kinds::pod_disruption_budgets::PodDisruptionBudgetSpec>(
        ),
        // Network
        ResourceKindEntry::from_spec::<crate::kinds::services::ServiceSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::endpoints::EndpointsSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::endpoint_slices::EndpointSliceSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::ingresses::IngressSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::ingress_classes::IngressClassSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::network_policies::NetworkPolicySpec>(),
        // Config
        ResourceKindEntry::from_spec::<crate::kinds::config_maps::ConfigMapSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::secrets::SecretSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::resource_quotas::ResourceQuotaSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::limit_ranges::LimitRangeSpec>(),
        ResourceKindEntry::from_spec::<
            crate::kinds::mutating_webhook_configurations::MutatingWebhookConfigurationSpec,
        >(),
        ResourceKindEntry::from_spec::<
            crate::kinds::validating_webhook_configurations::ValidatingWebhookConfigurationSpec,
        >(),
        // Storage
        ResourceKindEntry::from_spec::<
            crate::kinds::persistent_volume_claims::PersistentVolumeClaimSpec,
        >(),
        ResourceKindEntry::from_spec::<crate::kinds::persistent_volumes::PersistentVolumeSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::storage_classes::StorageClassSpec>(),
        // Access (RBAC)
        ResourceKindEntry::from_spec::<crate::kinds::service_accounts::ServiceAccountSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::roles::RoleSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::role_bindings::RoleBindingSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::cluster_roles::ClusterRoleSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::cluster_role_bindings::ClusterRoleBindingSpec>(
        ),
        // Cluster
        ResourceKindEntry::from_spec::<crate::kinds::nodes::NodeSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::namespaces::NamespaceSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::events::EventSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::priority_classes::PriorityClassSpec>(),
        ResourceKindEntry::from_spec::<crate::kinds::leases::LeaseSpec>(),
        // Apps (synthetic kinds — packaging on top of raw K8s).
        helm_releases_entry(),
        helm_charts_entry(),
        // Custom Resources
        ResourceKindEntry::from_spec::<
            crate::kinds::custom_resource_definitions::CustomResourceDefinitionSpec,
        >(),
    ]
}

pub fn lookup(id: &str) -> Option<ResourceKindEntry> {
    if let Some(parsed) = crate::well_known::parse_id(id) {
        let wk = crate::well_known::lookup_by_short_id(&parsed.short_id)?;
        let crd = DiscoveredCrd {
            group: parsed.group,
            version: parsed.version,
            plural: parsed.plural,
            kind: parsed.kind,
            namespaced: parsed.namespaced,
            printer_columns: Vec::new(),
        };
        return Some(ResourceKindEntry::from_well_known(wk, &crd));
    }
    if let Some(rest) = id.strip_prefix("crd:") {
        // crd:<group>|<version>|<plural>|<kind>|<scope>
        let parts: Vec<&str> = rest.split('|').collect();
        if parts.len() != 5 {
            return None;
        }
        let scope = parts[4];
        let crd = DiscoveredCrd {
            group: parts[0].to_owned(),
            version: parts[1].to_owned(),
            plural: parts[2].to_owned(),
            kind: parts[3].to_owned(),
            namespaced: scope == "ns",
            // `from_dynamic_crd` will fall back to the cached columns for
            // this id if we leave this empty.
            printer_columns: Vec::new(),
        };
        return Some(ResourceKindEntry::from_dynamic_crd(crd));
    }
    registry().into_iter().find(|e| e.meta.id == id)
}
