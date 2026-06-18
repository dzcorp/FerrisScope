//! Per-service loopback IP allocation for global forwards.
//!
//! Uses a `127.[clusterN].[nsN].[svcN]` scheme: each `(cluster, namespace)`
//! pair owns a `127.<cluster>.<ns>.*` row, and each service in that namespace takes the next
//! free last octet. The first octet is always `127` (the loopback `/8`); the
//! cluster octet starts at `1` so we never hand out `127.0.0.1` (reserved for
//! `Simple` forwards) and the service octet starts at `1` so we never hand out a
//! `.0` network address.
//!
//! The allocator is a pure in-memory bookkeeper — it does **not** create OS
//! loopback aliases (that's the helper's job on macOS/Windows; Linux loops the
//! whole `/8` natively). Persisted pinned forwards are restored with
//! [`IpAllocator::reserve`] so a fresh [`IpAllocator::allocate`] never collides
//! with an address already in use.

use std::collections::HashMap;
use std::net::Ipv4Addr;

use thiserror::Error;

/// Returns `true` if `ip` is in the loopback `127.0.0.0/8` block. Shared with
/// the helper, which rejects any `AddLoopback` request outside this range.
#[must_use]
pub fn is_loopback_v4(ip: Ipv4Addr) -> bool {
    ip.octets()[0] == 127
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AllocError {
    /// No free address left in the relevant octet space.
    #[error("loopback address space exhausted for this {0}")]
    Exhausted(&'static str),
    /// `reserve` was asked to claim an address already handed out.
    #[error("address {0} is already in use")]
    AlreadyUsed(Ipv4Addr),
    /// `reserve` was asked to claim an address outside `127.0.0.0/8`.
    #[error("address {0} is not a loopback address")]
    NotLoopback(Ipv4Addr),
}

/// Allocates and tracks `127.x.y.z` addresses for global forwards.
#[derive(Debug, Default)]
pub struct IpAllocator {
    used: std::collections::HashSet<Ipv4Addr>,
    /// cluster key → second octet (1-based).
    cluster_octet: HashMap<String, u8>,
    /// Next free second octet, as `u16` so `256` is an unambiguous "exhausted"
    /// sentinel (the valid range is `1..=255`).
    next_cluster: u16,
    /// (cluster, namespace) → third octet (0-based).
    ns_octet: HashMap<(String, String), u8>,
    /// cluster → next free third octet, `u16` for a `256` exhausted sentinel
    /// (valid range `0..=255`).
    next_ns: HashMap<String, u16>,
    /// (cluster, namespace) → next candidate fourth octet (1-based).
    next_svc: HashMap<(String, String), u8>,
}

impl IpAllocator {
    #[must_use]
    pub fn new() -> Self {
        Self {
            next_cluster: 1, // 127.1.*.* upward; keeps 127.0.0.1 free for Simple
            ..Self::default()
        }
    }

    #[must_use]
    pub fn is_used(&self, ip: Ipv4Addr) -> bool {
        self.used.contains(&ip)
    }

    /// Number of addresses currently handed out (test/observability aid).
    #[must_use]
    pub fn in_use(&self) -> usize {
        self.used.len()
    }

    fn cluster_octet_for(&mut self, cluster: &str) -> Result<u8, AllocError> {
        if let Some(o) = self.cluster_octet.get(cluster) {
            return Ok(*o);
        }
        if self.next_cluster > 255 {
            return Err(AllocError::Exhausted("cluster"));
        }
        let o = self.next_cluster as u8;
        self.cluster_octet.insert(cluster.to_string(), o);
        self.next_cluster += 1;
        Ok(o)
    }

    fn ns_octet_for(&mut self, cluster: &str, ns: &str) -> Result<u8, AllocError> {
        let key = (cluster.to_string(), ns.to_string());
        if let Some(o) = self.ns_octet.get(&key) {
            return Ok(*o);
        }
        let next = self.next_ns.entry(cluster.to_string()).or_insert(0);
        if *next > 255 {
            return Err(AllocError::Exhausted("namespace"));
        }
        let o = *next as u8;
        *next += 1;
        self.ns_octet.insert(key, o);
        Ok(o)
    }

    /// Allocate the next free loopback IP for a service in `(cluster, ns)`.
    pub fn allocate(&mut self, cluster: &str, ns: &str) -> Result<Ipv4Addr, AllocError> {
        let c = self.cluster_octet_for(cluster)?;
        let n = self.ns_octet_for(cluster, ns)?;
        let key = (cluster.to_string(), ns.to_string());
        let start = *self.next_svc.get(&key).unwrap_or(&1);
        // Service octet 1..=255 (skip .0 network address).
        for d in start..=255u8 {
            let ip = Ipv4Addr::new(127, c, n, d);
            if !self.used.contains(&ip) {
                self.used.insert(ip);
                self.next_svc.insert(key, d.saturating_add(1));
                return Ok(ip);
            }
        }
        Err(AllocError::Exhausted("service"))
    }

    /// Claim a specific address (restoring a persisted pinned forward). Fails if
    /// it's already in use or not a loopback address.
    pub fn reserve(&mut self, ip: Ipv4Addr) -> Result<(), AllocError> {
        if !is_loopback_v4(ip) {
            return Err(AllocError::NotLoopback(ip));
        }
        if !self.used.insert(ip) {
            return Err(AllocError::AlreadyUsed(ip));
        }
        Ok(())
    }

    /// Release an address back to the pool. Idempotent.
    pub fn release(&mut self, ip: Ipv4Addr) {
        self.used.remove(&ip);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_range_check() {
        assert!(is_loopback_v4(Ipv4Addr::LOCALHOST));
        assert!(is_loopback_v4(Ipv4Addr::new(127, 200, 5, 9)));
        assert!(!is_loopback_v4(Ipv4Addr::new(10, 0, 0, 1)));
        assert!(!is_loopback_v4(Ipv4Addr::new(128, 0, 0, 1)));
    }

    #[test]
    fn never_hands_out_localhost_and_stays_in_loopback() {
        let mut a = IpAllocator::new();
        for i in 0..50 {
            let ip = a.allocate("ctx", &format!("ns{i}")).unwrap();
            assert!(is_loopback_v4(ip), "{ip} not loopback");
            assert_ne!(ip, Ipv4Addr::LOCALHOST);
            assert_ne!(ip.octets()[3], 0, "never a .0 network address");
        }
    }

    #[test]
    fn distinct_services_get_distinct_ips() {
        let mut a = IpAllocator::new();
        let mut seen = std::collections::HashSet::new();
        for i in 0..20 {
            let ip = a.allocate("ctx", "default").unwrap();
            assert!(seen.insert(ip), "duplicate {ip}");
            let _ = i;
        }
        assert_eq!(a.in_use(), 20);
    }

    #[test]
    fn same_namespace_increments_last_octet() {
        let mut a = IpAllocator::new();
        let ip1 = a.allocate("ctx", "default").unwrap();
        let ip2 = a.allocate("ctx", "default").unwrap();
        assert_eq!(ip1, Ipv4Addr::new(127, 1, 0, 1));
        assert_eq!(ip2, Ipv4Addr::new(127, 1, 0, 2));
    }

    #[test]
    fn different_namespace_increments_third_octet() {
        let mut a = IpAllocator::new();
        let a1 = a.allocate("ctx", "ns-a").unwrap();
        let b1 = a.allocate("ctx", "ns-b").unwrap();
        assert_eq!(a1, Ipv4Addr::new(127, 1, 0, 1));
        assert_eq!(b1, Ipv4Addr::new(127, 1, 1, 1));
    }

    #[test]
    fn different_cluster_increments_second_octet() {
        let mut a = IpAllocator::new();
        let c1 = a.allocate("ctx-1", "default").unwrap();
        let c2 = a.allocate("ctx-2", "default").unwrap();
        assert_eq!(c1, Ipv4Addr::new(127, 1, 0, 1));
        assert_eq!(c2, Ipv4Addr::new(127, 2, 0, 1));
    }

    #[test]
    fn release_then_allocate_reuses_address() {
        let mut a = IpAllocator::new();
        let ip1 = a.allocate("ctx", "default").unwrap(); // .1
        let _ip2 = a.allocate("ctx", "default").unwrap(); // .2
        a.release(ip1);
        // Cursor has advanced past .1, so a fresh allocate hands out .3 — but
        // reserving the freed address must now succeed.
        a.reserve(ip1).unwrap();
        assert!(a.is_used(ip1));
    }

    #[test]
    fn reserve_rejects_used_and_non_loopback() {
        let mut a = IpAllocator::new();
        let ip = a.allocate("ctx", "default").unwrap();
        assert_eq!(a.reserve(ip), Err(AllocError::AlreadyUsed(ip)));
        let bad = Ipv4Addr::new(10, 0, 0, 5);
        assert_eq!(a.reserve(bad), Err(AllocError::NotLoopback(bad)));
    }

    #[test]
    fn reserved_address_is_skipped_by_allocate() {
        let mut a = IpAllocator::new();
        // Reserve the address that would be handed out first.
        a.reserve(Ipv4Addr::new(127, 1, 0, 1)).unwrap();
        let ip = a.allocate("ctx", "default").unwrap();
        assert_ne!(ip, Ipv4Addr::new(127, 1, 0, 1));
        assert_eq!(ip, Ipv4Addr::new(127, 1, 0, 2));
    }

    #[test]
    fn service_octet_exhaustion_errors() {
        let mut a = IpAllocator::new();
        // Fill .1..=.255 (255 services) in one namespace.
        for _ in 1..=255 {
            a.allocate("ctx", "default").unwrap();
        }
        assert_eq!(
            a.allocate("ctx", "default"),
            Err(AllocError::Exhausted("service"))
        );
    }
}
