use k8s_openapi::api::discovery::v1::EndpointSlice;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct EndpointSliceSpec;

impl KindSpec for EndpointSliceSpec {
    type K = EndpointSlice;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "endpointslices",
            group: "discovery.k8s.io",
            version: "v1",
            kind: "EndpointSlice",
            plural: "endpointslices",
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
                    id: "address_type",
                    header: "Address Type",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "ports",
                    header: "Ports",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "endpoints",
                    header: "Endpoints",
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

    fn project(slice: &EndpointSlice) -> Value {
        let meta = &slice.metadata;
        let ports = slice
            .ports
            .as_ref()
            .map(|ps| {
                ps.iter()
                    .filter_map(|p| p.port.map(|n| n.to_string()))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        let endpoints_count = slice.endpoints.len();

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "address_type": slice.address_type.clone(),
            "ports": ports,
            "endpoints": endpoints_count,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

// Rich projection for the endpointslice detail panel. The interesting bits
// are per-endpoint: ready/serving/terminating conditions + addresses + the
// target ref (which Pod / Node backs this entry). Owning Service is read
// from the standard `kubernetes.io/service-name` label.
pub fn project_detail(slice: &EndpointSlice) -> Value {
    let meta = project_meta(&slice.metadata);
    let service_name = slice
        .metadata
        .labels
        .as_ref()
        .and_then(|m| m.get("kubernetes.io/service-name").cloned());

    let ports: Vec<Value> = slice
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
                .collect()
        })
        .unwrap_or_default();

    let endpoints: Vec<Value> = slice
        .endpoints
        .iter()
        .map(|e| {
            let target_ref = e.target_ref.as_ref().map(|r| {
                json!({
                    "kind": r.kind.clone(),
                    "namespace": r.namespace.clone(),
                    "name": r.name.clone(),
                    "uid": r.uid.clone(),
                })
            });
            let conditions = e.conditions.as_ref().map(|c| {
                json!({
                    "ready": c.ready,
                    "serving": c.serving,
                    "terminating": c.terminating,
                })
            });
            json!({
                "addresses": e.addresses.clone(),
                "conditions": conditions,
                "hostname": e.hostname.clone(),
                "node_name": e.node_name.clone(),
                "zone": e.zone.clone(),
                "target_ref": target_ref,
            })
        })
        .collect();

    json!({
        "meta": meta,
        "address_type": slice.address_type.clone(),
        "service_name": service_name,
        "ports": ports,
        "endpoints": endpoints,
    })
}
