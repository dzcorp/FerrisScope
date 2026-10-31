//! RBAC awareness against a real apiserver: SelfSubjectAccessReview answers
//! for a namespace-scoped ServiceAccount, the cluster-wide shortcut for an
//! admin, the rules listing, whoami, and a 403 liveness probe counting as
//! alive.
//!
//! ```
//! cargo test -p ferrisscope-kube-ext --features integration --test integration_access -- --test-threads=1
//! ```

#![cfg(feature = "integration")]

use ferrisscope_core::health::{liveness_probe, Liveness};
use ferrisscope_kube_ext::access::{rules, whoami, Access, AccessCache, AccessRequest, Action};
use ferrisscope_test_support::kind::{ensure_two_clusters, KindCluster};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};

async fn client_from(yaml: &str, context: &str) -> Client {
    let kc = Kubeconfig::from_yaml(yaml).unwrap();
    let opts = KubeConfigOptions {
        context: Some(context.to_owned()),
        ..Default::default()
    };
    Client::try_from(Config::from_custom_kubeconfig(kc, &opts).await.unwrap()).unwrap()
}

/// `dev` may manage pods and read their logs in `ns`, and nothing else.
fn apply_dev_role(cluster: &KindCluster, ns: &str) {
    cluster
        .kubectl_apply(&format!(
            "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: {ns}\n---\napiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: dev\n  namespace: {ns}\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: Role\nmetadata:\n  name: dev\n  namespace: {ns}\nrules:\n- apiGroups: [\"\"]\n  resources: [pods]\n  verbs: [get, list, watch, delete]\n- apiGroups: [\"\"]\n  resources: [pods/log]\n  verbs: [get]\n---\napiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata:\n  name: dev\n  namespace: {ns}\nsubjects:\n- kind: ServiceAccount\n  name: dev\n  namespace: {ns}\nroleRef:\n  apiGroup: rbac.authorization.k8s.io\n  kind: Role\n  name: dev\n"
        ))
        .unwrap();
}

fn req(kind: &str, action: Action, ns: Option<&str>) -> AccessRequest {
    AccessRequest {
        kind_id: kind.into(),
        action,
        namespace: ns.map(Into::into),
        name: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn namespace_scoped_identity_is_answered_per_namespace() {
    let (cluster, _b) = ensure_two_clusters().await.unwrap();
    let ns = "fs-it-access-1";
    apply_dev_role(&cluster, ns);
    let client = client_from(
        &cluster.kubeconfig_for_serviceaccount(ns, "dev").unwrap(),
        "sa-ctx",
    )
    .await;
    let cache = AccessCache::new(client.clone());

    let got = cache
        .check(&[
            req("pods", Action::Delete, Some(ns)),
            req("pods", Action::Logs, Some(ns)),
            req("pods", Action::Delete, Some("default")),
            req("pods", Action::Exec, Some(ns)),
            req("deployments", Action::List, Some(ns)),
            req("nodes", Action::Cordon, None),
            req("namespaces", Action::List, None),
        ])
        .await;
    assert_eq!(got[0], Access::Allowed, "delete pods in own namespace");
    assert_eq!(got[1], Access::Allowed, "pod logs in own namespace");
    for (i, d) in got.iter().enumerate().skip(2) {
        assert!(
            matches!(d, Access::Denied { .. }),
            "#{i} should be denied: {d:?}"
        );
    }

    // The identity can't list namespaces: the probe still reports alive.
    match liveness_probe(&client).await.unwrap() {
        Liveness::Restricted(msg) => assert!(msg.contains("forbidden"), "{msg}"),
        Liveness::Alive => panic!("a namespace-scoped SA must not list namespaces"),
    }

    let me = whoami(client.clone()).await.unwrap();
    assert_eq!(
        me.username.as_deref(),
        Some(format!("system:serviceaccount:{ns}:dev").as_str())
    );
    let r = rules(client, ns).await.unwrap();
    assert!(
        r.rules
            .iter()
            .any(|x| x.resources.contains(&"pods/log".to_owned())),
        "{r:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn admin_is_allowed_everywhere() {
    let (cluster, _b) = ensure_two_clusters().await.unwrap();
    let client = client_from(&cluster.kubeconfig_text, &cluster.context_name).await;
    let cache = AccessCache::new(client.clone());
    let got = cache
        .check(&[
            req("pods", Action::Exec, Some("kube-system")),
            req("nodes", Action::Drain, None),
            req("cronjobs", Action::Trigger, Some("default")),
            req("helm_releases", Action::HelmUpgrade, Some("default")),
        ])
        .await;
    assert!(got.iter().all(|d| *d == Access::Allowed), "{got:?}");
    assert_eq!(liveness_probe(&client).await.unwrap(), Liveness::Alive);
}
