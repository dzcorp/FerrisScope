//! Job / CronJob operations against a real kind cluster.
//!
//! These need an apiserver specifically: the behaviour under test is the
//! apiserver's own garbage-collection defaults and the Job controller's
//! reaction to a cloned spec. Neither can be faked.
//!
//! Gated behind the `integration` feature so plain `cargo test` doesn't need
//! Docker. Run with:
//!
//! ```
//! cargo test --workspace --features integration -- --test-threads=1 --nocapture
//! ```

#![cfg(feature = "integration")]

use std::time::Duration;

use ferrisscope_kube_ext::{
    delete_resource, list_jobs_for_cron_job, rerun_job, trigger_cron_job, Cascade,
};
use ferrisscope_test_support::kind::{ensure_two_clusters, KindCluster};
use k8s_openapi::api::batch::v1::Job;
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
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

/// A Job that never finishes, so its pod is still around when we delete it.
fn sleeper_job_yaml(ns: &str, name: &str) -> String {
    format!(
        "apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: {name}\n  namespace: {ns}\nspec:\n  backoffLimit: 0\n  template:\n    spec:\n      restartPolicy: Never\n      containers:\n      - name: sleep\n        image: registry.k8s.io/e2e-test-images/busybox:1.36.1-1\n        command: [\"sh\", \"-c\", \"sleep 3600\"]\n"
    )
}

/// Schedule is far enough out that the controller never fires it on its own —
/// every Job in these tests is one we created.
fn cron_job_yaml(ns: &str, name: &str) -> String {
    format!(
        "apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: {name}\n  namespace: {ns}\nspec:\n  schedule: \"0 0 1 1 *\"\n  jobTemplate:\n    metadata:\n      labels:\n        origin: {name}\n    spec:\n      backoffLimit: 0\n      template:\n        spec:\n          restartPolicy: Never\n          containers:\n          - name: hello\n            image: registry.k8s.io/e2e-test-images/busybox:1.36.1-1\n            command: [\"sh\", \"-c\", \"echo hi\"]\n"
    )
}

