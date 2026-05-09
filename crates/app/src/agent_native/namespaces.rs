//! `fs_namespaces_list` — list every namespace with phase + age.

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use k8s_openapi::api::core::v1::Namespace;
use kube::api::{Api, ListParams};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent_native::ChatClusterRef;
use crate::state::AppState;

pub(crate) struct NamespacesList {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl NamespacesList {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for NamespacesList {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_namespaces_list".to_string(),
            description: "List every namespace in the cluster with phase (Active / Terminating), \
                creation timestamp, and labels. Use this to discover where workloads live before \
                running scoped queries."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, _args: Value) -> Result<Value, NativeToolError> {
        let cluster_id = self.cluster.active().await;
        let state = self.app.state::<AppState>();
        let entry = state
            .entry(&cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let api: Api<Namespace> = Api::all(entry.cluster.client());
        let list = api
            .list(&ListParams::default())
            .await
            .map_err(|e| NativeToolError::msg(e.to_string()))?;
        let items: Vec<Value> = list
            .items
            .iter()
            .map(|ns| {
                json!({
                    "name": ns.metadata.name.clone().unwrap_or_default(),
                    "phase": ns
                        .status
                        .as_ref()
                        .and_then(|s| s.phase.clone())
                        .unwrap_or_default(),
                    "created": ns
                        .metadata
                        .creation_timestamp
                        .as_ref()
                        .map(|t| t.0.to_string()),
                    "labels": ns.metadata.labels.clone().unwrap_or_default(),
                })
            })
            .collect();
        Ok(json!({ "count": items.len(), "namespaces": items }))
    }
}
