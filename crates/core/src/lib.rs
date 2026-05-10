//! ferrisscope-core
//!
//! Cluster engine: kubeconfig discovery, per-cluster supervisors, resource
//! watchers, and the event bus the UI subscribes to.
//!
//! This crate intentionally has no Tauri dependency so the same engine can
//! later back a TUI or headless CLI.

pub mod atomic_write;
pub mod cluster;
pub mod error;
pub mod fleet;
pub mod health;
pub mod kubeconfig;
pub mod logs;
pub mod metrics;
pub mod portforwards;
pub mod prefs;
pub mod prom_cache;
pub mod prometheus;
pub mod search;
pub mod sources;
pub mod ssh;
pub mod table_views;
pub mod watcher;

pub use error::{Error, Result};