async fn ensure_ns_absent(cluster: &KindCluster, ns: &str) {
    let _ = timeout(Duration::from_secs(60), async {
        loop {
            if cluster.kubectl(&["get", "namespace", ns]).is_err() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    })
    .await;
}

async fn wait_for_job_pod(client: &Client, ns: &str, job: &str) -> String {
    timeout(Duration::from_secs(120), async {
        let pods: Api<Pod> = Api::namespaced(client.clone(), ns);
        loop {
            let lp = ListParams::default().labels(&format!("job-name={job}"));
            if let Ok(list) = pods.list(&lp).await {
                if let Some(name) = list.items.first().and_then(|p| p.metadata.name.clone()) {
                    return name;
                }
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("job {job} never produced a pod"))
}

/// The bug this whole change exists for.
///
/// `batch/v1` answers `OrphanDependents` when a delete arrives with no
/// propagation policy, so an empty `DeleteOptions` removes the Job and leaves
/// its pod running with the owner reference stripped — unreferenced, invisible
/// in every workload view, still consuming the node. Deleting must default to
/// background propagation the way kubectl does.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deleting_a_job_takes_its_pods_with_it() {
    let (cluster, _b) = ensure_two_clusters().await.expect("boot kind");
    let client = build_client(&cluster).await;
    let ns = "fs-it-batch-cascade";
    ensure_ns_absent(&cluster, ns).await;
    cluster.kubectl_apply(&ns_yaml(ns)).expect("apply ns");
    cluster
        .kubectl_apply(&sleeper_job_yaml(ns, "sleeper"))
        .expect("apply job");

    let pod_name = wait_for_job_pod(&client, ns, "sleeper").await;

    delete_resource(client.clone(), "jobs", Some(ns), "sleeper", None, None)
        .await
        .expect("delete job");

    let pods: Api<Pod> = Api::namespaced(client, ns);
    let gone = timeout(Duration::from_secs(120), async {
        loop {
            match pods.get_opt(&pod_name).await {
                Ok(None) => return true,
                // A pod that is terminating counts — the GC has taken it.
                Ok(Some(p)) if p.metadata.deletion_timestamp.is_some() => return true,
                _ => tokio::time::sleep(Duration::from_millis(500)).await,
            }
        }
    })
    .await
    .unwrap_or(false);

    assert!(
        gone,
        "pod {pod_name} outlived its Job — the delete orphaned it"
    );

    let _ = cluster.kubectl(&["delete", "namespace", ns, "--wait=false"]);
}

/// `Cascade::Orphan` is the escape hatch and must still work — an operator who
/// explicitly asks to keep the pods gets them.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn orphan_cascade_keeps_the_pods() {
    let (cluster, _b) = ensure_two_clusters().await.expect("boot kind");
    let client = build_client(&cluster).await;
    let ns = "fs-it-batch-orphan";
    ensure_ns_absent(&cluster, ns).await;
    cluster.kubectl_apply(&ns_yaml(ns)).expect("apply ns");
    cluster
        .kubectl_apply(&sleeper_job_yaml(ns, "kept"))
        .expect("apply job");

    let pod_name = wait_for_job_pod(&client, ns, "kept").await;

    delete_resource(
        client.clone(),
        "jobs",
        Some(ns),
        "kept",
        None,
        Some(Cascade::Orphan),
    )
    .await
    .expect("delete job");

    // Give the GC a window in which it *would* have removed the pod.
    tokio::time::sleep(Duration::from_secs(10)).await;
    let pods: Api<Pod> = Api::namespaced(client, ns);
    let pod = pods
        .get_opt(&pod_name)
        .await
        .expect("get pod")
        .expect("orphaned pod must survive its Job");
    assert!(
        pod.metadata.deletion_timestamp.is_none(),
        "orphaned pod is terminating"
    );

    let _ = cluster.kubectl(&["delete", "namespace", ns, "--wait=false"]);
}

/// Trigger must produce a Job the CronJob owns. Without the controller owner
/// reference the manual run escapes the CronJob's history limits and outlives
/// its parent, which is the whole reason kubectl sets it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn triggering_a_cron_job_creates_an_owned_job() {
    let (cluster, _b) = ensure_two_clusters().await.expect("boot kind");
    let client = build_client(&cluster).await;
    let ns = "fs-it-batch-trigger";
    ensure_ns_absent(&cluster, ns).await;
    cluster.kubectl_apply(&ns_yaml(ns)).expect("apply ns");
    cluster
        .kubectl_apply(&cron_job_yaml(ns, "nightly"))
        .expect("apply cronjob");

    let created = trigger_cron_job(client.clone(), ns, "nightly", "nightly-manual-1")
        .await
        .expect("trigger cronjob");
    assert_eq!(created, "nightly-manual-1");

    let jobs: Api<Job> = Api::namespaced(client.clone(), ns);
    let job = jobs.get(&created).await.expect("created job exists");

    let owner = job
        .metadata
        .owner_references
        .as_deref()
        .unwrap_or_default()
        .iter()
        .find(|o| o.kind == "CronJob")
        .expect("job is owned by the CronJob");
    assert_eq!(owner.name, "nightly");
    assert_eq!(owner.controller, Some(true));

    assert_eq!(
        job.metadata
            .annotations
            .as_ref()
            .and_then(|a| a.get("cronjob.kubernetes.io/instantiate"))
            .map(String::as_str),
        Some("manual"),
        "manual runs must be distinguishable from scheduled ones"
    );
    // jobTemplate labels carry through, the way kubectl copies them.
    assert_eq!(
        job.metadata
            .labels
            .as_ref()
            .and_then(|l| l.get("origin"))
            .map(String::as_str),
        Some("nightly")
    );

    // …and the history view finds it by ownership.
    let history = list_jobs_for_cron_job(client, ns, "nightly")
        .await
        .expect("list history");
    assert_eq!(history.runs.len(), 1);
    assert_eq!(history.runs[0]["name"], created.as_str());
    assert_eq!(history.runs[0]["manual"], true);
    // A namespace holding one Job is nowhere near the scan bounds, so an
    // early stop here would mean the paging loop is broken.
    assert!(
        !history.truncated,
        "single-Job namespace reported truncated"
    );

    let _ = cluster.kubectl(&["delete", "namespace", ns, "--wait=false"]);
}

/// A Job's selector and pod-template labels are generated from its uid. Copy
/// them into a clone and the two Jobs fight over the same pods; the apiserver
/// also rejects a `manualSelector: false` spec carrying a selector. The clone
/// must come back with a *different* controller uid and run its own pod.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rerunning_a_job_creates_an_independent_copy() {
    let (cluster, _b) = ensure_two_clusters().await.expect("boot kind");
    let client = build_client(&cluster).await;
    let ns = "fs-it-batch-rerun";
    ensure_ns_absent(&cluster, ns).await;
    cluster.kubectl_apply(&ns_yaml(ns)).expect("apply ns");
    cluster
        .kubectl_apply(&sleeper_job_yaml(ns, "original"))
        .expect("apply job");
    wait_for_job_pod(&client, ns, "original").await;

    let created = rerun_job(client.clone(), ns, "original", "original-rerun-1")
        .await
        .expect("rerun job");
    assert_eq!(created, "original-rerun-1");

    let jobs: Api<Job> = Api::namespaced(client.clone(), ns);
    let source = jobs.get("original").await.expect("source job");
    let clone = jobs.get(&created).await.expect("cloned job");

    // The controller re-derives both from the new uid. Sharing either would
    // mean the two Jobs manage the same pods.
    let uid_label = |j: &Job| {
        j.spec
            .as_ref()
            .and_then(|s| s.selector.as_ref())
            .and_then(|s| s.match_labels.as_ref())
            .and_then(|m| m.get("batch.kubernetes.io/controller-uid").cloned())
    };
    assert!(
        uid_label(&clone).is_some(),
        "clone has a generated selector"
    );
    assert_ne!(
        uid_label(&source),
        uid_label(&clone),
        "clone reused the original's controller uid"
    );

    assert_eq!(
        clone
            .metadata
            .annotations
            .as_ref()
            .and_then(|a| a.get("ferrisscope.dev/rerun-of"))
            .map(String::as_str),
        Some("original")
    );

    // It actually runs — a clone the controller refuses to schedule would
    // still pass every assertion above.
    wait_for_job_pod(&client, ns, &created).await;

    let _ = cluster.kubectl(&["delete", "namespace", ns, "--wait=false"]);
}

