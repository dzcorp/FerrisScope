//! Gateway API overrides (`gateway.networking.k8s.io`).
//!
//! Five kinds promoted to first-class for the rail's Network category:
//! GatewayClass, Gateway, HTTPRoute, GRPCRoute, ReferenceGrant. Routing
//! the watcher itself stays generic (`DynamicObject`) — what we add here
//! is a column projection + a richer detail shape so the panel doesn't
//! collapse to "open YAML".

use kube::api::DynamicObject;
use serde_json::{json, Value};

use crate::registry::{Category, ColumnDef, ColumnKind};
use crate::well_known::{arr_at, dyn_meta_value, obj_get, str_at, WellKnownCrd};

pub static OVERRIDES: &[WellKnownCrd] = &[
    WellKnownCrd {
        short_id: "gatewayclasses",
        group: "gateway.networking.k8s.io",
        kind: "GatewayClass",
        category: Category::Network,
        columns: gatewayclass_columns,
        project: project_gatewayclass,
        project_detail: detail_gatewayclass,
    },
    WellKnownCrd {
        short_id: "gateways",
        group: "gateway.networking.k8s.io",
        kind: "Gateway",
        category: Category::Network,
        columns: gateway_columns,
        project: project_gateway,
        project_detail: detail_gateway,
    },
    WellKnownCrd {
        short_id: "httproutes",
        group: "gateway.networking.k8s.io",
        kind: "HTTPRoute",
        category: Category::Network,
        columns: route_columns,
        project: project_httproute,
        project_detail: detail_route,
    },
    WellKnownCrd {
        short_id: "grpcroutes",
        group: "gateway.networking.k8s.io",
        kind: "GRPCRoute",
        category: Category::Network,
        columns: route_columns,
        project: project_grpcroute,
        project_detail: detail_route,
    },
    WellKnownCrd {
        short_id: "referencegrants",
        group: "gateway.networking.k8s.io",
        kind: "ReferenceGrant",
        category: Category::Network,
        columns: refgrant_columns,
        project: project_refgrant,
        project_detail: detail_refgrant,
    },
];

// ── Columns ────────────────────────────────────────────────────────────────

fn gatewayclass_columns() -> Vec<ColumnDef> {
    vec![
        ColumnDef {
            id: "name",
            header: "Name",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "controller",
            header: "Controller",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "accepted",
            header: "Accepted",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "creation_timestamp",
            header: "Age",
            kind: Some(ColumnKind::Age),
        },
    ]
}

fn gateway_columns() -> Vec<ColumnDef> {
    vec![
        ColumnDef {
            id: "name",
            header: "Name",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "namespace",
            header: "Namespace",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "class",
            header: "Class",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "addresses",
            header: "Address",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "listeners",
            header: "Listeners",
            kind: Some(ColumnKind::Number),
        },
        ColumnDef {
            id: "programmed",
            header: "Programmed",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "creation_timestamp",
            header: "Age",
            kind: Some(ColumnKind::Age),
        },
    ]
}

fn route_columns() -> Vec<ColumnDef> {
    vec![
        ColumnDef {
            id: "name",
            header: "Name",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "namespace",
            header: "Namespace",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "hostnames",
            header: "Hostnames",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "parents",
            header: "Parents",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "rules",
            header: "Rules",
            kind: Some(ColumnKind::Number),
        },
        ColumnDef {
            id: "creation_timestamp",
            header: "Age",
            kind: Some(ColumnKind::Age),
        },
    ]
}

fn refgrant_columns() -> Vec<ColumnDef> {
    vec![
        ColumnDef {
            id: "name",
            header: "Name",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "namespace",
            header: "Namespace",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "from",
            header: "From",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "to",
            header: "To",
            kind: Some(ColumnKind::Text),
        },
        ColumnDef {
            id: "creation_timestamp",
            header: "Age",
            kind: Some(ColumnKind::Age),
        },
    ]
}

// ── Row projections ────────────────────────────────────────────────────────

fn project_gatewayclass(obj: &DynamicObject) -> Value {
    let m = &obj.metadata;
    let controller = str_at(obj, &["spec", "controllerName"]).unwrap_or_default();
    let accepted = condition_status(obj, "Accepted").unwrap_or_else(|| "Unknown".to_owned());
    json!({
        "name": m.name.clone().unwrap_or_default(),
        "namespace": null,
        "controller": controller,
        "accepted": accepted,
        "creation_timestamp": m.creation_timestamp.as_ref().map(|t| t.0.to_string()),
    })
}

