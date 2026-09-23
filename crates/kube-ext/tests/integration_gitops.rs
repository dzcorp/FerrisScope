//! Real CRD schemas, discovery, watch projections, and optimistic merge patches.
#![cfg(feature = "integration")]

use std::time::Duration;

use ferrisscope_core::cluster::ListStrategy;
use ferrisscope_kube_ext::{
    fetch::{
        apply_resource, discover_crds, get_well_known_detail, merge_patch_resource, ApplyResult,
        MergePatchResult,
    },
    registry::ResourceKindEntry,
    watcher::NsScope,
};
use ferrisscope_test_support::kind::KindCluster;
use kube::{
    api::{ApiResource, DynamicObject, Patch, PatchParams},
    core::GroupVersionKind,
    Api,
};
use serde_json::{json, Value};
use tokio::time::{sleep, timeout};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gitops_discovery_details_watches_and_actions() {
    let cluster = KindCluster::ensure("ferrisscope-gitops", "kindest/node:v1.31.4")
        .await
        .expect("boot isolated kind cluster");
    for (repo, version, file) in [
        (
            "argoproj/argo-cd",
            "v3.1.1",
            "manifests/crds/application-crd.yaml",
        ),
        (
            "argoproj/argo-cd",
            "v3.1.1",
            "manifests/crds/applicationset-crd.yaml",
        ),
        (
            "argoproj/argo-cd",
            "v3.1.1",
            "manifests/crds/appproject-crd.yaml",
        ),
        (
            "fluxcd/kustomize-controller",
            "v1.6.1",
            "config/crd/bases/kustomize.toolkit.fluxcd.io_kustomizations.yaml",
        ),
        (
            "fluxcd/helm-controller",
            "v1.3.0",
            "config/crd/bases/helm.toolkit.fluxcd.io_helmreleases.yaml",
        ),
        (
            "fluxcd/source-controller",
            "v1.6.2",
            "config/crd/bases/source.toolkit.fluxcd.io_gitrepositories.yaml",
        ),
        (
            "fluxcd/source-controller",
            "v1.6.2",
            "config/crd/bases/source.toolkit.fluxcd.io_ocirepositories.yaml",
        ),
        (
            "fluxcd/source-controller",
            "v1.6.2",
            "config/crd/bases/source.toolkit.fluxcd.io_helmrepositories.yaml",
        ),
        (
            "fluxcd/source-controller",
            "v1.6.2",
            "config/crd/bases/source.toolkit.fluxcd.io_buckets.yaml",
        ),
        (
            "fluxcd/source-controller",
            "v1.6.2",
            "config/crd/bases/source.toolkit.fluxcd.io_helmcharts.yaml",
        ),
    ] {
        let url = format!("https://raw.githubusercontent.com/{repo}/{version}/{file}");
        cluster
            .kubectl(&["apply", "--server-side", "-f", &url])
            .expect("install pinned CRD");
    }
    cluster
        .kubectl(&[
            "wait",
            "--for=condition=Established",
            "crd",
            "--all",
            "--timeout=60s",
        ])
        .unwrap();
    cluster
        .kubectl_apply("apiVersion: v1\nkind: Namespace\nmetadata:\n  name: fs-gitops\n")
        .unwrap();
    let ns = "fs-gitops";
    let client = cluster.client.clone();
    let kinds: Vec<_> = discover_crds(client.clone())
        .await
        .unwrap()
        .into_iter()
        .map(ResourceKindEntry::from_dynamic_crd)
        .collect();
    let objects: Vec<DynamicObject> = serde_json::from_str(include_str!(
        "../../../tests/fixtures/well_known/gitops.json"
    ))
    .unwrap();
    for obj in objects {
        let types = obj.types.as_ref().unwrap();
        let group = types.api_version.split_once('/').unwrap().0;
        let entry = kinds
            .iter()
            .find(|e| e.meta.group == group && e.meta.kind == types.kind)
            .expect("discovered GitOps kind");
        assert_eq!(entry.meta.category.as_str(), "Apps");
        assert!(entry.meta.id.starts_with("wkcrd:"));
        let name = obj.metadata.name.as_deref().unwrap();
        assert!(matches!(
            apply_resource(
                client.clone(),
                entry.meta.id,
                Some(ns),
                name,
                json!({"spec":obj.data["spec"]}),
                false
            )
            .await
            .unwrap(),
            ApplyResult::Applied(_)
        ));
        let ar = ApiResource::from_gvk_with_plural(
            &GroupVersionKind::gvk(group, entry.meta.version, entry.meta.kind),
            entry.meta.plural,
        );
        let api: Api<DynamicObject> = Api::namespaced_with(client.clone(), ns, &ar);
        if group.ends_with(".toolkit.fluxcd.io") {
            let live = api.get(name).await.unwrap();
            api.patch_status(name, &PatchParams::default(), &Patch::Merge(json!({"status":{"observedGeneration":live.metadata.generation,"conditions":[{"type":"Ready","status":"True","reason":"Succeeded","message":"Fixture reconciled","lastTransitionTime":"2026-09-01T12:00:00Z","observedGeneration":live.metadata.generation}]}}))).await.unwrap();
        }
        let d = get_well_known_detail(client.clone(), entry.meta.id, Some(ns), name)
            .await
            .unwrap();
        assert_eq!(d["meta"]["name"], name);
        assert!(d["sections"].as_array().unwrap().len() >= 3);
        let watcher = (entry.start)(client.clone(), NsScope::One(ns.into()), ListStrategy::Paged);
        timeout(Duration::from_secs(30), async {
            while watcher.snapshot().is_empty() {
                sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("dynamic reflector initial snapshot");
        let snapshot = serde_json::to_value(watcher.snapshot()).unwrap();
        assert_eq!(snapshot[0]["name"], name);
        if group.ends_with(".toolkit.fluxcd.io") {
            assert_eq!(snapshot[0]["phase"], "Ready");
        }

        // Use exactly the patches supplied to the UI, never an SSA toggle.
        for id in [
            "sync",
            "refresh",
            "hard_refresh",
            "reconcile",
            "suspend",
            "resume",
        ] {
            let current = get_well_known_detail(client.clone(), entry.meta.id, Some(ns), name)
                .await
                .unwrap();
            let Some(action) = current["actions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|a| a["id"] == id)
            else {
                continue;
            };
            let rv = current["resource_version"].as_str();
            assert!(matches!(
                merge_patch_resource(
                    client.clone(),
                    entry.meta.id,
                    Some(ns),
                    name,
                    action["patch"].clone(),
                    rv
                )
                .await
                .unwrap(),
                MergePatchResult::Applied { .. }
            ));
            let after = api.get(name).await.unwrap();
            assert!(after.data["spec"].is_object());
            if id == "suspend" || id == "resume" {
                assert_eq!(after.data["spec"]["suspend"], id == "suspend");
            } else if id == "sync" {
                assert_eq!(after.data["operation"]["sync"]["prune"], false);
                assert_eq!(
                    after.data["operation"]["initiatedBy"]["username"],
                    "ferrisscope"
                );
            } else {
                for (key, expected) in action["patch"]["metadata"]["annotations"]
                    .as_object()
                    .unwrap()
                {
                    assert_eq!(
                        after
                            .metadata
                            .annotations
                            .as_ref()
                            .unwrap()
                            .get(key)
                            .map(String::as_str),
                        expected.as_str()
                    );
                }
            }
            let stale = merge_patch_resource(
                client.clone(),
                entry.meta.id,
                Some(ns),
                name,
                action["patch"].clone(),
                rv,
            )
            .await
            .unwrap();
            assert!(
                matches!(stale, MergePatchResult::Stale { .. }),
                "stale write must fail"
            );
        }
        if group.ends_with(".toolkit.fluxcd.io") {
            let before = api.get(name).await.unwrap();
            merge_patch_resource(
                client.clone(),
                entry.meta.id,
                Some(ns),
                name,
                json!({"spec":{"suspend":true}}),
                before.metadata.resource_version.as_deref(),
            )
            .await
            .unwrap();
            timeout(Duration::from_secs(30), async {
                loop {
                    let rows: Value = serde_json::to_value(watcher.snapshot()).unwrap();
                    if rows[0]["phase"] == "Suspended" {
                        break;
                    }
                    sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .expect("dynamic watch sees suspend");
        }
        assert!(
            get_well_known_detail(client.clone(), entry.meta.id, None, name)
                .await
                .is_err()
        );
        assert!(
            get_well_known_detail(client.clone(), entry.meta.id, Some(ns), "missing-object")
                .await
                .is_err()
        );
        drop(watcher);
    }
}
