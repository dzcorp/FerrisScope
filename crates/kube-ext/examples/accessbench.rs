//! cargo run --release -p ferrisscope-kube-ext --example accessbench
//!
//! The RBAC cache's hot path: a rail's worth of `list` checks and a row
//! menu's verbs, answered from cache, plus how many reviews a cold pass
//! costs for an admin (cluster-wide allow) vs a namespace-scoped identity.
use std::error::Error;
use std::hint::black_box;
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use ferrisscope_kube_ext::access::{AccessCache, AccessRequest, Action, Reviewed};
use futures::FutureExt;

const KINDS: &[&str] = &[
    "pods",
    "deployments",
    "statefulsets",
    "daemonsets",
    "replicasets",
    "jobs",
    "cronjobs",
    "services",
    "ingresses",
    "configmaps",
    "secrets",
    "persistentvolumeclaims",
    "events",
    "serviceaccounts",
    "roles",
    "rolebindings",
    "networkpolicies",
    "horizontalpodautoscalers",
    "poddisruptionbudgets",
    "leases",
];

fn cache(admin: bool, reviews: Arc<AtomicUsize>) -> AccessCache {
    AccessCache::with_reviewer(Arc::new(move |attr| {
        reviews.fetch_add(1, Ordering::Relaxed);
        let ok = admin || attr.namespace == "team";
        async move {
            if ok {
                Reviewed::Allowed
            } else {
                Reviewed::Denied
            }
        }
        .boxed()
    }))
}

fn requests(namespaces: &[&str]) -> Vec<AccessRequest> {
    let mut out = Vec::new();
    for ns in namespaces {
        for kind in KINDS {
            for action in [Action::List, Action::Patch, Action::Delete] {
                out.push(AccessRequest {
                    kind_id: (*kind).into(),
                    action,
                    namespace: Some((*ns).into()),
                    name: Some("obj-0".into()),
                });
            }
        }
        for action in [
            Action::Exec,
            Action::Logs,
            Action::PortForward,
            Action::Evict,
        ] {
            out.push(AccessRequest {
                kind_id: "pods".into(),
                action,
                namespace: Some((*ns).into()),
                name: Some("pod-0".into()),
            });
        }
    }
    out
}

fn main() -> Result<(), Box<dyn Error>> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let mut out = std::io::stdout().lock();
    writeln!(
        out,
        "identity | requests | cold reviews | cold ms | warm us/batch | warm ns/request"
    )?;
    let namespaces = ["team", "prod", "staging", "dev", "ops"];
    let reqs = requests(&namespaces);
    for (label, admin) in [("admin", true), ("ns-scoped", false)] {
        let reviews = Arc::new(AtomicUsize::new(0));
        let c = cache(admin, reviews.clone());
        let started = Instant::now();
        black_box(rt.block_on(c.check(&reqs)));
        let cold = started.elapsed();
        let iters = 2_000u32;
        let started = Instant::now();
        for _ in 0..iters {
            black_box(rt.block_on(c.check(black_box(&reqs))));
        }
        let warm = started.elapsed() / iters;
        writeln!(
            out,
            "{label} | {} | {} | {:.2} | {:.1} | {:.0}",
            reqs.len(),
            reviews.load(Ordering::Relaxed),
            cold.as_secs_f64() * 1e3,
            warm.as_secs_f64() * 1e6,
            warm.as_secs_f64() * 1e9 / reqs.len() as f64,
        )?;
    }
    Ok(())
}
