//! Wire-shape types shared across providers, the loop, and the session store.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    #[default]
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: MessageRole,
    /// Free-form text content. For tool-result messages this is the JSON
    /// (or stringified) tool result; for assistant messages it is the
    /// streamed text. Empty when the assistant only emitted tool calls.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub content: String,
    /// Assistant-side tool calls. Present only on `assistant` messages.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// Tool-result correlation. Present only on `tool` messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Optional name of the tool being responded to. Some providers (OpenAI
    /// historic shape) require this on tool-result messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Raw JSON arguments object as a string. Providers stream it as text
    /// deltas, so we keep it as a string and parse at execution time.
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    /// JSON Schema describing the tool's parameter shape. Free-form value
    /// rather than a typed schema struct because providers are lenient
    /// about the exact JSON Schema dialect they accept and we don't want
    /// to constrain that here.
    pub parameters: serde_json::Value,
}
