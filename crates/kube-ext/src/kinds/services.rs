use k8s_openapi::api::core::v1::Service;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct ServiceSpec;

impl KindSpec for ServiceSpec {
    type K = Service;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "services",
            group: "",
            version: "v1",
            kind: "Service",
            plural: "services",
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
                    id: "type",
                    header: "Type",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "cluster_ip",
                    header: "Cluster IP",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "external_ip",
                    header: "External IP",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "ports",
                    header: "Ports",
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

    fn project(svc: &Service) -> Value {
        let meta = &svc.metadata;
        let spec = svc.spec.as_ref();
        let svc_type = spec
            .and_then(|s| s.type_.clone())
            .unwrap_or_else(|| "ClusterIP".to_owned());
        let cluster_ip = spec.and_then(|s| s.cluster_ip.clone()).unwrap_or_default();
        let external_ip = format_external_ip(svc, &svc_type);
        let ports = spec
            .and_then(|s| s.ports.as_ref())
            .map(|ps| {
                ps.iter()
                    .map(|p| match (p.node_port, &p.protocol) {
                        (Some(np), Some(proto)) => format!("{}:{np}/{proto}", p.port),
                        (Some(np), None) => format!("{}:{np}/TCP", p.port),
                        (None, Some(proto)) => format!("{}/{proto}", p.port),
                        (None, None) => format!("{}/TCP", p.port),
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "type": svc_type,
            "cluster_ip": cluster_ip,
            "external_ip": external_ip,
            "ports": ports,
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

// Rich projection for the service detail panel. Surfaces every field an
// operator reads when debugging a connectivity issue: type + IPs (cluster +
// external + LB ingress), the selector that picks endpoints, the port map,
// and traffic-policy knobs.
pub fn project_detail(svc: &Service) -> Value {
    let meta = project_meta(&svc.metadata);
    let spec = svc.spec.as_ref();

    let svc_type = spec
        .and_then(|s| s.type_.clone())
        .unwrap_or_else(|| "ClusterIP".to_owned());
    let cluster_ip = spec.and_then(|s| s.cluster_ip.clone());
    let cluster_ips: Vec<String> = spec.and_then(|s| s.cluster_ips.clone()).unwrap_or_default();
    let external_ips: Vec<String> = spec
        .and_then(|s| s.external_ips.clone())
        .unwrap_or_default();
    let external_name = spec.and_then(|s| s.external_name.clone());
    let session_affinity = spec.and_then(|s| s.session_affinity.clone());
    let internal_traffic_policy = spec.and_then(|s| s.internal_traffic_policy.clone());
    let external_traffic_policy = spec.and_then(|s| s.external_traffic_policy.clone());
    let ip_families: Vec<String> = spec.and_then(|s| s.ip_families.clone()).unwrap_or_default();
    let ip_family_policy = spec.and_then(|s| s.ip_family_policy.clone());
    let load_balancer_class = spec.and_then(|s| s.load_balancer_class.clone());
    let load_balancer_source_ranges: Vec<String> = spec
        .and_then(|s| s.load_balancer_source_ranges.clone())
        .unwrap_or_default();
    let health_check_node_port = spec.and_then(|s| s.health_check_node_port);
    let publish_not_ready_addresses = spec.and_then(|s| s.publish_not_ready_addresses);
    let allocate_load_balancer_node_ports = spec.and_then(|s| s.allocate_load_balancer_node_ports);

    let selector: Vec<Value> = spec
        .and_then(|s| s.selector.as_ref())
        .map(|m| m.iter().map(|(k, v)| json!([k, v])).collect())
        .unwrap_or_default();

    let ports: Vec<Value> = spec
        .and_then(|s| s.ports.as_ref())
        .map(|ps| {
            ps.iter()
                .map(|p| {
                    let target_port = p.target_port.as_ref().map(|tp| match tp {
                        k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(i) => {
                            i.to_string()
                        }
                        k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s) => {
                            s.clone()
                        }
                    });
                    json!({
                        "name": p.name.clone(),
                        "port": p.port,
                        "target_port": target_port,
                        "node_port": p.node_port,
                        "protocol": p.protocol.clone().unwrap_or_else(|| "TCP".to_owned()),
                        "app_protocol": p.app_protocol.clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let lb_ingress: Vec<Value> = svc
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
        "type": svc_type,
        "cluster_ip": cluster_ip,
        "cluster_ips": cluster_ips,
        "external_ips": external_ips,
        "external_name": external_name,
        "session_affinity": session_affinity,
        "internal_traffic_policy": internal_traffic_policy,
        "external_traffic_policy": external_traffic_policy,
        "ip_families": ip_families,
        "ip_family_policy": ip_family_policy,
        "load_balancer_class": load_balancer_class,
        "load_balancer_source_ranges": load_balancer_source_ranges,
        "health_check_node_port": health_check_node_port,
        "publish_not_ready_addresses": publish_not_ready_addresses,
        "allocate_load_balancer_node_ports": allocate_load_balancer_node_ports,
        "selector": selector,
        "ports": ports,
        "load_balancer_ingress": lb_ingress,
    })
}

// What `kubectl get svc` puts in the EXTERNAL-IP column. The rules vary
// by Service type — for LoadBalancer the address lives in status, for
// ExternalName the spec carries the DNS target, and ClusterIP / NodePort
// only have an external IP if the operator set spec.externalIPs by hand.
// This helper centralises the dispatch so the row stays consistent with
// kubectl's output.
fn format_external_ip(svc: &Service, svc_type: &str) -> String {
    let spec = svc.spec.as_ref();
    let static_external: Vec<String> = spec
        .and_then(|s| s.external_ips.clone())
        .unwrap_or_default();

    if svc_type == "ExternalName" {
        return spec
            .and_then(|s| s.external_name.clone())
            .unwrap_or_else(|| "—".to_owned());
    }

    if svc_type == "LoadBalancer" {
        let ingress: Vec<String> = svc
            .status
            .as_ref()
            .and_then(|s| s.load_balancer.as_ref())
            .and_then(|lb| lb.ingress.as_ref())
            .map(|ings| {
                ings.iter()
                    .filter_map(|i| {
                        // Prefer hostname when present (cloud LBs often
                        // return both); fall back to the raw IP. Empty
                        // strings happen during provisioning — drop them
                        // so we don't show a bare comma.
                        i.hostname
                            .clone()
                            .filter(|s| !s.is_empty())
                            .or_else(|| i.ip.clone().filter(|s| !s.is_empty()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut combined = ingress;
        combined.extend(static_external.iter().cloned());
        if combined.is_empty() {
            return "<pending>".to_owned();
        }
        return combined.join(",");
    }

    // ClusterIP / NodePort: only show externalIPs if the operator pinned
    // them. Otherwise an em dash matches what we render for any other
    // empty cell.
    if static_external.is_empty() {
        "—".to_owned()
    } else {
        static_external.join(",")
    }
}
