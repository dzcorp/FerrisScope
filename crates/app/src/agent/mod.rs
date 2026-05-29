//! AI agent runtime + Tauri command surface.
//!
//! This module is the bridge between the Tauri-free `ferrisscope-agent` crate
//! and the Tauri host: it owns the `ChatRegistry`, persists agent settings to
//! `<config-dir>/agent_settings.json`, mediates API-key storage through the
//! keychain, and exposes the `chat_*` / `ai_*` commands.
//!
//! ## Layout
//!
//! Split from a single ~5.8k-line file into one submodule per concern. The
//! surface is re-exported flat (`pub(crate) use <m>::*`) so call sites and
//! `main.rs`'s `generate_handler!` still reach everything as
//! `crate::agent::<name>`; submodules reach each other via explicit
//! `use super::{…}` imports (no module-level wildcard — `clippy::pedantic`
//! forbids it outside `#[cfg(test)]`).
//!
//! - [`settings`] — on-disk `agent_settings.json` load/save.
//! - [`credentials`] — keychain / encrypted-file credential storage + cache.
//! - [`wire`] — serde DTOs crossing the Tauri boundary + the `ChatEvent` stream.
//! - [`runtime`] — `AgentState`, `ChatRuntime`, the live-chat registry.
//! - [`prompt`] — system-prompt + cluster/view context assembly.
//! - [`tools`] — tool execution, approval gate, result capping.
//! - [`classify`] — transient / context-overflow error classification + redaction.
//! - [`compaction`] — context-window compaction + token-limit math.
//! - [`title`] — background auto-title generation.
//! - [`turn`] — the LLM turn loop, provider rounds, retry / overflow recovery.
//! - [`commands`] — the `ai_*` / `chat_*` / `mcp_*` `#[tauri::command]` fns.

pub(crate) mod classify;
pub(crate) mod commands;
pub(crate) mod compaction;
pub(crate) mod credentials;
pub(crate) mod prompt;
pub(crate) mod runtime;
pub(crate) mod settings;
pub(crate) mod title;
pub(crate) mod tools;
pub(crate) mod turn;
pub(crate) mod wire;

pub(crate) use classify::*;
pub(crate) use commands::*;
pub(crate) use compaction::*;
pub(crate) use credentials::*;
pub(crate) use prompt::*;
pub(crate) use runtime::*;
pub(crate) use settings::*;
pub(crate) use title::*;
pub(crate) use tools::*;
pub(crate) use turn::*;
pub(crate) use wire::*;
