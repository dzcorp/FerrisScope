//! `fs_nodes_log` + `fs_nodes_stats_summary` — kubelet API-proxy reads.
//!
//! Both go through the apiserver's `/nodes/{name}/proxy/...` path so we
//! reuse the operator's kubeconfig auth (no direct kubelet reachability
//! needed). Requires `nodes/proxy` RBAC on the caller's identity.
//!
//! `fs_metrics_node` already exposes `/stats/summary` behind an
//! `include_stats_summary` flag — `fs_nodes_stats_summary` is a leaner
//! standalone tool that's useful when the agent only wants pressure data
//! and doesn't care about metrics-server CPU/mem.

use std::fmt::Write as _;

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use http::Request;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

const MAX_LOG_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
struct LogArgs {
    name: String,
    /// Service name (`kubelet`, `kube-proxy`, `containerd`) OR a path under
    /// `/var/log/` on the node — kubelet handles both.
    query: String,
    #[serde(default)]
    tail_lines: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct StatsArgs {
    name: String,
}

// ─── fs_nodes_log ────────────────────────────────────────────────────────────

pub(crate) struct NodesLog {
    app: AppHandle,
    cluster_id: String,
}

impl NodesLog {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for NodesLog {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_nodes_log".to_string(),
            description: "Fetch node-level logs through the kubelet's `/logs/` endpoint \
                (apiserver-proxied). The endpoint serves content from `/var/log/` on the node. \
                \n\nPass `query` as either:\n\
                • a path under `/var/log/` — with or without the `/var/log/` prefix \
                (`kubelet.log`, `magnum-reconcile.log`, `containers/`, `/var/log/audit/`). \
                Files return their contents; directories return `kind: \"directory_listing\"` \
                with an `entries` array you can drill into.\n\
                • a journald service name (`kubelet`, `kube-proxy`, `containerd`) — uses the \
                `?query=` form, which requires the kubelet's `NodeLogQuery` feature gate \
                (alpha in 1.27, GA in 1.30). On older clusters the kubelet ignores `?query=` \
                and returns the directory index; we surface that with a `note` so you can pick \
                a file path from `entries` and retry, or fall back to a node shell.\n\n\
                File output is capped at 256 KiB; tighten with `tail_lines` if you hit the cap. \
                Requires `nodes/proxy` RBAC."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Node name." },
                    "query": {
                        "type": "string",
                        "description": "File/dir under /var/log/ (e.g. `kubelet.log`, `containers/`, `/var/log/audit/`) or a service name (`kubelet`, `kube-proxy`, `containerd`) for the journald `?query=` form."
                    },
                    "tail_lines": { "type": "integer", "minimum": 0 }
                },
                "required": ["name", "query"],
                "additionalProperties": false
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let a: LogArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster_id).await?;

        // The kubelet `/logs/` endpoint already serves from `/var/log/` on the
        // node, so an input like `/var/log/kubelet.log` is `kubelet.log` from
        // the endpoint's perspective. Strip both the leading `/` and a leading
        // `var/log/` so callers can pass either shape.
        let raw = a.query.trim();
        let stripped = raw.trim_start_matches('/').trim_start_matches("var/log/");
        // Path-shaped queries: anything containing a slash or a dot. Bare
        // alphanumerics (`kubelet`, `kube-proxy`, `containerd`) go to the
        // journald `?query=` form, which requires the kubelet's `NodeLogQuery`
        // feature gate.
        let is_path_query =
            raw.starts_with('/') || stripped.contains('/') || stripped.contains('.');

        let mut path = if is_path_query {
            format!("/api/v1/nodes/{}/proxy/logs/{stripped}", a.name)
        } else {
            format!(
                "/api/v1/nodes/{}/proxy/logs/?query={}",
                a.name,
                urlenc(stripped)
            )
        };
        if let Some(t) = a.tail_lines {
            if t > 0 {
                let sep = if path.contains('?') { '&' } else { '?' };
                path.push(sep);
                let _ = write!(path, "tailLines={t}");
            }
        }

