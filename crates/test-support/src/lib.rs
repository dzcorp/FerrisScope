//! Shared test fixtures and kind-cluster harness.
//!
//! Two surfaces:
//!
//! * [`fixtures`] — pure JSON/YAML fixture loaders for unit tests. Always
//!   available; no Docker required.
//! * [`kind`] — a kind-cluster harness for integration tests. Gated behind
//!   the `integration` feature so plain `cargo test` doesn't need Docker.

pub mod fixtures;

#[cfg(feature = "integration")]
pub mod kind;
