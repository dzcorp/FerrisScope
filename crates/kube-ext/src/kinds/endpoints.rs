use k8s_openapi::api::core::v1::Endpoints;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct EndpointsSpec;

impl KindSpec for EndpointsSpec {
    type K = Endpoints;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "endpoints",
            group: "",
            version: "v1",
            kind: "Endpoints",
            plural: "endpoints",
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
                    id: "endpoints",
                    header: "Endpoints",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "creation_timestamp",
                    header: "Age",
                    kind: Some(ColumnKind::Age),
                },
            ],
        }
    }

    fn project(ep: &Endpoints) -> Value {
        let meta = &ep.metadata;
        let endpoints = ep
            .subsets
            .as_ref()
            .map(|subsets| {
                subsets
                    .iter()
                    .flat_map(|s| {
                        let addrs = s
                            .addresses
                            .as_ref()
                            .map(|a| a.iter().map(|addr| addr.ip.clone()).collect::<Vec<_>>());
                        let ports = s.ports.as_ref().map(|p| {
                            p.iter()
                                .map(|port| port.port.to_string())
                                .collect::<Vec<_>>()
                        });
                        match (addrs, ports) {
                            (Some(a), Some(p)) => a
                                .into_iter()
                                .flat_map(|ip| {
                                    p.iter()
                                        .map(move |pt| format!("{ip}:{pt}"))
                                        .collect::<Vec<_>>()
                                })
                                .collect::<Vec<_>>(),
                            (Some(a), None) => a,
                            _ => Vec::new(),
                        }
                    })
                    .take(8)
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_else(|| "<none>".to_owned());

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "endpoints": endpoints,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

// Rich projection for the endpoints detail panel. Each subset is a
// (addresses + notReadyAddresses + ports) tuple — surface them as-is so the
// operator can read which pod backs which port and whether the kubelet has
// marked it ready.
pub fn project_detail(ep: &Endpoints) -> Value {
    let meta = project_meta(&ep.metadata);
    let subsets: Vec<Value> = ep
        .subsets
        .as_ref()
        .map(|subsets| subsets.iter().map(subset_value).collect())
        .unwrap_or_default();

    json!({
        "meta": meta,
        "subsets": subsets,
    })
}

fn subset_value(s: &k8s_openapi::api::core::v1::EndpointSubset) -> Value {
    let addresses = s
        .addresses
        .as_ref()
        .map(|addrs| addrs.iter().map(address_value).collect::<Vec<Value>>())
        .unwrap_or_default();
    let not_ready_addresses = s
        .not_ready_addresses
        .as_ref()
        .map(|addrs| addrs.iter().map(address_value).collect::<Vec<Value>>())
        .unwrap_or_default();
    let ports = s
        .ports
        .as_ref()
        .map(|ps| {
            ps.iter()
                .map(|p| {
                    json!({
                        "name": p.name.clone(),
                        "port": p.port,
                        "protocol": p.protocol.clone().unwrap_or_else(|| "TCP".to_owned()),
                        "app_protocol": p.app_protocol.clone(),
                    })
                })
                .collect::<Vec<Value>>()
        })
        .unwrap_or_default();

    json!({
        "addresses": addresses,
        "not_ready_addresses": not_ready_addresses,
        "ports": ports,
    })
}

fn address_value(a: &k8s_openapi::api::core::v1::EndpointAddress) -> Value {
    let target_ref = a.target_ref.as_ref().map(|r| {
        json!({
            "kind": r.kind.clone(),
            "namespace": r.namespace.clone(),
            "name": r.name.clone(),
            "uid": r.uid.clone(),
        })
    });
    json!({
        "ip": a.ip.clone(),
        "hostname": a.hostname.clone(),
        "node_name": a.node_name.clone(),
        "target_ref": target_ref,
    })
}
