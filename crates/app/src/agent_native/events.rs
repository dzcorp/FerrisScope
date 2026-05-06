//! `fs_events_list` — cluster events for debugging.
//!
//! Events are the apiserver's first-line breadcrumb when scheduling, image
//! pulls, volume mounts, or controllers fail. Returning the most recent N
//! events, optionally scoped to a namespace, is what `kubectl get events
//! --sort-by=.lastTimestamp` does — we mirror that.

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use k8s_openapi::api::core::v1::Event;
use kube::api::{Api, ListParams};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::state::AppState;

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 1_000;

#[derive(Debug, Deserialize)]
struct Args {
    /// Empty / omitted = all namespaces.
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    field_selector: Option<String>,
    /// Cap on returned events. Default 100, max 1000.
    #[serde(default)]
    limit: Option<usize>,
}

pub(crate) struct EventsList {
    app: AppHandle,
    cluster_id: String,
}

impl EventsList {
    pub(crate) fn new(app: AppHandle, cluster_id: String) -> Self {
        Self { app, cluster_id }
    }
}

#[async_trait]
impl NativeTool for EventsList {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_events_list".to_string(),
            description: "List cluster events sorted newest-first. Use this first when \
                diagnosing why a pod won't start, why scheduling failed, why image pull is \
                stuck, etc. Field selectors common operators reach for: \
                `involvedObject.name=<pod>`, `involvedObject.kind=Pod`, `type!=Normal` \
                (warnings only). Returns lastTimestamp / type / reason / object reference / \
                message per event."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "namespace": { "type": "string", "description": "Omit for cluster-wide." },
                    "field_selector": {
                        "type": "string",
                        "description": "e.g. `involvedObject.name=my-pod` or `type=Warning`."
                    },
                    "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "default": 100 }
                },
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
        let limit = a.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);
        let state = self.app.state::<AppState>();
        let entry = state
            .entry(&self.cluster_id)
            .await
            .map_err(NativeToolError::msg)?;
        let client = entry.cluster.client();

        let api: Api<Event> = match a.namespace.as_deref() {
            Some(ns) if !ns.is_empty() => Api::namespaced(client, ns),
            _ => Api::all(client),
        };
        // Listing all then sorting is the simplest path; the apiserver
        // doesn't sort events by timestamp natively. Cap upstream to keep
        // memory bounded on big clusters.
        let mut lp = ListParams::default().limit(MAX_LIMIT as u32);
        if let Some(s) = a.field_selector.as_deref() {
            lp = lp.fields(s);
        }
        let mut list = api
            .list(&lp)
            .await
            .map_err(|e| NativeToolError::msg(e.to_string()))?;
        list.items.sort_by(|a, b| {
            let ka = event_sort_key(a);
            let kb = event_sort_key(b);
            kb.cmp(&ka)
        });
        list.items.truncate(limit);

        let events: Vec<Value> = list.items.iter().map(project_event).collect();
        Ok(json!({
            "count": events.len(),
            "events": events,
        }))
    }
}

fn event_sort_key(e: &Event) -> String {
    e.last_timestamp
        .as_ref()
        .map(|t| t.0.to_string())
        .or_else(|| e.event_time.as_ref().map(|t| t.0.to_string()))
        .or_else(|| {
            e.metadata
                .creation_timestamp
                .as_ref()
                .map(|t| t.0.to_string())
        })
        .unwrap_or_default()
}

fn project_event(e: &Event) -> Value {
    let last = e
        .last_timestamp
        .as_ref()
        .map(|t| t.0.to_string())
        .or_else(|| e.event_time.as_ref().map(|t| t.0.to_string()));
    json!({
        "namespace": e.metadata.namespace.clone().unwrap_or_default(),
        "name": e.metadata.name.clone().unwrap_or_default(),
        "type": e.type_.clone().unwrap_or_default(),
        "reason": e.reason.clone().unwrap_or_default(),
        "count": e.count.unwrap_or(1),
        "object": json!({
            "kind": e.involved_object.kind.clone().unwrap_or_default(),
            "name": e.involved_object.name.clone().unwrap_or_default(),
            "namespace": e.involved_object.namespace.clone().unwrap_or_default(),
        }),
        "message": e.message.clone().unwrap_or_default(),
        "first_seen": e.first_timestamp.as_ref().map(|t| t.0.to_string()),
        "last_seen": last,
    })
}
