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
    /// Stable assignment: (cluster, namespace, service) → its loopback IP. Unlike
    /// `used`, this is **not** cleared on `release` — so re-enabling the same
    /// service hands back the *same* address. That keeps `/etc/hosts` and the
    /// browser / `mDNSResponder` DNS+connection caches valid across
    /// disable/re-enable cycles; churning the IP every cycle is what made
    /// re-forwarding flaky (a cached name resolved to a torn-down alias).
    assigned: HashMap<(String, String, String), Ipv4Addr>,
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

    /// Allocate a loopback IP for `service` in `(cluster, ns)`.
    ///
    /// **Stable per service:** if this `(cluster, ns, service)` was assigned an
    /// address earlier in the session and it's still free, hand back the *same*
    /// one — so re-enabling a service reuses its IP and cached DNS/connections
    /// stay valid (IP churn across re-enables was the cause of flaky
    /// re-forwarding).
    ///
    /// Otherwise pick a fresh octet: the next un-issued one ahead of the cursor
    /// first — so a just-released address isn't immediately recycled while its
    /// alias/listener teardown may still be settling (which would race a re-bind
    /// on the same `ip:port`). Only once the cursor reaches the top do we wrap and
    /// reuse the lowest freed octet, so repeated cycles can't exhaust the
    /// namespace at `.255` while addresses are actually free.
    pub fn allocate(
        &mut self,
        cluster: &str,
        ns: &str,
        service: &str,
    ) -> Result<Ipv4Addr, AllocError> {
        let skey = (cluster.to_string(), ns.to_string(), service.to_string());
        // Reuse this service's prior address when it's free → stable IPs.
        if let Some(&ip) = self.assigned.get(&skey) {
            if !self.used.contains(&ip) {
                self.used.insert(ip);
                return Ok(ip);
            }
        }
        let c = self.cluster_octet_for(cluster)?;
        let n = self.ns_octet_for(cluster, ns)?;
        let key = (cluster.to_string(), ns.to_string());
        let start = *self.next_svc.get(&key).unwrap_or(&1);
        // Service octet 1..=255 (skip .0 network address): scan forward from the
        // cursor, then wrap to reuse anything freed below it.
        let candidates = (start..=255u8).chain(1..start);
        for d in candidates {
            let ip = Ipv4Addr::new(127, c, n, d);
            if !self.used.contains(&ip) {
                self.used.insert(ip);
                self.next_svc.insert(key, d.saturating_add(1));
                self.assigned.insert(skey, ip);
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
            let ip = a.allocate("ctx", &format!("ns{i}"), "svc").unwrap();
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
            let ip = a.allocate("ctx", "default", &format!("svc{i}")).unwrap();
            assert!(seen.insert(ip), "duplicate {ip}");
        }
        assert_eq!(a.in_use(), 20);
    }

    #[test]
    fn same_namespace_increments_last_octet() {
        let mut a = IpAllocator::new();
        let ip1 = a.allocate("ctx", "default", "a").unwrap();
        let ip2 = a.allocate("ctx", "default", "b").unwrap();
        assert_eq!(ip1, Ipv4Addr::new(127, 1, 0, 1));
        assert_eq!(ip2, Ipv4Addr::new(127, 1, 0, 2));
    }

    #[test]
    fn same_service_keeps_stable_ip_across_release() {
        let mut a = IpAllocator::new();
        let first = a.allocate("ctx", "pulsar", "core").unwrap();
        a.release(first);
        // Another service churns in between (takes a fresh octet, then frees it).
        let other = a.allocate("ctx", "pulsar", "envoy").unwrap();
        assert_ne!(first, other);
        a.release(other);
        // Re-enabling `core` must hand back its original IP, not a new one — this
        // is what keeps DNS/connection caches valid across re-enable cycles.
        let again = a.allocate("ctx", "pulsar", "core").unwrap();
        assert_eq!(first, again, "same service must reuse its loopback IP");
    }

    #[test]
    fn different_namespace_increments_third_octet() {
        let mut a = IpAllocator::new();
        let a1 = a.allocate("ctx", "ns-a", "svc").unwrap();
        let b1 = a.allocate("ctx", "ns-b", "svc").unwrap();
        assert_eq!(a1, Ipv4Addr::new(127, 1, 0, 1));
        assert_eq!(b1, Ipv4Addr::new(127, 1, 1, 1));
    }

    #[test]
    fn different_cluster_increments_second_octet() {
        let mut a = IpAllocator::new();
        let c1 = a.allocate("ctx-1", "default", "svc").unwrap();
        let c2 = a.allocate("ctx-2", "default", "svc").unwrap();
        assert_eq!(c1, Ipv4Addr::new(127, 1, 0, 1));
        assert_eq!(c2, Ipv4Addr::new(127, 2, 0, 1));
    }

    #[test]
    fn release_then_allocate_reuses_address() {
        let mut a = IpAllocator::new();
        let ip1 = a.allocate("ctx", "default", "a").unwrap(); // .1
        let _ip2 = a.allocate("ctx", "default", "b").unwrap(); // .2
        a.release(ip1);
        // A *different* service won't recycle .1 immediately (cursor advanced),
        // but reserving the freed address must still succeed.
        a.reserve(ip1).unwrap();
        assert!(a.is_used(ip1));
    }

    #[test]
    fn reserve_rejects_used_and_non_loopback() {
        let mut a = IpAllocator::new();
        let ip = a.allocate("ctx", "default", "svc").unwrap();
        assert_eq!(a.reserve(ip), Err(AllocError::AlreadyUsed(ip)));
        let bad = Ipv4Addr::new(10, 0, 0, 5);
        assert_eq!(a.reserve(bad), Err(AllocError::NotLoopback(bad)));
    }

    #[test]
    fn reserved_address_is_skipped_by_allocate() {
        let mut a = IpAllocator::new();
        // Reserve the address that would be handed out first.
        a.reserve(Ipv4Addr::new(127, 1, 0, 1)).unwrap();
        let ip = a.allocate("ctx", "default", "svc").unwrap();
        assert_ne!(ip, Ipv4Addr::new(127, 1, 0, 1));
        assert_eq!(ip, Ipv4Addr::new(127, 1, 0, 2));
    }

    #[test]
    fn repeated_enable_disable_does_not_exhaust_namespace() {
        // Re-enabling the same namespace many times (allocate N, release N) must
        // not march the cursor into exhaustion while addresses are free: once it
        // reaches the top it wraps and reuses freed octets. Simulate 100 cycles
        // of a 5-service namespace — far more than the 255-octet space — and
        // assert every allocation still succeeds.
        let mut a = IpAllocator::new();
        // Unique service names every time so each is a *fresh* allocation (no
        // stable-IP reuse short-circuit), forcing the cursor to advance, wrap, and
        // recycle freed octets.
        let mut n = 0;
        for _ in 0..100 {
            let mut batch = Vec::new();
            for _ in 0..5 {
                n += 1;
                batch.push(
                    a.allocate("ctx", "default", &format!("svc{n}"))
                        .expect("should never exhaust"),
                );
            }
            for ip in batch {
                a.release(ip);
            }
        }
        assert_eq!(a.in_use(), 0, "everything released");
    }

    #[test]
    fn cursor_prefers_unissued_then_wraps_to_reuse() {
        let mut a = IpAllocator::new();
        let ip1 = a.allocate("ctx", "default", "a").unwrap(); // .1
        let ip2 = a.allocate("ctx", "default", "b").unwrap(); // .2
        assert_eq!(ip1.octets()[3], 1);
        assert_eq!(ip2.octets()[3], 2);
        // Releasing .1 then allocating a *different* service must NOT recycle .1
        // immediately (teardown race guard): it goes forward to .3.
        a.release(ip1);
        assert_eq!(a.allocate("ctx", "default", "c").unwrap().octets()[3], 3);
    }

    #[test]
    fn service_octet_exhaustion_errors() {
        let mut a = IpAllocator::new();
        // Fill .1..=.255 (255 distinct services) in one namespace.
        for i in 1..=255 {
            a.allocate("ctx", "default", &format!("svc{i}")).unwrap();
        }
        assert_eq!(
            a.allocate("ctx", "default", "one-too-many"),
            Err(AllocError::Exhausted("service"))
        );
    }
}
