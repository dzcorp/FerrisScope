//! Layer 2e: RBAC degradation + exec-auth integration tests.
//!
//! * RBAC: a ServiceAccount with `get` on Pods but no `list`/`watch` must
//!   degrade gracefully — listing returns 403, the reflector surfaces a
//!   typed kube error, the supervisor logs and continues.
//! * Exec-auth: a kubeconfig that uses `exec` plugin auth must be
//!   accepted by kube-rs, with the plugin's stdout treated as the
//!   ExecCredential. We drive this via a tiny shell-script "plugin" so
//!   the test doesn't depend on a real cloud auth tool being installed.

#![cfg(feature = "integration")]

use std::time::Duration;

use ferrisscope_test_support::kind::{ensure_two_clusters, KindCluster};
use k8s_openapi::api::core::v1::Pod;
use kube::api::{Api, ListParams};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};

async fn build_client_from_yaml(yaml: &str, context_name: &str) -> Client {
    let kc = Kubeconfig::from_yaml(yaml).unwrap();
    let opts = KubeConfigOptions {
        context: Some(context_name.to_owned()),
        ..Default::default()
    };
    let config = Config::from_custom_kubeconfig(kc, &opts).await.unwrap();
    Client::try_from(config).unwrap()
}

/// Apply a ServiceAccount + Role + RoleBinding granting only `get` on
/// Pods in the given namespace — deliberately *not* `list`/`watch`, so
/// list calls return 403.
fn apply_limited_rbac(cluster: &KindCluster, ns: &str, sa: &str) {
    let manifest = format!(
        "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: {ns}\n---\napiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: {sa}\n  namespace: {ns}\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: Role\nmetadata:\n  name: {sa}-pod-get\n  namespace: {ns}\nrules:\n- apiGroups: [\"\"]\n  resources: [pods]\n  verbs: [get]\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata:\n  name: {sa}-pod-get\n  namespace: {ns}\nsubjects:\n- kind: ServiceAccount\n  name: {sa}\n  namespace: {ns}\nroleRef:\n  apiGroup: rbac.authorization.k8s.io\n  kind: Role\n  name: {sa}-pod-get\n"
    );
    cluster.kubectl_apply(&manifest).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn limited_rbac_returns_typed_forbidden_on_list() {
    let (cluster, _b) = ensure_two_clusters().await.unwrap();
    let ns = "fs-it-rbac-1";
    let sa = "scoped";
    apply_limited_rbac(&cluster, ns, sa);

    // A pod for the SA to be allowed to GET (when it exercises `get`),
    // and so list authoritatively fails on RBAC, not on "no objects".
    cluster
        .kubectl_apply(&format!(
            "apiVersion: v1\nkind: Pod\nmetadata:\n  name: target\n  namespace: {ns}\nspec:\n  restartPolicy: Always\n  containers:\n  - name: pause\n    image: registry.k8s.io/pause:3.10\n"
        ))
        .unwrap();

    let kc_yaml = cluster.kubeconfig_for_serviceaccount(ns, sa).unwrap();
    let client = build_client_from_yaml(&kc_yaml, "sa-ctx").await;

    let api: Api<Pod> = Api::namespaced(client.clone(), ns);

    // GET allowed.
    let _ = api
        .get("target")
        .await
        .expect("RoleBinding should permit GET on Pod");

    // LIST refused — must come back as a typed `kube::Error::Api` with
    // a 403 code, not a network-level error.
    let err = api
        .list(&ListParams::default())
        .await
        .expect_err("LIST must be denied");
    match err {
        kube::Error::Api(s) => {
            assert_eq!(s.code, 403, "expected 403, got: {s:?}");
            assert!(
                s.reason == "Forbidden" || s.message.to_ascii_lowercase().contains("forbidden"),
                "unexpected status: {s:?}"
            );
        }
        other => panic!("expected kube::Error::Api(403), got: {other:?}"),
    }

    let _ = cluster.kubectl(&["delete", "namespace", ns, "--wait=false"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exec_auth_plugin_kubeconfig_works() {
    // We don't need a real cloud plugin to exercise the exec-auth path —
    // a one-line shell script that prints a valid `ExecCredential` JSON
    // is all kube-rs needs to drive its `exec` flow.
    let (cluster, _b) = ensure_two_clusters().await.unwrap();
    let ns = "fs-it-exec-auth";
    let sa = "exec-sa";
    apply_limited_rbac(&cluster, ns, sa);

    // Mint a token for the SA — same as Layer 2e's RBAC test.
    let token = cluster
        .kubectl(&["create", "token", sa, "-n", ns, "--duration=1h"])
        .unwrap()
        .trim()
        .to_owned();
    assert!(!token.is_empty());

    let tmp = tempfile::TempDir::new().unwrap();
    let plugin_path = tmp.path().join("ferrisscope-exec-mock.sh");
    let plugin_script = format!(
        "#!/usr/bin/env sh\ncat <<'EOF'\n{{\"apiVersion\":\"client.authentication.k8s.io/v1\",\"kind\":\"ExecCredential\",\"status\":{{\"token\":\"{token}\"}}}}\nEOF\n"
    );
    std::fs::write(&plugin_path, plugin_script).unwrap();
    use std::os::unix::fs::PermissionsExt;
    let mut p = std::fs::metadata(&plugin_path).unwrap().permissions();
    p.set_mode(0o755);
    std::fs::set_permissions(&plugin_path, p).unwrap();

    // Build a kubeconfig that uses the exec plugin instead of a static
    // token. Server + CA come from the harness's kubeconfig.
    let kc: serde_yaml::Value = serde_yaml::from_str(&cluster.kubeconfig_text).unwrap();
    let server = kc["clusters"][0]["cluster"]["server"]
        .as_str()
        .unwrap()
        .to_owned();
    let ca = kc["clusters"][0]["cluster"]["certificate-authority-data"]
        .as_str()
        .unwrap()
        .to_owned();
    let kc_yaml = format!(
        "apiVersion: v1\nkind: Config\ncurrent-context: ec\nclusters:\n- name: kind\n  cluster:\n    server: {server}\n    certificate-authority-data: {ca}\nusers:\n- name: ec-user\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1\n      command: {plugin}\n      interactiveMode: Never\n      provideClusterInfo: false\ncontexts:\n- name: ec\n  context:\n    cluster: kind\n    user: ec-user\n    namespace: {ns}\n",
        plugin = plugin_path.display(),
    );
    let client = build_client_from_yaml(&kc_yaml, "ec").await;
    // Probe with apiserver_version — succeeds means kube-rs successfully
    // ran the exec plugin and got a usable token.
    let v = tokio::time::timeout(Duration::from_secs(15), client.apiserver_version())
        .await
        .expect("exec-auth probe should not hang")
        .expect("exec-auth credentials should be accepted");
    assert!(!v.git_version.is_empty(), "got version: {v:?}");

    let _ = cluster.kubectl(&["delete", "namespace", ns, "--wait=false"]);
}