/// History is ownership-scoped. A Job wearing the CronJob's template labels
/// but owned by nothing must not appear — labels are operator-supplied and
/// routinely shared.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn history_excludes_unowned_look_alikes() {
    let (cluster, _b) = ensure_two_clusters().await.expect("boot kind");
    let client = build_client(&cluster).await;
    let ns = "fs-it-batch-history";
    ensure_ns_absent(&cluster, ns).await;
    cluster.kubectl_apply(&ns_yaml(ns)).expect("apply ns");
    cluster
        .kubectl_apply(&cron_job_yaml(ns, "nightly"))
        .expect("apply cronjob");
    // Same label the jobTemplate stamps, no owner reference.
    cluster
        .kubectl_apply(&format!(
            "apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: impostor\n  namespace: {ns}\n  labels:\n    origin: nightly\nspec:\n  backoffLimit: 0\n  template:\n    spec:\n      restartPolicy: Never\n      containers:\n      - name: hello\n        image: registry.k8s.io/e2e-test-images/busybox:1.36.1-1\n        command: [\"sh\", \"-c\", \"echo hi\"]\n"
        ))
        .expect("apply impostor");

    trigger_cron_job(client.clone(), ns, "nightly", "nightly-manual-1")
        .await
        .expect("trigger cronjob");

    let history = list_jobs_for_cron_job(client, ns, "nightly")
        .await
        .expect("list history");
    let names: Vec<&str> = history
        .runs
        .iter()
        .filter_map(|j| j["name"].as_str())
        .collect();
    assert_eq!(names, vec!["nightly-manual-1"], "history: {names:?}");

    let _ = cluster.kubectl(&["delete", "namespace", ns, "--wait=false"]);
}
