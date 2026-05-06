use k8s_openapi::api::coordination::v1::Lease;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct LeaseSpec;

impl KindSpec for LeaseSpec {
    type K = Lease;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "leases",
            group: "coordination.k8s.io",
            version: "v1",
            kind: "Lease",
            plural: "leases",
            namespaced: true,
            category: Category::Cluster,
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
                    id: "holder",
                    header: "Holder",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "lease_duration_seconds",
                    header: "Lease (s)",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "renew_time",
                    header: "Renewed",
                    kind: Some(ColumnKind::Age),
                },
                ColumnDef {
                    id: "creation_timestamp",
                    header: "Age",
                    kind: Some(ColumnKind::Age),
                },
            ],
        }
    }

    fn project(lease: &Lease) -> Value {
        let meta = &lease.metadata;
        let spec = lease.spec.as_ref();

        json!({
            "name": meta.name.clone().unwrap_or_default(),
            "namespace": meta.namespace.clone(),
            "holder": spec.and_then(|s| s.holder_identity.clone()).unwrap_or_default(),
            "lease_duration_seconds": spec.and_then(|s| s.lease_duration_seconds).unwrap_or(0),
            "renew_time": spec
                .and_then(|s| s.renew_time.as_ref())
                .map(|t| t.0.to_string()),
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

pub fn project_detail(lease: &Lease) -> Value {
    let meta = project_meta(&lease.metadata);
    let spec = lease.spec.as_ref();

    json!({
        "meta": meta,
        "holder_identity": spec.and_then(|s| s.holder_identity.clone()),
        "lease_duration_seconds": spec.and_then(|s| s.lease_duration_seconds),
        "lease_transitions": spec.and_then(|s| s.lease_transitions),
        "acquire_time": spec
            .and_then(|s| s.acquire_time.as_ref())
            .map(|t| t.0.to_string()),
        "renew_time": spec
            .and_then(|s| s.renew_time.as_ref())
            .map(|t| t.0.to_string()),
    })
}
