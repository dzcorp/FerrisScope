//! Fixture loading helpers.
//!
//! Tests under `crates/*/tests/` and inline `#[cfg(test)]` blocks both load
//! their fixtures relative to the workspace root, not the per-crate
//! `CARGO_MANIFEST_DIR`. Centralising the lookup here means a fixture move
//! only updates one constant.

use std::path::{Path, PathBuf};

/// Workspace root resolved at compile time. `CARGO_MANIFEST_DIR` for this
/// crate is `<root>/crates/test-support`, so two `parent()` hops land us at
/// the workspace root regardless of where the test binary executes from.
fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("test-support crate lives two levels under workspace root")
        .to_path_buf()
}

/// Absolute path to a fixture under `tests/fixtures/<rel>`.
pub fn fixture_path(rel: &str) -> PathBuf {
    workspace_root().join("tests").join("fixtures").join(rel)
}

/// Read a fixture file as bytes.
pub fn fixture_bytes(rel: &str) -> Vec<u8> {
    let path = fixture_path(rel);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read fixture {}: {}", path.display(), e))
}

/// Read a fixture file as a UTF-8 string.
pub fn fixture_string(rel: &str) -> String {
    let path = fixture_path(rel);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read fixture {}: {}", path.display(), e))
}

/// Parse a JSON fixture into `T`.
pub fn fixture_json<T: serde::de::DeserializeOwned>(rel: &str) -> T {
    let text = fixture_string(rel);
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse JSON fixture {rel}: {e}"))
}

/// Parse a YAML fixture into `T`. Used for K8s manifests.
pub fn fixture_yaml<T: serde::de::DeserializeOwned>(rel: &str) -> T {
    let text = fixture_string(rel);
    serde_yaml::from_str(&text).unwrap_or_else(|e| panic!("parse YAML fixture {rel}: {e}"))
}
