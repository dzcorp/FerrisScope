//! `fs_pause` — sleep for N seconds before the next turn.
//!
//! Useful when the agent needs to wait between operations: poll-after-create
//! on a pod that's still pulling its image, give a config change a moment to
//! propagate, space out two probes against a flaky endpoint, wait out a slow
//! Helm rollout or batch job. Without a sleep tool the model tends to either
//! tight-loop with `*_diagnose` calls (burning tokens) or hallucinate that
//! it waited.
//!
//! Bounds: 5..=1200 seconds (up to 20 minutes). Long enough for real rollout
//! waits; the upper bound is enforced by overriding `NativeTool::timeout` —
//! the global agent budget (60s) would otherwise kill the call.

use async_trait::async_trait;
use ferrisscope_agent::native::{NativeTool, NativeToolError};
use ferrisscope_agent::types::ToolSchema;
use ferrisscope_agent::ToolCategory;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

const MIN_SECS: u64 = 5;
const MAX_SECS: u64 = 1200;

#[derive(Debug, Deserialize)]
struct PauseArgs {
    seconds: u64,
}

pub(crate) struct Pause;

impl Pause {
    pub(crate) fn new() -> Self {
        Self
    }
}

#[async_trait]
impl NativeTool for Pause {
    fn schema(&self) -> ToolSchema {
        ToolSchema {
            name: "fs_pause".into(),
            description: "Sleep N seconds before the next step. Use between poll cycles \
                (after kubectl apply / helm upgrade / scale, before re-checking \
                status) to let the cluster settle. Range 5-1200s (up to 20min)."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "seconds": { "type": "integer", "minimum": MIN_SECS, "maximum": MAX_SECS }
                },
                "required": ["seconds"]
            }),
        }
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn timeout(&self) -> Option<Duration> {
        // Just past the upper bound so a max-length pause has room to land
        // and return cleanly rather than tripping the wrapper at the same
        // instant. The agent loop's wrapper still bounds runaway calls.
        Some(Duration::from_secs(MAX_SECS + 30))
    }

    async fn call(&self, args: Value) -> Result<Value, NativeToolError> {
        let parsed: PauseArgs = serde_json::from_value(args)
            .map_err(|e| NativeToolError::msg(format!("invalid args: {e}")))?;
        // Clamp instead of erroring on out-of-range — the schema already
        // tells the model the bounds; if it ignores them we'd rather still
        // do something useful than fail the call.
        let secs = parsed.seconds.clamp(MIN_SECS, MAX_SECS);
        tokio::time::sleep(Duration::from_secs(secs)).await;
        Ok(json!({ "slept_seconds": secs }))
    }
}