        // No strict Accept — kubelet builds vary: HTML directory listing for
        // `/logs/`, plain text for journald `?query=`, and file-extension-
        // derived MIME for individual log files. A strict `text/plain` makes
        // some kubelets respond 406. `*/*` lets the server pick.
        let req = Request::builder()
            .method("GET")
            .uri(&path)
            .header("accept", "*/*")
            .body(Vec::new())
            .map_err(|e| NativeToolError::msg(format!("request: {e}")))?;
        let body = client
            .request_text(req)
            .await
            .map_err(|e| NativeToolError::msg(e.to_string()))?;

        // The kubelet returns an HTML index when the path resolves to a
        // directory, *and* when a `?query=<service>` is asked of a kubelet
        // without the `NodeLogQuery` feature gate (the query is ignored and
        // the index of /var/log/ is served instead). Detect both and return
        // the entries as structured data — dumping HTML at the LLM is
        // misleading and burns tokens.
        let trimmed = body.trim_start();
        let is_html_listing =
            trimmed.starts_with("<!doctype html>") || trimmed.starts_with("<!DOCTYPE html>");
        if is_html_listing {
            let entries = parse_log_listing(&body);
            let note = if is_path_query {
                "Directory listing — pick a file or subdirectory from `entries` and retry with its path."
            } else {
                "Kubelet returned the /var/log/ index instead of journald output — the `NodeLogQuery` feature gate is likely disabled on this node (alpha in Kubernetes 1.27, GA in 1.30). Try a file path from `entries`, or use a node shell to read journald directly."
            };
            return Ok(json!({
                "name": a.name,
                "query": a.query,
                "kind": "directory_listing",
                "entries": entries,
                "note": note,
            }));
        }

        let truncated = body.len() > MAX_LOG_BYTES;
        let body = if truncated {
            body[body.len() - MAX_LOG_BYTES..].to_string()
        } else {
            body
        };
        Ok(json!({
            "name": a.name,
            "query": a.query,
            "kind": "log",
            "logs": body,
            "truncated": truncated,
            "byte_cap": MAX_LOG_BYTES,
        }))
    }
}

/// Pull `<a href="...">` entries out of the kubelet's directory-index HTML.
fn parse_log_listing(html: &str) -> Vec<String> {
    const NEEDLE: &str = "<a href=\"";
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(idx) = rest.find(NEEDLE) {
        let after = &rest[idx + NEEDLE.len()..];
        if let Some(end) = after.find('"') {
            out.push(after[..end].to_string());
            rest = &after[end..];
        } else {
            break;
        }
    }
    out
}

// ─── fs_nodes_stats_summary ──────────────────────────────────────────────────

pub(crate) struct NodesStatsSummary {
    app: AppHandle,
    cluster_id: String,
}

impl NodesStatsSummary {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for NodesStatsSummary {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_nodes_stats_summary".to_string(),
            description: "Kubelet `/stats/summary` for one node. Returns CPU, memory, \
                filesystem, network, and (on cgroup v2 + kernel ≥4.20) PSI pressure metrics for \
                node, pods, and system containers. Requires `nodes/proxy` RBAC. For the \
                metrics-server view (per-pod CPU/mem) see `fs_metrics_node`."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" }
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
        let a: StatsArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        let client = client_for(&self.app, &self.cluster_id).await?;

        let path = format!("/api/v1/nodes/{}/proxy/stats/summary", a.name);
        let req = Request::builder()
            .method("GET")
            .uri(&path)
            .header("accept", "application/json")
            .body(Vec::new())
            .map_err(|e| NativeToolError::msg(format!("request: {e}")))?;
        let body: Value = client
            .request(req)
            .await
            .map_err(|e| NativeToolError::msg(e.to_string()))?;
        Ok(body)
    }
}

// ─── helpers ────────────────────────────────────────────────────────────────

async fn client_for(app: &AppHandle, cluster_id: &str) -> Result<kube::Client, NativeToolError> {
    let state = app.state::<AppState>();
    let entry = state
        .entry(cluster_id)
        .await
        .map_err(NativeToolError::msg)?;
    Ok(entry.cluster.client())
}

/// Minimal URL encoder for the limited character set we forward in the
/// `query` parameter (service names like `kubelet`, `kube-proxy`). Keeps us
/// off a `url`/`urlencoding` dep just for this.
fn urlenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.bytes() {
        match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(c as char);
            }
            _ => {
                let _ = write!(out, "%{c:02X}");
            }
        }
    }
    out
}
