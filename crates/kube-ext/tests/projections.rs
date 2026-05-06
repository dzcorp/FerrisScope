//! Golden-JSON projection tests.
//!
//! Each test feeds a representative K8s object (loaded from the workspace
//! `tests/fixtures/k8s/` JSON) through `project()` (row) and
//! `project_detail()` (detail panel) and snapshots the output via `insta`.
//! Snapshots live next to this test file under `snapshots/`.
//!
//! When a projection legitimately changes shape, run
//! `INSTA_UPDATE=auto cargo test -p ferrisscope-kube-ext --test projections`
//! and review the diff before committing.

use ferrisscope_kube_ext::registry::KindSpec;
use ferrisscope_test_support::fixtures::fixture_json;
use insta::{assert_json_snapshot, with_settings};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, LimitRange, Node, PersistentVolume, PersistentVolumeClaim, Pod, ResourceQuota,
    Secret, Service,
};
use k8s_openapi::api::discovery::v1::EndpointSlice;
use k8s_openapi::api::networking::v1::{Ingress, NetworkPolicy};
use kube::api::DynamicObject;

fn snapshot_settings() -> insta::Settings {
    let mut s = insta::Settings::clone_current();
    // Snapshots live adjacent to this test (kube-ext/tests/snapshots/).
    s.set_snapshot_path("snapshots");
    // Strip the random Cargo target hash from snapshot names so reruns are
    // deterministic.
    s.set_prepend_module_to_snapshot(false);
    s
}

fn snap(name: &str, value: &serde_json::Value) {
    with_settings!({ snapshot_path => "snapshots" }, {
        let _settings = snapshot_settings();
        assert_json_snapshot!(name, value);
    });
}

// ── Pods ───────────────────────────────────────────────────────────────────

#[test]
fn pod_running_row() {
    let pod: Pod = fixture_json("k8s/pod_running.json");
    let row = ferrisscope_kube_ext::kinds::pods::PodSpec::project(&pod);
    snap("pod_running_row", &row);
}

#[test]
fn pod_pending_imagepull_row() {
    let pod: Pod = fixture_json("k8s/pod_pending_imagepull.json");
    let row = ferrisscope_kube_ext::kinds::pods::PodSpec::project(&pod);
    // Spot-check the surface the UI cares about for triage.
    assert_eq!(row["phase"], "Pending");
    assert_eq!(row["ready"], "0/1");
    snap("pod_pending_imagepull_row", &row);
}

// ── ConfigMaps ─────────────────────────────────────────────────────────────

#[test]
fn configmap_row_counts_data_and_binary_keys() {
    let cm: ConfigMap = fixture_json("k8s/configmap.json");
    let row = ferrisscope_kube_ext::kinds::config_maps::ConfigMapSpec::project(&cm);
    // 2 data + 1 binary = 3.
    assert_eq!(row["keys"], 3);
    snap("configmap_row", &row);
}

#[test]
fn configmap_detail_with_data_and_binary() {
    let cm: ConfigMap = fixture_json("k8s/configmap.json");
    let detail = ferrisscope_kube_ext::kinds::config_maps::project_detail(&cm);
    snap("configmap_detail", &detail);
}

#[test]
fn configmap_immutable_detail_flags_immutable() {
    let cm: ConfigMap = fixture_json("k8s/configmap_immutable.json");
    let detail = ferrisscope_kube_ext::kinds::config_maps::project_detail(&cm);
    assert_eq!(detail["immutable"], true);
    snap("configmap_immutable_detail", &detail);
}

// ── Secrets ────────────────────────────────────────────────────────────────

#[test]
fn secret_tls_row_carries_type_and_keys() {
    let s: Secret = fixture_json("k8s/secret_tls.json");
    let row = ferrisscope_kube_ext::kinds::secrets::SecretSpec::project(&s);
    assert_eq!(row["type"], "kubernetes.io/tls");
    assert_eq!(row["keys"], 2);
    snap("secret_tls_row", &row);
}

#[test]
fn secret_tls_detail_emits_base64_values() {
    let s: Secret = fixture_json("k8s/secret_tls.json");
    let detail = ferrisscope_kube_ext::kinds::secrets::project_detail(&s);
    // The UI keeps secrets masked; the projection still ships base64 so
    // an explicit "reveal" doesn't require a second round-trip.
    assert!(detail["data"].as_array().unwrap().len() == 2);
    snap("secret_tls_detail", &detail);
}

// ── Services ──────────────────────────────────────────────────────────────

#[test]
fn service_clusterip_row_uses_em_dash_for_external_ip() {
    let svc: Service = fixture_json("k8s/service_clusterip.json");
    let row = ferrisscope_kube_ext::kinds::services::ServiceSpec::project(&svc);
    // ClusterIP without spec.externalIPs renders as em dash.
    assert_eq!(row["external_ip"], "—");
    snap("service_clusterip_row", &row);
}

