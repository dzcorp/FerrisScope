use k8s_openapi::api::networking::v1::{Ingress, IngressBackend};
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct IngressSpec;

impl KindSpec for IngressSpec {
    type K = Ingress;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "ingresses",
            group: "networking.k8s.io",
            version: "v1",
            kind: "Ingress",
            plural: "ingresses",
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
                    id: "class",
                    header: "Class",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "hosts",
                    header: "Hosts",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "address",
                    header: "Address",
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

    fn project(ing: &Ingress) -> Value {
        let meta = &ing.metadata;
        let spec = ing.spec.as_ref();
        let class = spec
            .and_then(|s| s.ingress_class_name.clone())
            .unwrap_or_else(|| "—".to_owned());
        let hosts = spec
            .and_then(|s| s.rules.as_ref())
            .map(|rs| {
                rs.iter()
                    .filter_map(|r| r.host.clone())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        let address = ing
            .status
            .as_ref()
            .and_then(|s| s.load_balancer.as_ref())
            .and_then(|lb| lb.ingress.as_ref())
            .map(|ings| {
                ings.iter()
                    .filter_map(|i| i.hostname.clone().or_else(|| i.ip.clone()))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "class": class,
            "hosts": hosts,
            "address": address,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

// Rich projection for the ingress detail panel. The shape that matters:
// class + tls + rules (host → list of (path, pathType, backend service)) +
// the LB address(es) the controller has assigned. Default backend is rare
// in practice but shown when present.
pub fn project_detail(ing: &Ingress) -> Value {
    let meta = project_meta(&ing.metadata);
    let spec = ing.spec.as_ref();

    let class = spec.and_then(|s| s.ingress_class_name.clone());
    let default_backend = spec
        .and_then(|s| s.default_backend.as_ref())
        .map(backend_value);
    let tls: Vec<Value> = spec
        .and_then(|s| s.tls.as_ref())
        .map(|ts| {
            ts.iter()
                .map(|t| {
                    json!({
                        "hosts": t.hosts.clone().unwrap_or_default(),
                        "secret_name": t.secret_name.clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let rules: Vec<Value> = spec
        .and_then(|s| s.rules.as_ref())
        .map(|rs| {
            rs.iter()
                .map(|r| {
                    let paths: Vec<Value> = r
                        .http
                        .as_ref()
                        .map(|h| {
                            h.paths
                                .iter()
                                .map(|p| {
                                    json!({
                                        "path": p.path.clone(),
                                        "path_type": p.path_type.clone(),
                                        "backend": backend_value(&p.backend),
                                    })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    json!({
                        "host": r.host.clone(),
                        "paths": paths,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let lb_ingress: Vec<Value> = ing
        .status
        .as_ref()
        .and_then(|s| s.load_balancer.as_ref())
        .and_then(|lb| lb.ingress.as_ref())
        .map(|ings| {
            ings.iter()
                .map(|i| {
                    let ports = i.ports.as_ref().map(|ps| {
                        ps.iter()
                            .map(|p| {
                                json!({
                                    "port": p.port,
                                    "protocol": p.protocol.clone(),
                                    "error": p.error.clone(),
                                })
                            })
                            .collect::<Vec<Value>>()
                    });
                    json!({
                        "ip": i.ip.clone(),
                        "hostname": i.hostname.clone(),
                        "ports": ports.unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    json!({
        "meta": meta,
        "ingress_class_name": class,
        "default_backend": default_backend,
        "tls": tls,
        "rules": rules,
        "load_balancer_ingress": lb_ingress,
    })
}

fn backend_value(b: &IngressBackend) -> Value {
    let service = b.service.as_ref().map(|s| {
        let port_name = s.port.as_ref().and_then(|p| p.name.clone());
        let port_number = s.port.as_ref().and_then(|p| p.number);
        json!({
            "name": s.name.clone(),
            "port_name": port_name,
            "port_number": port_number,
        })
    });
    let resource = b.resource.as_ref().map(|r| {
        json!({
            "api_group": r.api_group.clone(),
            "kind": r.kind.clone(),
            "name": r.name.clone(),
        })
    });
    json!({
        "service": service,
        "resource": resource,
    })
}
