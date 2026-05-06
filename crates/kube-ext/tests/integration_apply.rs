//! Server-Side Apply / conflict integration tests against kind.
//!
//! Covers the contract `MetaSection` + ConfigMap edit kit relies on:
//! * apply with our field manager once → succeeds
//! * apply with a different manager owning the same field → 409 Conflict
//!   surfaced as `ApplyResult::Conflict { managers, fields, message }`
//! * force=true takes ownership without prompting
//!
//! Gated behind the `integration` feature.

#![cfg(feature = "integration")]

use ferrisscope_kube_ext::fetch::{apply_resource, ApplyResult, FIELD_MANAGER};
use ferrisscope_test_support::kind::{ensure_two_clusters, KindCluster};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};
use serde_json::json;

async fn build_client(cluster: &KindCluster) -> Client {
    let kc = Kubeconfig::from_yaml(&cluster.kubeconfig_text).expect("parse kubeconfig");
    let opts = KubeConfigOptions {
        context: Some(cluster.context_name.clone()),
        ..Default::default()
    };
    let config = Config::from_custom_kubeconfig(kc, &opts).await.unwrap();
    Client::try_from(config).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn apply_configmap_round_trip() {
    let (cluster, _b) = ensure_two_clusters().await.unwrap();
    let ns = "fs-it-ssa-1";
    cluster
        .kubectl_apply(&format!(
            "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: {ns}\n"
        ))
        .unwrap();

    let client = build_client(&cluster).await;

    let res = apply_resource(
        client.clone(),
        "configmaps",
        Some(ns),
        "settings",
        json!({
            "data": { "DATABASE_URL": "postgres://x", "FEATURE_FLAGS": "alpha" }
        }),
        false,
    )
    .await
    .expect("apply must succeed");
    assert!(matches!(res, ApplyResult::Applied(_)));

    // Read back the data.
    let out = cluster
        .kubectl(&["-n", ns, "get", "configmap", "settings", "-o", "yaml"])
        .unwrap();
    assert!(out.contains("DATABASE_URL"), "{out}");
    assert!(out.contains("postgres"), "{out}");
    // Owned by our field manager. kubectl 1.28+ hides `managedFields` by
    // default — we have to ask for them explicitly.
    let managed = cluster
        .kubectl(&[
            "-n",
            ns,
            "get",
            "configmap",
            "settings",
            "-o",
            "yaml",
            "--show-managed-fields=true",
        ])
        .unwrap();
    assert!(
        managed.contains(&format!("manager: {FIELD_MANAGER}")),
        "expected SSA manager set to {FIELD_MANAGER}, got:\n{managed}"
    );

    let _ = cluster.kubectl(&["delete", "namespace", ns, "--wait=false"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn apply_with_conflicting_manager_returns_conflict() {
    let (cluster, _b) = ensure_two_clusters().await.unwrap();
    let ns = "fs-it-ssa-conflict";
    cluster
        .kubectl_apply(&format!(
            "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: {ns}\n"
        ))
        .unwrap();

    // Step 1: foreign manager (`other-tool`) takes ownership of
    // data.KEY=A via a server-side apply. We stage the manifest in a
    // tempfile so kubectl's `-f` can read it; piping via stdin works for
    // `kubectl apply` but not for SSA flag combinations on every kubectl
    // version (1.27 had a bug with `apply --server-side -f -`).
    let foreign_yaml = format!(
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: contested\n  namespace: {ns}\ndata:\n  KEY: A\n"
    );
    let manifest_path =
        std::env::temp_dir().join(format!("fs-it-conflict-{}.yaml", std::process::id()));
    std::fs::write(&manifest_path, &foreign_yaml).unwrap();
    cluster
        .kubectl(&[
            "apply",
            "--server-side=true",
            "--field-manager=other-tool",
            "-f",
            manifest_path.to_str().unwrap(),
        ])
        .expect("foreign SSA apply must succeed");
    let _ = std::fs::remove_file(&manifest_path);

    // Step 2: our manager applies a different value to the same field.
    // Without force, expect Conflict.
    let client = build_client(&cluster).await;
    let res = apply_resource(
        client.clone(),
        "configmaps",
        Some(ns),
        "contested",
        json!({ "data": { "KEY": "B" } }),
        false,
    )
    .await
    .expect("apply call itself succeeds (the conflict is in the result enum)");
    let conflict = match res {
        ApplyResult::Conflict(c) => c,
        ApplyResult::Applied(_) => panic!("expected Conflict, got Applied"),
    };
    assert!(
        conflict.managers.iter().any(|m| m == "other-tool"),
        "managers list missing other-tool: {:?}",
        conflict.managers
    );
    assert!(
        !conflict.fields.is_empty(),
        "conflict.fields should list at least one path"
    );

    // Step 3: force=true takes ownership; value flips to B.
    let res = apply_resource(
        client.clone(),
        "configmaps",
        Some(ns),
        "contested",
        json!({ "data": { "KEY": "B" } }),
        true,
    )
    .await
    .unwrap();
    assert!(matches!(res, ApplyResult::Applied(_)));
    let out = cluster
        .kubectl(&[
            "-n",
            ns,
            "get",
            "configmap",
            "contested",
            "-o",
            "jsonpath={.data.KEY}",
        ])
        .unwrap();
    assert_eq!(out.trim(), "B");

    let _ = cluster.kubectl(&["delete", "namespace", ns, "--wait=false"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn apply_label_edit_via_metadata_path() {
    // Mirrors what MetaSection's KvEditor flushes for labels — partial
    // metadata.labels apply must merge, not clobber the existing object.
    let (cluster, _b) = ensure_two_clusters().await.unwrap();
    let ns = "fs-it-ssa-labels";
    cluster
        .kubectl_apply(&format!(
            "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: {ns}\n"
        ))
        .unwrap();
    cluster
        .kubectl_apply(&format!(
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: lbl-target\n  namespace: {ns}\ndata:\n  k: v\n"
        ))
        .unwrap();

    let client = build_client(&cluster).await;
    apply_resource(
        client,
        "configmaps",
        Some(ns),
        "lbl-target",
        json!({ "metadata": { "labels": { "team": "platform", "env": "test" } } }),
        false,
    )
    .await
    .unwrap();

    // Data must still be present (apply merged, not replaced).
    let data = cluster
        .kubectl(&[
            "-n",
            ns,
            "get",
            "configmap",
            "lbl-target",
            "-o",
            "jsonpath={.data.k}",
        ])
        .unwrap();
    assert_eq!(data.trim(), "v", "data.k was clobbered");

    let labels = cluster
        .kubectl(&[
            "-n",
            ns,
            "get",
            "configmap",
            "lbl-target",
            "-o",
            "jsonpath={.metadata.labels}",
        ])
        .unwrap();
    assert!(labels.contains("team"), "labels: {labels}");
    assert!(labels.contains("platform"), "labels: {labels}");

    let _ = cluster.kubectl(&["delete", "namespace", ns, "--wait=false"]);
}
