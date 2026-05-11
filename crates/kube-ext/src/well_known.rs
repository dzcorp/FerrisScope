//! Well-known CRDs: optional override layer that turns generic-looking
//! `DynamicObject` rows into first-class kinds with proper columns, a
//! reasonable category in the rail, and a rich detail projection.
//!
//! The watcher path is unchanged — we still drive everything through
//! `DynamicObject` so we don't pull in third-party Rust crates for every
//! ecosystem (Gateway API, Argo, Cert-Manager, …). What changes is:
//!
//! * `from_dynamic_crd` consults this registry by `(group, kind)` when CRD
//!   discovery surfaces a kind. On hit, the resulting `ResourceKindEntry`
//!   carries the override's stable id, category, columns, and projection.
//! * `lookup` recognises the override id format and reconstructs the
//!   dynamic watcher with the per-cluster version+plural+scope encoded in
//!   the id (so reconnects work across app restarts).
//!
//! Naming: id is `wkcrd:<short>|<group>|<version>|<plural>|<kind>|<scope>`.
//! `<short>` is the stable user-visible kind id (e.g. `gateways`) — the
//! frontend dispatches detail summaries by that prefix without ever parsing
//! the rest. The `<version>` slot captures whatever served version the
//! cluster has installed so we don't hard-code Gateway API at v1 and break
//! on clusters still on v1beta1.

use kube::api::DynamicObject;
use serde_json::Value;

use crate::registry::{Category, ColumnDef};

pub mod gateway_api;

/// Static descriptor for one well-known CRD shape.
pub struct WellKnownCrd {
    /// Short, stable id used by the frontend for detail dispatch
    /// (`gateways`, `httproutes`, …). Must not collide with any built-in
    /// kind id in `registry()`.
    pub short_id: &'static str,
    pub group: &'static str,
    pub kind: &'static str,
    pub category: Category,
    pub columns: fn() -> Vec<ColumnDef>,
    pub project: fn(&DynamicObject) -> Value,
    pub project_detail: fn(&DynamicObject) -> Value,
}

/// All well-known overrides ferrisscope ships. Order is unrelated to rail
/// order (the rail groups by category).
pub fn registry() -> &'static [WellKnownCrd] {
    gateway_api::OVERRIDES
}

pub fn lookup_by_gk(group: &str, kind: &str) -> Option<&'static WellKnownCrd> {
    registry()
        .iter()
        .find(|w| w.group == group && w.kind == kind)
}

pub fn lookup_by_short_id(short_id: &str) -> Option<&'static WellKnownCrd> {
    registry().iter().find(|w| w.short_id == short_id)
}

/// Build the override id string `wkcrd:<short>|<group>|<version>|<plural>|<kind>|<scope>`.
pub fn make_id(
    short: &str,
    group: &str,
    version: &str,
    plural: &str,
    kind: &str,
    namespaced: bool,
) -> String {
    format!(
        "wkcrd:{}|{}|{}|{}|{}|{}",
        short,
        group,
        version,
        plural,
        kind,
        if namespaced { "ns" } else { "cluster" },
    )
}

/// Parsed view of an override id.
#[derive(Debug, Clone)]
pub struct ParsedWkcrd {
    pub short_id: String,
    pub group: String,
    pub version: String,
    pub plural: String,
    pub kind: String,
    pub namespaced: bool,
}

pub fn parse_id(id: &str) -> Option<ParsedWkcrd> {
    let rest = id.strip_prefix("wkcrd:")?;
    let parts: Vec<&str> = rest.split('|').collect();
    if parts.len() != 6 {
        return None;
    }
    Some(ParsedWkcrd {
        short_id: parts[0].to_owned(),
        group: parts[1].to_owned(),
        version: parts[2].to_owned(),
        plural: parts[3].to_owned(),
        kind: parts[4].to_owned(),
        namespaced: parts[5] == "ns",
    })
}

// ── Helpers shared by override projections ────────────────────────────────
//
// All overrides walk `DynamicObject` JSON with these. Keep them small and
// total — projections must never panic on shape drift between API versions.

pub(crate) fn dyn_meta_value(obj: &DynamicObject) -> Value {
    let m = &obj.metadata;
    let labels: Vec<Value> = m
        .labels
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| serde_json::json!([k, v])).collect())
        .unwrap_or_default();
    let annotations = crate::kinds::pod_template::project_annotations(m.annotations.as_ref());
    let controlled_by = m
        .owner_references
        .as_ref()
        .and_then(|owners| owners.iter().find(|o| o.controller == Some(true)))
        .map(|o| serde_json::json!({ "kind": o.kind.clone(), "name": o.name.clone() }));
    serde_json::json!({
        "name": m.name.clone().unwrap_or_default(),
        "namespace": m.namespace.clone(),
        "uid": m.uid.clone(),
        "created_at": m.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        "labels": labels,
        "annotations": annotations,
        "controlled_by": controlled_by,
        "generation": m.generation,
    })
}

pub(crate) fn obj_get<'a>(obj: &'a DynamicObject, path: &[&str]) -> Option<&'a Value> {
    let mut cur = obj.data.as_object()?.get(path[0])?;
    for seg in &path[1..] {
        cur = cur.as_object()?.get(*seg)?;
    }
    Some(cur)
}

pub(crate) fn str_at(obj: &DynamicObject, path: &[&str]) -> Option<String> {
    obj_get(obj, path)?.as_str().map(str::to_owned)
}

pub(crate) fn arr_at<'a>(obj: &'a DynamicObject, path: &[&str]) -> &'a [Value] {
    static EMPTY: Vec<Value> = Vec::new();
    obj_get(obj, path)
        .and_then(|v| v.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&EMPTY)
}