fn project_gateway(obj: &DynamicObject) -> Value {
    let m = &obj.metadata;
    let class = str_at(obj, &["spec", "gatewayClassName"]).unwrap_or_default();
    let listeners = arr_at(obj, &["spec", "listeners"]).len();
    let addresses = collect_addresses(obj).join(",");
    let programmed = condition_status(obj, "Programmed").unwrap_or_else(|| "Unknown".to_owned());
    json!({
        "name": m.name.clone().unwrap_or_default(),
        "namespace": m.namespace.clone(),
        "class": class,
        "addresses": if addresses.is_empty() { "—".to_owned() } else { addresses },
        "listeners": listeners,
        "programmed": programmed,
        "creation_timestamp": m.creation_timestamp.as_ref().map(|t| t.0.to_string()),
    })
}

fn project_httproute(obj: &DynamicObject) -> Value {
    project_route_inner(obj)
}

fn project_grpcroute(obj: &DynamicObject) -> Value {
    project_route_inner(obj)
}

fn project_route_inner(obj: &DynamicObject) -> Value {
    let m = &obj.metadata;
    let hostnames: Vec<String> = arr_at(obj, &["spec", "hostnames"])
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    let parents: Vec<String> = arr_at(obj, &["spec", "parentRefs"])
        .iter()
        .filter_map(parent_ref_summary)
        .collect();
    let rules = arr_at(obj, &["spec", "rules"]).len();
    json!({
        "name": m.name.clone().unwrap_or_default(),
        "namespace": m.namespace.clone(),
        "hostnames": if hostnames.is_empty() { "—".to_owned() } else { hostnames.join(",") },
        "parents": if parents.is_empty() { "—".to_owned() } else { parents.join(",") },
        "rules": rules,
        "creation_timestamp": m.creation_timestamp.as_ref().map(|t| t.0.to_string()),
    })
}

fn project_refgrant(obj: &DynamicObject) -> Value {
    let m = &obj.metadata;
    let from: Vec<String> = arr_at(obj, &["spec", "from"])
        .iter()
        .filter_map(|v| {
            let g = v.get("group")?.as_str().unwrap_or("");
            let k = v.get("kind")?.as_str()?;
            let ns = v.get("namespace")?.as_str()?;
            Some(format!(
                "{ns}/{}{}",
                k,
                if g.is_empty() {
                    String::new()
                } else {
                    format!(".{g}")
                }
            ))
        })
        .collect();
    let to: Vec<String> = arr_at(obj, &["spec", "to"])
        .iter()
        .filter_map(|v| {
            let g = v.get("group")?.as_str().unwrap_or("");
            let k = v.get("kind")?.as_str()?;
            let n = v.get("name").and_then(Value::as_str).unwrap_or("*");
            Some(format!(
                "{}{} ({})",
                k,
                if g.is_empty() {
                    String::new()
                } else {
                    format!(".{g}")
                },
                n
            ))
        })
        .collect();
    json!({
        "name": m.name.clone().unwrap_or_default(),
        "namespace": m.namespace.clone(),
        "from": if from.is_empty() { "—".to_owned() } else { from.join(",") },
        "to": if to.is_empty() { "—".to_owned() } else { to.join(",") },
        "creation_timestamp": m.creation_timestamp.as_ref().map(|t| t.0.to_string()),
    })
}

// ── Detail projections ─────────────────────────────────────────────────────

fn detail_gatewayclass(obj: &DynamicObject) -> Value {
    json!({
        "meta": dyn_meta_value(obj),
        "controller": str_at(obj, &["spec", "controllerName"]),
        "description": str_at(obj, &["spec", "description"]),
        "parameters_ref": obj_get(obj, &["spec", "parametersRef"]).cloned(),
        "conditions": collect_conditions(obj, &["status", "conditions"]),
    })
}

fn detail_gateway(obj: &DynamicObject) -> Value {
    let listeners: Vec<Value> = arr_at(obj, &["spec", "listeners"])
        .iter()
        .map(|l| {
            json!({
                "name": l.get("name").and_then(Value::as_str),
                "protocol": l.get("protocol").and_then(Value::as_str),
                "port": l.get("port").and_then(Value::as_i64),
                "hostname": l.get("hostname").and_then(Value::as_str),
                "tls_mode": l.get("tls").and_then(|v| v.get("mode")).and_then(Value::as_str),
                "allowed_routes": l.get("allowedRoutes").cloned(),
            })
        })
        .collect();
    let addresses: Vec<Value> = arr_at(obj, &["status", "addresses"])
        .iter()
        .map(|a| {
            json!({
                "type": a.get("type").and_then(Value::as_str),
                "value": a.get("value").and_then(Value::as_str),
            })
        })
        .collect();
    let listener_status: Vec<Value> = arr_at(obj, &["status", "listeners"])
        .iter()
        .map(|l| {
            json!({
                "name": l.get("name").and_then(Value::as_str),
                "attached_routes": l.get("attachedRoutes").and_then(Value::as_i64),
                "conditions": l.get("conditions").cloned().unwrap_or(Value::Array(vec![])),
            })
        })
        .collect();
    json!({
        "meta": dyn_meta_value(obj),
        "gateway_class_name": str_at(obj, &["spec", "gatewayClassName"]),
        "listeners": listeners,
        "addresses": addresses,
        "listener_status": listener_status,
        "conditions": collect_conditions(obj, &["status", "conditions"]),
    })
}

