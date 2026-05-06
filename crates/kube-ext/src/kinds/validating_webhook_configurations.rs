use k8s_openapi::api::admissionregistration::v1::{
    ValidatingWebhook, ValidatingWebhookConfiguration,
};
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct ValidatingWebhookConfigurationSpec;

impl KindSpec for ValidatingWebhookConfigurationSpec {
    type K = ValidatingWebhookConfiguration;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "validatingwebhookconfigurations",
            group: "admissionregistration.k8s.io",
            version: "v1",
            kind: "ValidatingWebhookConfiguration",
            plural: "validatingwebhookconfigurations",
            namespaced: false,
            category: Category::Config,
            columns: vec![
                ColumnDef {
                    id: "name",
                    header: "Name",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "webhooks",
                    header: "Webhooks",
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

    fn project(vwc: &ValidatingWebhookConfiguration) -> Value {
        let meta = &vwc.metadata;
        json!({
            "name": meta.name.clone().unwrap_or_default(),
            "webhooks": vwc.webhooks.as_ref().map_or(0, Vec::len),
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        })
    }
}

pub fn project_detail(vwc: &ValidatingWebhookConfiguration) -> Value {
    let meta = project_meta(&vwc.metadata);
    let webhooks: Vec<Value> = vwc
        .webhooks
        .as_ref()
        .map(|ws| ws.iter().map(project_validating_webhook).collect())
        .unwrap_or_default();

    json!({
        "meta": meta,
        "webhooks": webhooks,
    })
}

fn project_validating_webhook(w: &ValidatingWebhook) -> Value {
    let svc = w.client_config.service.as_ref().map(|s| {
        json!({
            "name": s.name.clone(),
            "namespace": s.namespace.clone(),
            "path": s.path.clone(),
            "port": s.port,
        })
    });
    let rules: Vec<Value> = w
        .rules
        .as_ref()
        .map(|rs| {
            rs.iter()
                .map(|r| {
                    json!({
                        "api_groups": r.api_groups.clone().unwrap_or_default(),
                        "api_versions": r.api_versions.clone().unwrap_or_default(),
                        "resources": r.resources.clone().unwrap_or_default(),
                        "operations": r.operations.clone().unwrap_or_default(),
                        "scope": r.scope.clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    json!({
        "name": w.name.clone(),
        "client_config": {
            "service": svc,
            "url": w.client_config.url.clone(),
            "ca_bundle_present": w.client_config.ca_bundle.is_some(),
        },
        "rules": rules,
        "failure_policy": w.failure_policy.clone(),
        "match_policy": w.match_policy.clone(),
        "side_effects": w.side_effects.clone(),
        "timeout_seconds": w.timeout_seconds,
        "admission_review_versions": w.admission_review_versions.clone(),
    })
}
