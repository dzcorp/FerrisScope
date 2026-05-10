//! `ferrisscope-agent` — engine for the cluster-aware AI chat feature.
//!
//! Tauri-free by design (mirrors the same constraint `ferrisscope-core` has):
//! the `app` crate is responsible for wiring HTTP responses, channel events,
//! and on-disk paths. This crate owns the *shape* of the agent loop, the
//! provider trait, and the session-store format.

pub mod atomic_write;
pub mod config;
pub mod mcp;
pub mod native;
pub mod provider;
pub mod session;
pub mod types;

pub use config::{
    AgentSettings, ApprovalMode, Credential, ProviderConfig, ProviderKind, ReasoningEffort,
    ReasoningSettings,
};
pub use mcp::{classify as classify_tool, McpClient, McpError, McpTool, ToolCategory};
pub use native::{NativeRegistry, NativeTool, NativeToolError};
pub use provider::meta::{AuthMode, ModelsEndpoint, ProviderFlavor, ProviderMeta};
pub use provider::{
    ChatProvider, CompletionEvent, CompletionFinal, CompletionRequest, EventSink, FinishReason,
    ModelInfo, ProviderError, Usage,
};
pub use session::{
    SessionData, SessionError, SessionEvent, SessionMeta, SessionStore, SessionUpdate,
};
pub use types::{ChatMessage, MessageRole, ToolCall, ToolSchema};
