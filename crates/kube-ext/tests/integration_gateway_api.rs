//! Layer 2f: Gateway API CRDs + Envoy Gateway, exercised through our
//! well-known override path against a real cluster.
//!
//! Steps:
//! 1. Install Gateway API CRDs.
//! 2. Install Envoy Gateway controller.
//! 3. Apply a GatewayClass + Gateway + HTTPRoute.
//! 4. Use the dynamic API to GET each object via the override's
//!    short_id-derived `wkcrd:` path; assert `project_detail` matches.
//! 5. Verify `wkcrd:` id round-trips (build → parse).

#![cfg(feature = "integration")]

use std::time::Duration;

use ferrisscope_kube_ext::fetch::get_well_known_detail;
use ferrisscope_kube_ext::well_known::{lookup_by_gk, make_id, parse_id, registry};
use ferrisscope_test_support::kind::{ensure_two_clusters, KindCluster};
use kube::config::{KubeConfigOptions, Kubeconfig};
use kube::{Client, Config};
use tokio::time::sleep;

async fn build_client(cluster: &KindCluster) -> Client {
    let kc = Kubeconfig::from_yaml(&cluster.kubeconfig_text).unwrap();
    let opts = KubeConfigOptions {
        context: Some(cluster.context_name.clone()),
        ..Default::default()
    };
    let config = Config::from_custom_kubeconfig(kc, &opts).await.unwrap();
    Client::try_from(config).unwrap()
}

const GATEWAY_FIXTURE: &str = r#"
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: eg
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: eg
  namespace: default
spec:
  gatewayClassName: eg
  listeners:
  - name: http
    protocol: HTTP
    port: 80
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: backend
  namespace: default
spec:
  parentRefs:
  - name: eg
  hostnames: ["www.example.com"]
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: backend
      port: 80
"#;

/// Boot the cluster (reusing if already up), install Gateway API + Envoy
/// Gateway, apply the fixture. Idempotent — `kubectl apply` re-applies
/// without error if the objects are already there.
async fn bootstrap_envoy_gateway() -> KindCluster {
    let (cluster, _b) = ensure_two_clusters().await.expect("boot kind");
    cluster
        .install_gateway_api_crds()
        .expect("install gateway api crds");
    cluster
        .install_envoy_gateway()
        .expect("install envoy gateway");
    // Wait until the apiserver lists the Gateway API kinds. CRDs become
    // available a beat after `apply` returns.
    for _ in 0..30 {
        if cluster
            .kubectl(&["api-resources", "--api-group=gateway.networking.k8s.io"])
            .ok()
            .map(|s| s.contains("gateways"))
            .unwrap_or(false)
        {
            break;
        }
        sleep(Duration::from_secs(1)).await;
    }
    cluster
        .kubectl_apply(GATEWAY_FIXTURE)
        .expect("apply fixture");
    cluster
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn well_known_registry_includes_gateway_api_kinds() {
    let kinds = [
        "GatewayClass",
        "Gateway",
        "HTTPRoute",
        "GRPCRoute",
        "ReferenceGrant",
    ];
    for k in kinds {
        let ovr = lookup_by_gk("gateway.networking.k8s.io", k);
        assert!(ovr.is_some(), "registry missing override for {k}");
    }
    // Spot-check the registry size — keeps us honest if a future change
    // accidentally drops one of the kinds.
    let count = registry()
        .iter()
        .filter(|w| w.group == "gateway.networking.k8s.io")
        .count();
    assert!(count >= 5, "fewer than 5 gateway api overrides registered");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wkcrd_id_round_trips_for_gateway() {
    let id = make_id(
        "gateways",
        "gateway.networking.k8s.io",
        "v1",
        "gateways",
        "Gateway",
        true,
    );
    let parsed = parse_id(&id).expect("parse own id");
    assert_eq!(parsed.short_id, "gateways");
    assert_eq!(parsed.kind, "Gateway");
    assert!(parsed.namespaced);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn well_known_get_detail_against_envoy_gateway() {
    let cluster = bootstrap_envoy_gateway().await;
    let client = build_client(&cluster).await;

    // GatewayClass — cluster-scoped.
    let gc_id = make_id(
        "gatewayclasses",
        "gateway.networking.k8s.io",
        "v1",
        "gatewayclasses",
        "GatewayClass",
        false,
    );
    let gc_detail = get_well_known_detail(client.clone(), &gc_id, None, "eg")
        .await
        .expect("GatewayClass detail");
    assert_eq!(gc_detail["meta"]["name"], "eg");

    // Gateway — namespaced.
    let gw_id = make_id(
        "gateways",
        "gateway.networking.k8s.io",
        "v1",
        "gateways",
        "Gateway",
        true,
    );
    let gw_detail = get_well_known_detail(client.clone(), &gw_id, Some("default"), "eg")
        .await
        .expect("Gateway detail");
    assert_eq!(gw_detail["meta"]["name"], "eg");
    // Listeners came through the projection.
    let listeners = gw_detail["listeners"]
        .as_array()
        .expect("listeners array")
        .clone();
    assert_eq!(listeners.len(), 1);
    assert_eq!(listeners[0]["protocol"], "HTTP");

    // HTTPRoute.
    let route_id = make_id(
        "httproutes",
        "gateway.networking.k8s.io",
        "v1",
        "httproutes",
        "HTTPRoute",
        true,
    );
    let route_detail = get_well_known_detail(client, &route_id, Some("default"), "backend")
        .await
        .expect("HTTPRoute detail");
    assert_eq!(route_detail["meta"]["name"], "backend");
    let hostnames = route_detail["hostnames"]
        .as_array()
        .expect("hostnames array");
    assert!(
        hostnames.iter().any(|v| v == "www.example.com"),
        "hostnames: {hostnames:?}"
    );
}