#[test]
fn service_loadbalancer_row_prefers_hostname_over_ip() {
    let svc: Service = fixture_json("k8s/service_loadbalancer.json");
    let row = ferrisscope_kube_ext::kinds::services::ServiceSpec::project(&svc);
    // LB ingress has both hostname + ip; hostname wins.
    assert_eq!(row["external_ip"], "lb-1.example.com");
    snap("service_loadbalancer_row", &row);
}

#[test]
fn service_externalname_row_shows_dns_target() {
    let svc: Service = fixture_json("k8s/service_externalname.json");
    let row = ferrisscope_kube_ext::kinds::services::ServiceSpec::project(&svc);
    assert_eq!(row["external_ip"], "db.example.com");
    snap("service_externalname_row", &row);
}

#[test]
fn service_loadbalancer_detail_includes_lb_ingress() {
    let svc: Service = fixture_json("k8s/service_loadbalancer.json");
    let detail = ferrisscope_kube_ext::kinds::services::project_detail(&svc);
    let lb = detail["load_balancer_ingress"].as_array().unwrap();
    assert_eq!(lb.len(), 1);
    snap("service_loadbalancer_detail", &detail);
}

// ── Deployments ────────────────────────────────────────────────────────────

#[test]
fn deployment_row_format_matches_kubectl() {
    let d: Deployment = fixture_json("k8s/deployment.json");
    let row = ferrisscope_kube_ext::kinds::deployments::DeploymentSpec::project(&d);
    // 4/5 ready, 5 up-to-date, 4 available — kubectl get deploy semantics.
    assert_eq!(row["ready"], "4/5");
    assert_eq!(row["up_to_date"], 5);
    assert_eq!(row["available"], 4);
    snap("deployment_row", &row);
}

#[test]
fn deployment_detail_carries_strategy_replicas_conditions() {
    let d: Deployment = fixture_json("k8s/deployment.json");
    let detail = ferrisscope_kube_ext::kinds::deployments::project_detail(&d);
    assert_eq!(detail["replicas"]["desired"], 5);
    assert_eq!(detail["strategy"]["type"], "RollingUpdate");
    assert_eq!(detail["strategy"]["max_surge"], "25%");
    assert_eq!(detail["conditions"].as_array().unwrap().len(), 2);
    snap("deployment_detail", &detail);
}

// ── Jobs ───────────────────────────────────────────────────────────────────

#[test]
fn job_succeeded_row_and_detail() {
    let j: Job = fixture_json("k8s/job_succeeded.json");
    let row = ferrisscope_kube_ext::kinds::jobs::JobSpec::project(&j);
    assert_eq!(row["completions"], "1/1");
    assert_eq!(row["phase"], "Succeeded");
    snap("job_succeeded_row", &row);

    let detail = ferrisscope_kube_ext::kinds::jobs::project_detail(&j);
    snap("job_succeeded_detail", &detail);
}

// ── Nodes ──────────────────────────────────────────────────────────────────

#[test]
fn node_ready_row_pulls_role_and_version() {
    let n: Node = fixture_json("k8s/node_ready.json");
    let row = ferrisscope_kube_ext::kinds::nodes::NodeSpec::project(&n);
    assert_eq!(row["roles"], "worker");
    assert_eq!(row["version"], "v1.31.4");
    assert_eq!(row["phase"], "Ready");
    assert_eq!(row["taints"], 1);
    snap("node_ready_row", &row);
}

#[test]
fn node_cordoned_phase_reports_scheduling_disabled() {
    let n: Node = fixture_json("k8s/node_cordoned.json");
    let row = ferrisscope_kube_ext::kinds::nodes::NodeSpec::project(&n);
    assert_eq!(
        row["phase"], "SchedulingDisabled",
        "cordoned + Ready=True must surface as SchedulingDisabled"
    );
    snap("node_cordoned_row", &row);
}

// ── Well-known: Gateway API ───────────────────────────────────────────────

fn dyn_obj(rel: &str) -> DynamicObject {
    fixture_json(rel)
}

#[test]
fn well_known_lookup_by_gk_finds_gateway_kinds() {
    use ferrisscope_kube_ext::well_known::lookup_by_gk;
    let group = "gateway.networking.k8s.io";
    let kinds = [
        "GatewayClass",
        "Gateway",
        "HTTPRoute",
        "GRPCRoute",
        "ReferenceGrant",
    ];
    for k in kinds {
        assert!(lookup_by_gk(group, k).is_some(), "missing override for {k}");
    }
    // Negative — random kind must not match.
    assert!(lookup_by_gk(group, "MysteryKind").is_none());
    assert!(lookup_by_gk("other.group", "Gateway").is_none());
}

