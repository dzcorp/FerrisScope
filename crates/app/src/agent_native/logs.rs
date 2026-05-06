//! `fs_logs_tail` — one-shot pod log tail (no follow).
//!
//! Intentionally separate from the operator-facing live log streaming path
//! (`crates/core/src/logs.rs`): the agent rarely needs an open subscription,
//! it just wants "the last N lines from this pod" or "last N seconds across
//! these matching pods" and a bounded result. Caps total bytes per call so
//! the LLM transcript stays readable.

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use futures::future::join_all;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams, LogParams};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

const DEFAULT_TAIL_LINES: i64 = 200;
const MAX_TAIL_LINES: i64 = 5_000;
const MAX_TOTAL_BYTES: usize = 256 * 1024;
const MAX_PODS_PER_SELECTOR: usize = 10;

#[derive(Debug, Deserialize)]
struct Args {
    namespace: String,
    /// Either a single pod name OR a label selector (mutually exclusive).
    #[serde(default)]
    pod: Option<String>,
    #[serde(default)]
    label_selector: Option<String>,
    #[serde(default)]
    container: Option<String>,
    #[serde(default)]
    tail_lines: Option<i64>,
    #[serde(default)]
    since_seconds: Option<i64>,
    #[serde(default)]
    previous: bool,
}

pub(crate) struct LogsTail {
    app: AppHandle,
    cluster_id: String,
}

impl LogsTail {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for LogsTail {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_logs_tail".to_string(),
            description: "One-shot pod log tail (no follow). Pass `pod` for a single pod, or \
                `label_selector` to fan out across matching pods (capped at 10). Returns the most \
                recent lines bounded by `tail_lines` (default 200, max 5000) AND a total-bytes \
                cap of 256 KiB across all pods. Set `previous: true` to read logs from the \
                previously-terminated container instance (useful right after a crash)."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string" },
                    "pod": { "type": "string", "description": "Single pod name." },
                    "label_selector": {
                        "type": "string",
                        "description": "Kubernetes label selector, e.g. `app=foo,tier=web`."
                    },
                    "container": { "type": "string", "description": "Container name (defaults to first)." },
                    "tail_lines": { "type": "integer", "minimum": 1, "maximum": 5000, "default": 200 },
                    "since_seconds": { "type": "integer", "minimum": 1 },
                    "previous": { "type": "boolean", "default": false }
                },
                "required": ["namespace"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: Args = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        if a.pod.is_some() == a.label_selector.is_some() {
            return Err(NativeToolError::msg(
                "specify exactly one of `pod` or `label_selector`",
            ));
        }
        let state = self.app.state::<AppState>();
        let entry = state
            .entry(&self.cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let client = entry.cluster.client();
        let pods_api: Api<Pod> = Api::namespaced(client, &a.namespace);

        let pod_names: Vec<String> = if let Some(name) = a.pod.clone() {
            vec![name]
        } else {
            let lp = ListParams::default().labels(a.label_selector.as_deref().unwrap_or(""));
            let list = pods_api.list(&lp).await.map_err(kube_err)?;
            list.items
                .into_iter()
                .filter_map(|p| p.metadata.name)
                .take(MAX_PODS_PER_SELECTOR)
                .collect()
        };
        if pod_names.is_empty() {
            return Ok(json!({ "namespace": a.namespace, "pods": [], "truncated": false }));
        }

        let tail = a
            .tail_lines
            .unwrap_or(DEFAULT_TAIL_LINES)
            .clamp(1, MAX_TAIL_LINES);
        let lp = LogParams {
            container: a.container.clone(),
            follow: false,
            previous: a.previous,
            tail_lines: Some(tail),
            since_seconds: a.since_seconds,
            timestamps: true,
            ..Default::default()
        };

        let futures = pod_names.iter().map(|name| {
            let api = pods_api.clone();
            let lp = lp.clone();
            let name = name.clone();
            async move {
                let res = api.logs(&name, &lp).await;
                (name, res)
            }
        });
        let results = join_all(futures).await;

        let mut total_bytes = 0usize;
        let mut truncated = false;
        let mut out: Vec<Value> = Vec::with_capacity(results.len());
        for (name, res) in results {
            match res {
                Ok(s) => {
                    let remaining = MAX_TOTAL_BYTES.saturating_sub(total_bytes);
                    let body = if s.len() > remaining {
                        truncated = true;
                        s[s.len() - remaining..].to_string()
                    } else {
                        s
                    };
                    total_bytes += body.len();
                    out.push(json!({
                        "pod": name,
                        "container": a.container,
                        "logs": body,
                    }));
                    if total_bytes >= MAX_TOTAL_BYTES {
                        truncated = true;
                        break;
                    }
                }
                Err(e) => {
                    out.push(json!({
                        "pod": name,
                        "error": e.to_string(),
                    }));
                }
            }
        }

        Ok(json!({
            "namespace": a.namespace,
            "pods": out,
            "truncated": truncated,
            "byte_cap": MAX_TOTAL_BYTES,
        }))
    }
}

fn kube_err(e: kube::Error) -> NativeToolError {
    NativeToolError::msg(e.to_string())
}
