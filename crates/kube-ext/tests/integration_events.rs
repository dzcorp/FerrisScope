//! Object Event query integration test against a real kind cluster.

#![cfg(feature = "integration")]

use ferrisscope_kube_ext::list_object_events;
use ferrisscope_test_support::kind::{ensure_two_clusters, KindCluster};
use k8s_openapi::api::core::v1::Pod;
use kube::api::Api;
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config, ResourceExt};

async fn build_client(cluster: &KindCluster) -> Client {
    let kubeconfig = Kubeconfig::from_yaml(&cluster.kubeconfig_text).expect("parse kubeconfig");
    let options = KubeConfigOptions {
        context: Some(cluster.context_name.clone()),
        ..Default::default()
    };
    let config = Config::from_custom_kubeconfig(kubeconfig, &options)
        .await
        .expect("build config");
    Client::try_from(config).expect("build client")
}

fn namespace_yaml(name: &str) -> String {
    format!("apiVersion: v1\nkind: Namespace\nmetadata:\n  name: {name}\n")
}

fn pod_yaml(namespace: &str, name: &str) -> String {
    format!(
        "apiVersion: v1\nkind: Pod\nmetadata:\n  name: {name}\n  namespace: {namespace}\nspec:\n  containers:\n  - name: pause\n    image: registry.k8s.io/pause:3.10\n"
    )
}

fn event_yaml(namespace: &str, name: &str, pod_name: &str, pod_uid: &str) -> String {
    format!(
        "apiVersion: v1\nkind: Event\nmetadata:\n  name: {name}\n  namespace: {namespace}\ninvolvedObject:\n  apiVersion: v1\n  kind: Pod\n  namespace: {namespace}\n  name: {pod_name}\n  uid: {pod_uid}\nreason: TestEvent\nmessage: integration event\ntype: Normal\nsource:\n  component: ferrisscope-test\n"
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn object_event_query_returns_only_the_selected_uid() {
    let (cluster, _other) = ensure_two_clusters().await.expect("boot kind");
    let namespace = "fs-it-object-events";
    cluster
        .kubectl_apply(&namespace_yaml(namespace))
        .expect("apply namespace");
    cluster
        .kubectl_apply(&pod_yaml(namespace, "selected"))
        .expect("apply selected pod");
    cluster
        .kubectl_apply(&pod_yaml(namespace, "other"))
        .expect("apply other pod");

    let client = build_client(&cluster).await;
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let selected_uid = pods
        .get("selected")
        .await
        .expect("get selected pod")
        .uid()
        .expect("selected pod UID");
    let other_uid = pods
        .get("other")
        .await
        .expect("get other pod")
        .uid()
        .expect("other pod UID");

    cluster
        .kubectl_apply(&event_yaml(
            namespace,
            "selected-event",
            "selected",
            &selected_uid,
        ))
        .expect("apply selected Event");
    cluster
        .kubectl_apply(&event_yaml(namespace, "other-event", "other", &other_uid))
        .expect("apply other Event");

    let rows = list_object_events(client, Some(namespace), &selected_uid)
        .await
        .expect("list selected object Events");
    assert!(!rows.is_empty(), "selected pod should have Events");
    assert!(
        rows.iter().all(|row| row["involved_uid"] == selected_uid),
        "field selector returned an Event for another object: {rows:?}"
    );
    assert!(
        rows.iter().all(|row| row["involved_uid"] != other_uid),
        "field selector must exclude the other pod"
    );
    assert!(
        rows.iter().any(|row| row["reason"] == "TestEvent"),
        "seeded Event was not returned: {rows:?}"
    );

    let _ = cluster.kubectl(&["delete", "namespace", namespace, "--wait=false"]);
}