#[test]
fn well_known_id_round_trips() {
    use ferrisscope_kube_ext::well_known::{make_id, parse_id};
    let id = make_id(
        "httproutes",
        "gateway.networking.k8s.io",
        "v1beta1",
        "httproutes",
        "HTTPRoute",
        true,
    );
    assert!(id.starts_with("wkcrd:"));
    let parsed = parse_id(&id).unwrap();
    assert_eq!(parsed.short_id, "httproutes");
    assert_eq!(parsed.group, "gateway.networking.k8s.io");
    assert_eq!(parsed.version, "v1beta1");
    assert_eq!(parsed.plural, "httproutes");
    assert_eq!(parsed.kind, "HTTPRoute");
    assert!(parsed.namespaced);
    // Cluster-scoped variant.
    let cid = make_id(
        "gatewayclasses",
        "gateway.networking.k8s.io",
        "v1",
        "gatewayclasses",
        "GatewayClass",
        false,
    );
    assert!(!parse_id(&cid).unwrap().namespaced);
    // Garbage doesn't parse.
    assert!(parse_id("not-a-wkcrd").is_none());
    assert!(parse_id("wkcrd:too|few|parts").is_none());
}

#[test]
fn gatewayclass_projection_via_override() {
    use ferrisscope_kube_ext::well_known::lookup_by_gk;
    let obj = dyn_obj("well_known/gateway_api/gatewayclass.json");
    let ovr = lookup_by_gk("gateway.networking.k8s.io", "GatewayClass").unwrap();
    let row = (ovr.project)(&obj);
    snap("gatewayclass_row", &row);
    let detail = (ovr.project_detail)(&obj);
    snap("gatewayclass_detail", &detail);
}

#[test]
fn gateway_projection_via_override() {
    use ferrisscope_kube_ext::well_known::lookup_by_gk;
    let obj = dyn_obj("well_known/gateway_api/gateway.json");
    let ovr = lookup_by_gk("gateway.networking.k8s.io", "Gateway").unwrap();
    let row = (ovr.project)(&obj);
    snap("gateway_row", &row);
    let detail = (ovr.project_detail)(&obj);
    snap("gateway_detail", &detail);
}

#[test]
fn httproute_projection_via_override() {
    use ferrisscope_kube_ext::well_known::lookup_by_gk;
    let obj = dyn_obj("well_known/gateway_api/httproute.json");
    let ovr = lookup_by_gk("gateway.networking.k8s.io", "HTTPRoute").unwrap();
    let row = (ovr.project)(&obj);
    snap("httproute_row", &row);
    let detail = (ovr.project_detail)(&obj);
    snap("httproute_detail", &detail);
}

// ── Workload variants ──────────────────────────────────────────────────────

#[test]
fn daemonset_row_and_detail() {
    let ds: DaemonSet = fixture_json("k8s/daemonset.json");
    let row = ferrisscope_kube_ext::kinds::daemon_sets::DaemonSetSpec::project(&ds);
    snap("daemonset_row", &row);
    let detail = ferrisscope_kube_ext::kinds::daemon_sets::project_detail(&ds);
    snap("daemonset_detail", &detail);
}

#[test]
fn statefulset_row_and_detail() {
    let ss: StatefulSet = fixture_json("k8s/statefulset.json");
    let row = ferrisscope_kube_ext::kinds::stateful_sets::StatefulSetSpec::project(&ss);
    snap("statefulset_row", &row);
    let detail = ferrisscope_kube_ext::kinds::stateful_sets::project_detail(&ss);
    snap("statefulset_detail", &detail);
}

#[test]
fn replicaset_row_keeps_owner_link() {
    let rs: ReplicaSet = fixture_json("k8s/replicaset.json");
    let row = ferrisscope_kube_ext::kinds::replica_sets::ReplicaSetSpec::project(&rs);
    snap("replicaset_row", &row);
    let detail = ferrisscope_kube_ext::kinds::replica_sets::project_detail(&rs);
    // Owner ref should round-trip through the meta projection.
    assert_eq!(detail["meta"]["controlled_by"]["kind"], "Deployment");
    assert_eq!(detail["meta"]["controlled_by"]["name"], "web");
    snap("replicaset_detail", &detail);
}

#[test]
fn cronjob_row_and_detail_carry_schedule() {
    let cj: CronJob = fixture_json("k8s/cronjob.json");
    let row = ferrisscope_kube_ext::kinds::cron_jobs::CronJobSpec::project(&cj);
    assert_eq!(row["schedule"], "0 2 * * *");
    snap("cronjob_row", &row);
    let detail = ferrisscope_kube_ext::kinds::cron_jobs::project_detail(&cj);
    assert_eq!(detail["concurrency_policy"], "Forbid");
    snap("cronjob_detail", &detail);
}

// ── Storage ────────────────────────────────────────────────────────────────

