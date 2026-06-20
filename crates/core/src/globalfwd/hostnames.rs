//! In-cluster DNS name derivation and hostname validation for global forwards.
//!
//! For a service `api` in namespace `default` we register the names a workload
//! inside the cluster would resolve, so host-side tooling can use the exact same
//! addresses:
//!
//! ```text
//! api
//! api.default
//! api.default.svc
//! api.default.svc.cluster.local
//! ```
//!
//! Multi-cluster / context-qualified variants (`api.default.<context>`) layer on
//! via [`variants_with_context`]; the bare 4-name set is what a single-cluster
//! setup needs. Headless-service per-pod names are a later addition (they need
//! the pod name, which the supervisor resolves, not this pure layer).

/// Sanitize one DNS label: lowercase, replace any char outside `[a-z0-9-]` with
/// `-`, and trim leading/trailing `-`. Kubernetes names are already RFC-1123
/// labels, but service *display* inputs and CRD-ish names may not be, so we
/// normalize defensively (replace any illegal char with `-`).
#[must_use]
pub fn sanitize_label(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

/// The canonical single-cluster DNS variants for `service` in `namespace`,
/// longest-suffix last. Inputs are sanitized first.
#[must_use]
pub fn variants(service: &str, namespace: &str) -> Vec<String> {
    let svc = sanitize_label(service);
    let ns = sanitize_label(namespace);
    if svc.is_empty() || ns.is_empty() {
        return Vec::new();
    }
    vec![
        svc.clone(),
        format!("{svc}.{ns}"),
        format!("{svc}.{ns}.svc"),
        format!("{svc}.{ns}.svc.cluster.local"),
    ]
}

/// [`variants`] plus context-qualified names when `context` is given (for
/// disambiguating the same service across multiple connected clusters):
/// `svc.<context>` and `svc.ns.<context>`.
#[must_use]
pub fn variants_with_context(service: &str, namespace: &str, context: Option<&str>) -> Vec<String> {
    let mut out = variants(service, namespace);
    if let Some(ctx) = context {
        let svc = sanitize_label(service);
        let ns = sanitize_label(namespace);
        let ctx = sanitize_label(ctx);
        if !svc.is_empty() && !ns.is_empty() && !ctx.is_empty() {
            out.push(format!("{svc}.{ctx}"));
            out.push(format!("{svc}.{ns}.{ctx}"));
        }
    }
    out
}

/// Remove any single-label ("bare") hostname claimed by more than one entry.
///
/// Two services that share a name — different namespaces, or different
/// sessions/clusters — both generate the bare label (e.g. `api`). Writing both
/// into the hosts file makes resolution order-dependent: the last matching line
/// wins, so a service silently resolves to the wrong loopback IP. When a bare
/// label is ambiguous we strip it from *every* entry, leaving the
/// namespace-qualified names (`api.default`, … — which embed the namespace and
/// so never collide) for the operator to disambiguate with.
///
/// Operates in place on each entry's hostname list. A "bare" name is one with no
/// `.`; qualified names are always kept.
pub fn drop_ambiguous_bare_names(lists: &mut [&mut Vec<String>]) {
    use std::collections::{HashMap, HashSet};
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for list in lists.iter() {
        // Count each bare label at most once per entry, so a single entry that
        // happened to repeat a name doesn't mark it ambiguous against itself.
        let mut seen: HashSet<&str> = HashSet::new();
        for h in list.iter() {
            if !h.contains('.') && seen.insert(h.as_str()) {
                *counts.entry(h.as_str()).or_default() += 1;
            }
        }
    }
    let ambiguous: HashSet<String> = counts
        .into_iter()
        .filter(|&(_, c)| c > 1)
        .map(|(k, _)| k.to_string())
        .collect();
    if ambiguous.is_empty() {
        return;
    }
    for list in lists.iter_mut() {
        list.retain(|h| h.contains('.') || !ambiguous.contains(h));
    }
}

/// Validate a hostname the way the privileged helper must before writing it to
/// the hosts file: a dotted sequence of RFC-1123 labels, total length `<=253`,
/// each label `1..=63` chars of `[a-z0-9-]` not starting/ending with `-`.
/// Rejects empty, uppercase, whitespace, leading/trailing dots, and `..`.
#[must_use]
pub fn is_valid_hostname(h: &str) -> bool {
    if h.is_empty() || h.len() > 253 {
        return false;
    }
    h.split('.').all(is_valid_label)
}

fn is_valid_label(label: &str) -> bool {
    if label.is_empty() || label.len() > 63 {
        return false;
    }
    let bytes = label.as_bytes();
    if bytes[0] == b'-' || bytes[bytes.len() - 1] == b'-' {
        return false;
    }
    label
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_variants() {
        assert_eq!(
            variants("api", "default"),
            vec![
                "api",
                "api.default",
                "api.default.svc",
                "api.default.svc.cluster.local",
            ]
        );
    }

    #[test]
    fn variants_sanitize_inputs() {
        // Uppercase + illegal chars get normalized.
        let v = variants("My_Svc!", "Team A");
        assert_eq!(v[0], "my-svc");
        assert_eq!(v[1], "my-svc.team-a");
    }

    #[test]
    fn drops_bare_name_when_ambiguous_keeps_qualified() {
        // Same service name in two namespaces → bare `api` collides.
        let mut a = variants("api", "default");
        let mut b = variants("api", "kube-system");
        {
            let mut lists: Vec<&mut Vec<String>> = vec![&mut a, &mut b];
            drop_ambiguous_bare_names(&mut lists);
        }
        let bare = "api".to_string();
        assert!(!a.contains(&bare), "bare name dropped from first entry");
        assert!(!b.contains(&bare), "bare name dropped from second entry");
        // Namespace-qualified names survive so each is still reachable.
        assert!(a.contains(&"api.default".to_string()));
        assert!(b.contains(&"api.kube-system".to_string()));
    }

    #[test]
    fn keeps_bare_name_when_unique() {
        let mut a = variants("api", "default");
        let mut b = variants("db", "default");
        {
            let mut lists: Vec<&mut Vec<String>> = vec![&mut a, &mut b];
            drop_ambiguous_bare_names(&mut lists);
        }
        assert!(a.contains(&"api".to_string()), "unique bare name kept");
        assert!(b.contains(&"db".to_string()), "unique bare name kept");
    }

    #[test]
    fn empty_after_sanitize_yields_no_variants() {
        assert!(variants("***", "default").is_empty());
        assert!(variants("api", "---").is_empty());
    }

    #[test]
    fn context_variants_appended() {
        let v = variants_with_context("api", "default", Some("prod"));
        assert!(v.contains(&"api.prod".to_string()));
        assert!(v.contains(&"api.default.prod".to_string()));
        // base set still present
        assert!(v.contains(&"api.default.svc.cluster.local".to_string()));
    }

    #[test]
    fn no_context_matches_plain_variants() {
        assert_eq!(
            variants_with_context("api", "default", None),
            variants("api", "default")
        );
    }

    #[test]
    fn sanitize_trims_edge_hyphens() {
        assert_eq!(sanitize_label("-api-"), "api");
        assert_eq!(sanitize_label("a.b.c"), "a-b-c");
    }

    #[test]
    fn valid_hostnames_accepted() {
        for h in [
            "api",
            "api.default",
            "api.default.svc.cluster.local",
            "a1-b2.ns-3.svc",
        ] {
            assert!(is_valid_hostname(h), "{h} should be valid");
        }
    }

    #[test]
    fn invalid_hostnames_rejected() {
        for h in [
            "",
            "API",                // uppercase
            "api ",               // trailing space
            "api..default",       // empty label
            ".api",               // leading dot
            "api.",               // trailing dot
            "-api.default",       // label starts with -
            "api-.default",       // label ends with -
            "evil;rm -rf",        // shell metachars
            "127.0.0.1\n0.0.0.0", // injection / newline
        ] {
            assert!(!is_valid_hostname(h), "{h:?} should be rejected");
        }
        // 64-char label exceeds the 63 limit.
        let long_label = "a".repeat(64);
        assert!(!is_valid_hostname(&long_label));
    }
}
