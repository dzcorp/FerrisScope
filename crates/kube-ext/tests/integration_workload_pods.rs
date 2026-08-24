//! `list_pods_for_workload` against a real kind cluster.
//!
//! Gated behind the `integration` feature so plain `cargo test` doesn't
//! need Docker. Run with:
//!
//! ```
//! cargo test --workspace --features integration -- --test-threads=1 --nocapture
//! ```
//!
//! Every fixture is scoped to a unique `fs-it-*` namespace and torn down at
//! the end, so concurrent runs don't collide.

#![cfg(feature = "integration")]

use std::time::Duration;

use ferrisscope_kube_ext::{list_pods_for_workload, FetchError};
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

fn deployment_yaml(ns: &str, name: &str, replicas: u32) -> String {
    format!(
        "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {name}\n  namespace: {ns}\nspec:\n  replicas: {replicas}\n  selector:\n    matchLabels:\n      app: {name}\n  template:\n    metadata:\n      labels:\n        app: {name}\n    spec:\n      containers:\n      - name: pause\n        image: registry.k8s.io/pause:3.10\n"
    )
}

/// A second Deployment in the same namespace with a different selector must
/// not bleed into the first one's list — the selector is doing real work here,
/// not just "list every pod in the namespace".
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lists_only_the_deployments_own_pods_with_uids() {
    let (cluster, _b) = ensure_two_clusters().await.expect("boot kind");
    let client = build_client(&cluster).await;
    let ns = "fs-it-wl-pods-1";

    cluster.kubectl_apply(&ns_yaml(ns)).expect("apply ns");
    cluster
        .kubectl_apply(&deployment_yaml(ns, "mine", 2))
        .expect("apply mine");
    cluster
        .kubectl_apply(&deployment_yaml(ns, "theirs", 1))
        .expect("apply theirs");

    let rows = timeout(Duration::from_secs(90), async {
        loop {
            let rows = list_pods_for_workload(client.clone(), "deployments", ns, "mine")
                .await
                .expect("list pods for deployment");
            if rows.len() == 2 {
                return rows;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    })
    .await
    .expect("deployment never reached 2 pods");

    for row in &rows {
        // Without a uid the frontend's dedup map collapses every row onto
        // `undefined` and only the last pod survives — the exact bug the
        // manual uid injection in `list_pods_for_workload` guards against.
        let uid = row["uid"].as_str().expect("row carries a uid");
        assert!(!uid.is_empty(), "uid must not be empty");
        assert_eq!(row["namespace"], ns);
        let name = row["name"].as_str().expect("row carries a name");
        assert!(
            name.starts_with("mine-"),
            "selector leaked a foreign pod: {name}"
        );
    }

    let _ = cluster.kubectl(&["delete", "namespace", ns, "--wait=false"]);
}

/// A CronJob has no pod selector of its own — its pods hang off child Jobs.
/// The resolver must say so rather than silently returning an empty list,
/// which would read as "this workload has no pods".
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rejects_kinds_without_a_pod_selector() {
    let (cluster, _b) = ensure_two_clusters().await.expect("boot kind");
    let client = build_client(&cluster).await;

    let err = list_pods_for_workload(client, "cronjobs", "default", "whatever")
        .await
        .expect_err("cronjobs must not resolve through a selector");
    assert!(
        matches!(err, FetchError::UnknownKind(ref k) if k == "cronjobs"),
        "expected UnknownKind(cronjobs), got {err:?}"
    );
}
