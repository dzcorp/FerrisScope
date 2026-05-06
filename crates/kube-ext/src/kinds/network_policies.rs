use k8s_openapi::api::networking::v1::{
    NetworkPolicy, NetworkPolicyEgressRule, NetworkPolicyIngressRule, NetworkPolicyPeer,
    NetworkPolicyPort,
};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
use serde_json::{json, Value};

use crate::kinds::pod_template::{project_label_selector, project_meta};
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct NetworkPolicySpec;

impl KindSpec for NetworkPolicySpec {
    type K = NetworkPolicy;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "networkpolicies",
            group: "networking.k8s.io",
            version: "v1",
            kind: "NetworkPolicy",
            plural: "networkpolicies",
            namespaced: true,
            category: Category::Network,
            columns: vec![
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
                    id: "pod_selector",
                    header: "Pod Selector",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "ingress_rules",
                    header: "Ingress",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "egress_rules",
                    header: "Egress",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "creation_timestamp",
                    header: "Age",
                    kind: Some(ColumnKind::Age),
                },
            ],
        }
    }

    fn project(np: &NetworkPolicy) -> Value {
        let meta = &np.metadata;
        let spec = np.spec.as_ref();
        let pod_selector = spec
            .and_then(|s| s.pod_selector.as_ref())
            .and_then(|sel| sel.match_labels.as_ref())
            .map(|m| {
                m.iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .filter(|s: &String| !s.is_empty())
            .unwrap_or_else(|| "<all pods>".to_owned());
        let ingress_rules = spec
            .and_then(|s| s.ingress.as_ref())
            .map_or(0, std::vec::Vec::len);
        let egress_rules = spec
            .and_then(|s| s.egress.as_ref())
            .map_or(0, std::vec::Vec::len);

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "pod_selector": pod_selector,
            "ingress_rules": ingress_rules,
            "egress_rules": egress_rules,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

// Rich projection for the networkpolicy detail panel. The shape that matters:
// pod selector (which pods the policy targets) + policy types + per-rule
// ports and peers. A NetworkPolicy with empty ingress/egress rule arrays
// behaves as a deny-all for that direction — preserve the empty array so the
// UI can render "deny all" explicitly instead of dropping the rule list.
pub fn project_detail(np: &NetworkPolicy) -> Value {
    let meta = project_meta(&np.metadata);
    let spec = np.spec.as_ref();

    let pod_selector = spec
        .and_then(|s| s.pod_selector.as_ref())
        .map(|sel| project_label_selector(Some(sel)));
    let policy_types: Vec<String> = spec
        .and_then(|s| s.policy_types.clone())
        .unwrap_or_default();
    let ingress: Vec<Value> = spec
        .and_then(|s| s.ingress.as_ref())
        .map(|rs| rs.iter().map(ingress_rule_value).collect())
        .unwrap_or_default();
    let egress: Vec<Value> = spec
        .and_then(|s| s.egress.as_ref())
        .map(|rs| rs.iter().map(egress_rule_value).collect())
        .unwrap_or_default();

    json!({
        "meta": meta,
        "pod_selector": pod_selector,
        "policy_types": policy_types,
        "ingress": ingress,
        "egress": egress,
    })
}

fn ingress_rule_value(r: &NetworkPolicyIngressRule) -> Value {
    let ports: Vec<Value> = r
        .ports
        .as_ref()
        .map(|ps| ps.iter().map(port_value).collect())
        .unwrap_or_default();
    let from: Vec<Value> = r
        .from
        .as_ref()
        .map(|ps| ps.iter().map(peer_value).collect())
        .unwrap_or_default();
    json!({
        "ports": ports,
        "peers": from,
    })
}

fn egress_rule_value(r: &NetworkPolicyEgressRule) -> Value {
    let ports: Vec<Value> = r
        .ports
        .as_ref()
        .map(|ps| ps.iter().map(port_value).collect())
        .unwrap_or_default();
    let to: Vec<Value> =
        r.to.as_ref()
            .map(|ps| ps.iter().map(peer_value).collect())
            .unwrap_or_default();
    json!({
        "ports": ports,
        "peers": to,
    })
}

fn port_value(p: &NetworkPolicyPort) -> Value {
    let port = p.port.as_ref().map(|tp| match tp {
        k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(i) => i.to_string(),
        k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s) => s.clone(),
    });
    json!({
        "protocol": p.protocol.clone().unwrap_or_else(|| "TCP".to_owned()),
        "port": port,
        "end_port": p.end_port,
    })
}

fn peer_value(p: &NetworkPolicyPeer) -> Value {
    let ip_block = p.ip_block.as_ref().map(|b| {
        json!({
            "cidr": b.cidr.clone(),
            "except": b.except.clone().unwrap_or_default(),
        })
    });
    let namespace_selector = label_selector_summary(p.namespace_selector.as_ref());
    let pod_selector = label_selector_summary(p.pod_selector.as_ref());
    json!({
        "ip_block": ip_block,
        "namespace_selector": namespace_selector,
        "pod_selector": pod_selector,
    })
}

// Same compact shape as `project_label_selector` but always returns a value
// (Null for absent selectors). The UI distinguishes "no selector" (peer is
// just an ipBlock) from "empty selector" (matches everything) — both come
// through here verbatim so the renderer can show the right label.
fn label_selector_summary(sel: Option<&LabelSelector>) -> Value {
    match sel {
        Some(_) => project_label_selector(sel),
        None => Value::Null,
    }
}
