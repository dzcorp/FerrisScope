//! Pure logic for **global** (DNS) port-forwarding.
//!
//! This module is deliberately free of any IO, privilege, or Tauri concern so
//! it can be unit-tested exhaustively and reused by both the app supervisor
//! (`ferrisscope-app`) and the privileged helper (`ferrisscope-helper`).
//!
//! - [`ipalloc`] hands out per-service loopback IPs (`127.x.y.z`).
//! - [`hostnames`] derives in-cluster DNS names for a service and validates
//!   hostnames coming back over the wire.
//! - [`hostsfile`] renders / merges / strips our managed block in a hosts file,
//!   never touching foreign lines.
//! - [`protocol`] is the wire format between the app and the privileged helper.
//!
//! The *privileged* side (creating loopback aliases, writing `/etc/hosts`) lives
//! in the helper crate; everything decidable without root lives here.

pub mod hostnames;
pub mod hostsfile;
pub mod ipalloc;
pub mod protocol;