fn detail_route(obj: &DynamicObject) -> Value {
    let hostnames: Vec<String> = arr_at(obj, &["spec", "hostnames"])
        .iter()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    let parents: Vec<Value> = arr_at(obj, &["spec", "parentRefs"])
        .iter()
        .map(|p| {
            json!({
                "group": p.get("group").and_then(Value::as_str),
                "kind": p.get("kind").and_then(Value::as_str),
                "namespace": p.get("namespace").and_then(Value::as_str),
                "name": p.get("name").and_then(Value::as_str),
                "section_name": p.get("sectionName").and_then(Value::as_str),
                "port": p.get("port").and_then(Value::as_i64),
            })
        })
        .collect();
    let rules: Vec<Value> = arr_at(obj, &["spec", "rules"])
        .iter()
        .map(|r| {
            let matches = r
                .get("matches")
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let backends = r
                .get("backendRefs")
                .and_then(Value::as_array)
                .map(|bs| {
                    bs.iter()
                        .filter_map(|b| {
                            let name = b.get("name")?.as_str()?;
                            let port = b.get("port").and_then(Value::as_i64);
                            let weight = b.get("weight").and_then(Value::as_i64);
                            Some(json!({
                                "name": name,
                                "namespace": b.get("namespace").and_then(Value::as_str),
                                "port": port,
                                "weight": weight,
                            }))
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let filters = r
                .get("filters")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            json!({
                "matches": matches,
                "backends": backends,
                "filters": filters,
            })
        })
        .collect();
    let parent_status: Vec<Value> = arr_at(obj, &["status", "parents"])
        .iter()
        .map(|p| {
            json!({
                "controller": p.get("controllerName").and_then(Value::as_str),
                "parent": p.get("parentRef").cloned(),
                "conditions": p.get("conditions").cloned().unwrap_or(Value::Array(vec![])),
            })
        })
        .collect();
    json!({
        "meta": dyn_meta_value(obj),
        "hostnames": hostnames,
        "parent_refs": parents,
        "rules": rules,
        "parent_status": parent_status,
    })
}

fn detail_refgrant(obj: &DynamicObject) -> Value {
    let from: Vec<Value> = arr_at(obj, &["spec", "from"])
        .iter()
        .map(|v| {
            json!({
                "group": v.get("group").and_then(Value::as_str),
                "kind": v.get("kind").and_then(Value::as_str),
                "namespace": v.get("namespace").and_then(Value::as_str),
            })
        })
        .collect();
    let to: Vec<Value> = arr_at(obj, &["spec", "to"])
        .iter()
        .map(|v| {
            json!({
                "group": v.get("group").and_then(Value::as_str),
                "kind": v.get("kind").and_then(Value::as_str),
                "name": v.get("name").and_then(Value::as_str),
            })
        })
        .collect();
    json!({
        "meta": dyn_meta_value(obj),
        "from": from,
        "to": to,
    })
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn condition_status(obj: &DynamicObject, type_: &str) -> Option<String> {
    arr_at(obj, &["status", "conditions"])
        .iter()
        .find(|c| c.get("type").and_then(Value::as_str) == Some(type_))
        .and_then(|c| c.get("status").and_then(Value::as_str))
        .map(str::to_owned)
}

fn collect_conditions(obj: &DynamicObject, path: &[&str]) -> Vec<Value> {
    arr_at(obj, path)
        .iter()
        .map(|c| {
            json!({
                "type": c.get("type").and_then(Value::as_str),
                "status": c.get("status").and_then(Value::as_str),
                "reason": c.get("reason").and_then(Value::as_str),
                "message": c.get("message").and_then(Value::as_str),
                "last_transition_time": c.get("lastTransitionTime").and_then(Value::as_str),
            })
        })
        .collect()
}

fn collect_addresses(obj: &DynamicObject) -> Vec<String> {
    arr_at(obj, &["status", "addresses"])
        .iter()
        .filter_map(|a| a.get("value").and_then(Value::as_str).map(str::to_owned))
        .collect()
}

fn parent_ref_summary(p: &Value) -> Option<String> {
    let kind = p.get("kind").and_then(Value::as_str).unwrap_or("Gateway");
    let name = p.get("name").and_then(Value::as_str)?;
    let ns = p.get("namespace").and_then(Value::as_str);
    let section = p.get("sectionName").and_then(Value::as_str);
    let mut s = match ns {
        Some(n) => format!("{kind}/{n}/{name}"),
        None => format!("{kind}/{name}"),
    };
    if let Some(sn) = section {
        s.push(':');
        s.push_str(sn);
    }
    Some(s)
}
