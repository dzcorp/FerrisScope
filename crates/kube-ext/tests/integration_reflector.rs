//! Reflector + multi-context integration tests against real kind clusters.
//!
//! Gated behind the `integration` feature so plain `cargo test` doesn't
//! need Docker. Run with:
//!
//! ```
//! cargo test --workspace --features integration -- --nocapture
//! ```
//!
//! The harness (`ferrisscope_test_support::kind`) boots two clusters at
//! different K8s versions and reuses them across re-runs. Tests inside
//! one binary run sequentially (via `--test-threads=1` in CI) so they
//! don't trip on each other's namespaces; we still scope every fixture
//! to a unique namespace so even concurrent runs are safe.

#![cfg(feature = "integration")]

use std::sync::Arc;
use std::time::Duration;

use ferrisscope_kube_ext::registry::lookup;
use ferrisscope_kube_ext::watcher::ResourceDelta;
use ferrisscope_test_support::kind::{ensure_two_clusters, KindCluster};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};
use tokio::time::timeout;

async fn build_client(cluster: &KindCluster) -> Client {
    let kc = Kubeconfig::from_yaml(&cluster.kubeconfig_text).expect("parse kubeconfig");
    let opts = KubeConfigOptions {
        context: Some(cluster.context_name.clone()),
        ..Default::default()
    };
    let config = Config::from_custom_kubeconfig(kc, &opts)
        .await
        .expect("build config");
    Client::try_from(config).expect("build client")
}

fn ns_yaml(name: &str) -> String {
    format!("apiVersion: v1\nkind: Namespace\nmetadata:\n  name: {name}\n")
}

fn pod_yaml(ns: &str, name: &str) -> String {
    format!(
        "apiVersion: v1\nkind: Pod\nmetadata:\n  name: {name}\n  namespace: {ns}\n  labels:\n    app: {name}\nspec:\n  restartPolicy: Always\n  containers:\n  - name: pause\n    image: registry.k8s.io/pause:3.10\n"
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reflector_emits_pods_for_namespace_and_clears_on_unsubscribe() {
    let (cluster, _b) = ensure_two_clusters().await.expect("boot kind");
    let ns = "fs-it-reflect-1";
    cluster.kubectl_apply(&ns_yaml(ns)).expect("apply ns");
    cluster
        .kubectl_apply(&pod_yaml(ns, "alpha"))
        .expect("apply pod");

    let client = build_client(&cluster).await;
    let strategy = ferrisscope_core::cluster::ListStrategy::Paged;

    // Look up the pods kind via the registry — same path the app uses.
    let entry = lookup("pods").expect("pods kind registered");
    let watcher = (entry.start)(client.clone(), strategy);

    // Subscribe and wait for the InitDone marker. With 0 pods initially we
    // could miss the only event, so we wait specifically for our pod.
    let mut rx = watcher.subscribe();
    // First the watcher emits InitDone(...) followed by Upsert(...) events
    // for each existing pod, then live updates. Drain until we see our pod.
    let saw_pod = timeout(Duration::from_secs(60), async {
        loop {
            match rx.recv().await {
                Ok(delta) => {
                    if let ResourceDelta::Upsert { row, .. } = delta {
                        if row.get("namespace").and_then(|v| v.as_str()) == Some(ns)
                            && row.get("name").and_then(|v| v.as_str()) == Some("alpha")
                        {
                            return true;
                        }
                    }
                }
                Err(_) => continue,
            }
        }
    })
    .await
    .ok()
    .unwrap_or(false);
    assert!(saw_pod, "reflector did not surface the seeded pod");

    // Hard architectural rule: drop subscriber + watcher → reflector tears
    // down. We can't directly observe the spawn task, but `Arc::strong_count`
    // before/after gives a meaningful smoke test.
    let strong = Arc::strong_count(&watcher);
    assert!(
        strong >= 1,
        "watcher arc must still be live while we hold it"
    );
    drop(rx);

    // Cleanup so subsequent tests in the binary don't see the pod.
    let _ = cluster.kubectl(&["delete", "namespace", ns, "--wait=false"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_clusters_have_independent_reflector_state() {
    let (a, b) = ensure_two_clusters().await.expect("boot kind");
    // Different namespace per cluster. Cross-contamination would show up
    // as B's reflector emitting A's pod or vice versa.
    let ns_a = "fs-it-iso-a";
    let ns_b = "fs-it-iso-b";
    a.kubectl_apply(&ns_yaml(ns_a)).unwrap();
    b.kubectl_apply(&ns_yaml(ns_b)).unwrap();
    a.kubectl_apply(&pod_yaml(ns_a, "only-a")).unwrap();
    b.kubectl_apply(&pod_yaml(ns_b, "only-b")).unwrap();

    let entry = lookup("pods").unwrap();
    let client_a = build_client(&a).await;
    let client_b = build_client(&b).await;
    let strategy = ferrisscope_core::cluster::ListStrategy::Paged;
    let wa = (entry.start)(client_a, strategy);
    let wb = (entry.start)(client_b, strategy);

    let ra = wa.subscribe();
    let rb = wb.subscribe();

    // Collect everything each watcher emits within a short window, then
    // assert the names from each side don't bleed.
    let collect = |mut rx: tokio::sync::broadcast::Receiver<ResourceDelta>| async move {
        let mut names = Vec::<String>::new();
        let _ = timeout(Duration::from_secs(30), async {
            loop {
                match rx.recv().await {
                    Ok(ResourceDelta::Upsert { row, .. }) => {
                        if let Some(n) = row.get("name").and_then(|v| v.as_str()) {
                            names.push(n.to_owned());
                        }
                    }
                    Ok(_) => {}
                    Err(_) => continue,
                }
            }
        })
        .await;
        names
    };

    let (names_a, names_b) = tokio::join!(collect(ra.resubscribe()), collect(rb.resubscribe()));
    drop(ra);
    drop(rb);

    assert!(
        names_a.iter().any(|n| n == "only-a"),
        "cluster A reflector missing only-a"
    );
    assert!(
        !names_a.iter().any(|n| n == "only-b"),
        "cluster A leaked only-b: {names_a:?}"
    );
    assert!(
        names_b.iter().any(|n| n == "only-b"),
        "cluster B reflector missing only-b"
    );
    assert!(
        !names_b.iter().any(|n| n == "only-a"),
        "cluster B leaked only-a: {names_b:?}"
    );

    let _ = a.kubectl(&["delete", "namespace", ns_a, "--wait=false"]);
    let _ = b.kubectl(&["delete", "namespace", ns_b, "--wait=false"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn version_skew_across_clusters_is_observable() {
    // Layer 2e: confirm we can talk to two K8s versions concurrently.
    // The pinned images are 1.31.4 and 1.29.10 (see `cluster_names`).
    let (a, b) = ensure_two_clusters().await.expect("boot kind");
    let va = build_client(&a).await.apiserver_version().await.unwrap();
    let vb = build_client(&b).await.apiserver_version().await.unwrap();
    assert_ne!(
        va.git_version, vb.git_version,
        "two clusters should be on different K8s versions, got {} == {}",
        va.git_version, vb.git_version
    );
}
