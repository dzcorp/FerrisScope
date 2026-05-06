//! `fs_metrics_pod` and `fs_metrics_node` — point-in-time CPU/mem from
//! metrics-server, plus the kubelet `/stats/summary` slice (filesystem,
//! network, ephemeral) for nodes.
//!
//! Both routes through the apiserver — we never go directly to kubelet — so
//! they reuse the operator's kubeconfig auth and don't require any extra
//! reachability. Calls fail with a clear message when metrics-server isn't
//! installed (404 on `/apis/metrics.k8s.io/v1beta1`).

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use http::Request;
use k8s_openapi::api::core::v1::Node;
use kube::api::{Api, DynamicObject};
use kube::core::{ApiResource, GroupVersionKind};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

#[derive(Debug, Deserialize)]
struct PodArgs {
    namespace: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct NodeArgs {
    name: String,
    #[serde(default)]
    include_stats_summary: bool,
}

pub(crate) struct MetricsPod {
    app: AppHandle,
    cluster_id: String,
}

impl MetricsPod {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for MetricsPod {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_metrics_pod".to_string(),
            description:
                "Point-in-time CPU + memory usage for one pod, broken down per-container. Source: \
                metrics-server (`metrics.k8s.io/v1beta1/PodMetrics`). Returns null when the \
                metrics-server addon is not installed."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string" },
                    "name": { "type": "string" }
                },
                "required": ["namespace", "name"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: PodArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let state = self.app.state::<AppState>();
        let entry = state
            .entry(&self.cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let client = entry.cluster.client();

        let ar = ApiResource::from_gvk_with_plural(
            &GroupVersionKind {
                group: "metrics.k8s.io".into(),
                version: "v1beta1".into(),
                kind: "PodMetrics".into(),
            },
            "pods",
        );
        let api: Api<DynamicObject> = Api::namespaced_with(client, &a.namespace, &ar);
        match api.get(&a.name).await {
            Ok(obj) => Ok(json!({
                "namespace": a.namespace,
                "name": a.name,
                "timestamp": obj.data.get("timestamp"),
                "window": obj.data.get("window"),
                "containers": obj.data.get("containers"),
            })),
            Err(kube::Error::Api(e)) if e.code == 404 => Ok(json!({
                "namespace": a.namespace,
                "name": a.name,
                "available": false,
                "message": "metrics-server returned 404 — either it isn't installed or it has no \
                            recent sample for this pod (give it ~30s after pod start)",
            })),
            Err(e) => Err(NativeToolError::msg(e.to_string())),
        }
    }
}

pub(crate) struct MetricsNode {
    app: AppHandle,
    cluster_id: String,
}

impl MetricsNode {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for MetricsNode {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_metrics_node".to_string(),
            description:
                "Point-in-time CPU + memory usage for one node, plus capacity / allocatable from \
                the Node object. Source: metrics-server. Set `include_stats_summary: true` to \
                also pull the kubelet `/stats/summary` slice (filesystem, network, ephemeral) — \
                that endpoint is apiserver-proxied to the node, slower, and depends on \
                `nodes/proxy` RBAC."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Node name." },
                    "include_stats_summary": {
                        "type": "boolean",
                        "default": false,
                        "description": "Also pull kubelet /stats/summary."
                    }
                },
                "required": ["name"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: NodeArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let state = self.app.state::<AppState>();
        let entry = state
            .entry(&self.cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let client = entry.cluster.client();

        let ar = ApiResource::from_gvk_with_plural(
            &GroupVersionKind {
                group: "metrics.k8s.io".into(),
                version: "v1beta1".into(),
                kind: "NodeMetrics".into(),
            },
            "nodes",
        );
        let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
        let metrics_value = match api.get(&a.name).await {
            Ok(obj) => json!({
                "available": true,
                "timestamp": obj.data.get("timestamp"),
                "window": obj.data.get("window"),
                "usage": obj.data.get("usage"),
            }),
            Err(kube::Error::Api(e)) if e.code == 404 => json!({
                "available": false,
                "message": "metrics-server not installed or no recent sample for this node",
            }),
            Err(e) => return Err(NativeToolError::msg(e.to_string())),
        };

        // Capacity / allocatable from the core Node so a single tool call
        // gives the agent everything it needs to compute "how full is this
        // node" without a follow-up.
        let nodes: Api<Node> = Api::all(client.clone());
        let (capacity, allocatable) = match nodes.get(&a.name).await {
            Ok(n) => {
                let s = n.status.unwrap_or_default();
                (
                    s.capacity.map(quant_to_value).unwrap_or(Value::Null),
                    s.allocatable.map(quant_to_value).unwrap_or(Value::Null),
                )
            }
            Err(_) => (Value::Null, Value::Null),
        };

        let mut out = json!({
            "name": a.name,
            "metrics": metrics_value,
            "capacity": capacity,
            "allocatable": allocatable,
        });

        if a.include_stats_summary {
            let summary = fetch_stats_summary(&client, &a.name).await;
            if let Value::Object(ref mut m) = out {
                m.insert("stats_summary".into(), summary);
            }
        }

        Ok(out)
    }
}

fn quant_to_value(
    m: std::collections::BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>,
) -> Value {
    let mut out = serde_json::Map::new();
    for (k, v) in m {
        out.insert(k, Value::String(v.0));
    }
    Value::Object(out)
}

async fn fetch_stats_summary(client: &kube::Client, node: &str) -> Value {
    let path = format!("/api/v1/nodes/{node}/proxy/stats/summary");
    let req = match Request::builder()
        .method("GET")
        .uri(&path)
        .header("accept", "application/json")
        .body(Vec::new())
    {
        Ok(r) => r,
        Err(e) => return json!({ "error": e.to_string() }),
    };
    let result: Result<Value, kube::Error> = client.request(req).await;
    match result {
        Ok(v) => v,
        Err(e) => json!({ "error": e.to_string() }),
    }
}