#[test]
fn pvc_bound_row_and_detail() {
    let pvc: PersistentVolumeClaim = fixture_json("k8s/pvc_bound.json");
    let row =
        ferrisscope_kube_ext::kinds::persistent_volume_claims::PersistentVolumeClaimSpec::project(
            &pvc,
        );
    assert_eq!(row["phase"], "Bound");
    snap("pvc_bound_row", &row);
    let detail = ferrisscope_kube_ext::kinds::persistent_volume_claims::project_detail(&pvc);
    snap("pvc_bound_detail", &detail);
}

#[test]
fn pv_available_row_and_detail() {
    let pv: PersistentVolume = fixture_json("k8s/pv_available.json");
    let row = ferrisscope_kube_ext::kinds::persistent_volumes::PersistentVolumeSpec::project(&pv);
    assert_eq!(row["phase"], "Available");
    snap("pv_available_row", &row);
    let detail = ferrisscope_kube_ext::kinds::persistent_volumes::project_detail(&pv);
    snap("pv_available_detail", &detail);
}

// ── Network ────────────────────────────────────────────────────────────────

#[test]
fn ingress_row_and_detail() {
    let ing: Ingress = fixture_json("k8s/ingress.json");
    let row = ferrisscope_kube_ext::kinds::ingresses::IngressSpec::project(&ing);
    snap("ingress_row", &row);
    let detail = ferrisscope_kube_ext::kinds::ingresses::project_detail(&ing);
    snap("ingress_detail", &detail);
}

#[test]
fn networkpolicy_row_and_detail() {
    let np: NetworkPolicy = fixture_json("k8s/networkpolicy.json");
    let row = ferrisscope_kube_ext::kinds::network_policies::NetworkPolicySpec::project(&np);
    snap("networkpolicy_row", &row);
    let detail = ferrisscope_kube_ext::kinds::network_policies::project_detail(&np);
    snap("networkpolicy_detail", &detail);
}

#[test]
fn endpointslice_row_aggregates_endpoint_state() {
    let eps: EndpointSlice = fixture_json("k8s/endpointslice.json");
    let row = ferrisscope_kube_ext::kinds::endpoint_slices::EndpointSliceSpec::project(&eps);
    snap("endpointslice_row", &row);
    let detail = ferrisscope_kube_ext::kinds::endpoint_slices::project_detail(&eps);
    snap("endpointslice_detail", &detail);
}

// ── Autoscaling + quota + limits ──────────────────────────────────────────

#[test]
fn hpa_row_and_detail() {
    let hpa: HorizontalPodAutoscaler = fixture_json("k8s/hpa.json");
    let row =
        ferrisscope_kube_ext::kinds::horizontal_pod_autoscalers::HorizontalPodAutoscalerSpec::project(
            &hpa,
        );
    snap("hpa_row", &row);
    let detail = ferrisscope_kube_ext::kinds::horizontal_pod_autoscalers::project_detail(&hpa);
    snap("hpa_detail", &detail);
}

#[test]
fn resourcequota_row_and_detail_show_used_vs_hard() {
    let rq: ResourceQuota = fixture_json("k8s/resourcequota.json");
    let row = ferrisscope_kube_ext::kinds::resource_quotas::ResourceQuotaSpec::project(&rq);
    snap("resourcequota_row", &row);
    let detail = ferrisscope_kube_ext::kinds::resource_quotas::project_detail(&rq);
    snap("resourcequota_detail", &detail);
}

#[test]
fn limitrange_row_and_detail() {
    let lr: LimitRange = fixture_json("k8s/limitrange.json");
    let row = ferrisscope_kube_ext::kinds::limit_ranges::LimitRangeSpec::project(&lr);
    snap("limitrange_row", &row);
    let detail = ferrisscope_kube_ext::kinds::limit_ranges::project_detail(&lr);
    snap("limitrange_detail", &detail);
}

// ── Tolerance: shape drift must not panic ─────────────────────────────────
//
// Well-known projections must be total — a missing/typo'd field should
// degrade to null/empty rather than panic. Feed an essentially empty
// DynamicObject through every override and verify it returns *something*.

#[test]
fn well_known_projections_tolerate_empty_object() {
    use ferrisscope_kube_ext::well_known::registry;
    let obj: DynamicObject = serde_json::from_str(
        r#"{
            "apiVersion": "gateway.networking.k8s.io/v1",
            "kind": "Anything",
            "metadata": {}
        }"#,
    )
    .unwrap();
    for ovr in registry() {
        let row = (ovr.project)(&obj);
        let detail = (ovr.project_detail)(&obj);
        // Shape can be {} or {...}, but it must be an object, not panic.
        assert!(row.is_object(), "{}: row not object", ovr.short_id);
        assert!(detail.is_object(), "{}: detail not object", ovr.short_id);
    }
}
