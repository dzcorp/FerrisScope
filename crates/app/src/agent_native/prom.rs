//! `fs_prometheus_query` — read-only PromQL through the apiserver-proxied
//! Prometheus that the app already detects + caches per cluster.
//!
//! Two query modes in one tool: instant (default) or range when `start` is
//! supplied. Returns the parsed `data` field of the Prometheus response. Fails
//! with a clear message when no Prometheus target is configured for the chat's
//! cluster — the agent can suggest the operator pick one in Settings → AI /
//! Metrics, or call `fs_prometheus_query` with `auto_discover: true` to try
//! discovery on the fly.

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use ferrisscope_core::prom_cache;
use ferrisscope_core::prometheus::{self, PromTarget};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent_native::ChatClusterRef;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
struct Args {
    query: String,
    /// RFC3339 / unix-seconds. If supplied, the call becomes a range query.
    #[serde(default)]
    start: Option<String>,
    #[serde(default)]
    end: Option<String>,
    #[serde(default)]
    step: Option<String>,
    /// When true and no target is cached, run `discover` and use the first
    /// candidate that validates. Falls back to error if nothing validates.
    #[serde(default)]
    auto_discover: bool,
}

pub(crate) struct PrometheusQuery {
    app: AppHandle,
    cluster: ChatClusterRef,
}

impl PrometheusQuery {
    pub(crate) fn new(app: AppHandle, cluster: ChatClusterRef) -> Self {
        Self { app, cluster }
    }
}

#[async_trait]
impl NativeTool for PrometheusQuery {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_prometheus_query".to_string(),
            description:
                "Run a PromQL instant or range query through the apiserver-proxied Prometheus the \
                operator selected for this cluster. Supply `query` alone for an instant query, or \
                `query` + `start` + `end` + `step` for a range query (start/end are RFC3339 or \
                unix seconds; step is a Prometheus duration like `15s` or `1m`). When no \
                Prometheus is configured, set `auto_discover: true` to try in-cluster discovery; \
                otherwise the call fails with a hint to configure one in Settings."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "PromQL expression." },
                    "start": { "type": "string", "description": "Range start (RFC3339 or unix seconds)." },
                    "end":   { "type": "string", "description": "Range end (RFC3339 or unix seconds)." },
                    "step":  { "type": "string", "description": "Range step, e.g. `15s`, `1m`." },
                    "auto_discover": {
                        "type": "boolean",
                        "default": false,
                        "description": "Discover + use a Prometheus when none is configured."
                    }
                },
                "required": ["query"],
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
        let cluster_id = self.cluster.active().await;
        let state = self.app.state::<AppState>();
        let entry = state
            .entry(&cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let client = entry.cluster.client();

        let target = resolve_target(&cluster_id, &client, a.auto_discover).await?;

        let data = if a.start.is_some() {
            let start = a.start.unwrap_or_default();
            let end = a.end.unwrap_or_default();
            let step = a.step.unwrap_or_default();
            if start.is_empty() || end.is_empty() || step.is_empty() {
                return Err(NativeToolError::msg(
                    "range query requires `start`, `end`, and `step`",
                ));
            }
            prometheus::query_range(client, &target, &a.query, &start, &end, &step)
                .await
                .map_err(|e| NativeToolError::msg(e.to_string()))?
        } else {
            prometheus::query_instant(client, &target, &a.query)
                .await
                .map_err(|e| NativeToolError::msg(e.to_string()))?
        };

        Ok(json!({
            "target": {
                "namespace": target.namespace,
                "service": target.service,
                "port": target.port,
                "scheme": target.scheme,
                "backend": target.backend.short_label(),
            },
            "data": data,
        }))
    }
}

async fn resolve_target(
    cluster_id: &str,
    client: &kube::Client,
    auto_discover: bool,
) -> Result<PromTarget, NativeToolError> {
    if let Some(entry) = prom_cache::get(cluster_id).await {
        return Ok(entry.target);
    }
    if !auto_discover {
        return Err(NativeToolError::msg(
            "no Prometheus target configured for this cluster — pick one in Settings or pass \
             `auto_discover: true`",
        ));
    }
    let candidates = prometheus::discover(client.clone())
        .await
        .map_err(|e| NativeToolError::msg(format!("discover failed: {e}")))?;
    for cand in candidates {
        if prometheus::validate(client.clone(), &cand).await.is_ok() {
            return Ok(cand);
        }
    }
    Err(NativeToolError::msg(
        "no Prometheus-API-compatible Service responded to a probe (auto_discover)",
    ))
}
