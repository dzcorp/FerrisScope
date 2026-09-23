use kube::api::DynamicObject;
use serde_json::{json, Value};

use super::gitops::{
    action, array, columns, condition, detail, fields, records, row, text, Card, Detail, Field,
    Item, Resource, Section,
};
use super::WellKnownCrd;
use crate::registry::{Category, ColumnDef, ColumnKind};

const SOURCE: &str = "source.toolkit.fluxcd.io";
const KUSTOMIZE: &str = "kustomize.toolkit.fluxcd.io";
const HELM: &str = "helm.toolkit.fluxcd.io";

pub static OVERRIDES: &[WellKnownCrd] = &[
    WellKnownCrd {
        short_id: "flux_kustomizations",
        group: KUSTOMIZE,
        kind: "Kustomization",
        category: Category::Apps,
        columns: kustomization_columns,
        project: project_kustomization,
        project_detail: detail_kustomization,
    },
    WellKnownCrd {
        short_id: "flux_helmreleases",
        group: HELM,
        kind: "HelmRelease",
        category: Category::Apps,
        columns: helmrelease_columns,
        project: project_helmrelease,
        project_detail: detail_helmrelease,
    },
    WellKnownCrd {
        short_id: "flux_gitrepositories",
        group: SOURCE,
        kind: "GitRepository",
        category: Category::Apps,
        columns: source_columns,
        project: project_source,
        project_detail: detail_source,
    },
    WellKnownCrd {
        short_id: "flux_ocirepositories",
        group: SOURCE,
        kind: "OCIRepository",
        category: Category::Apps,
        columns: source_columns,
        project: project_source,
        project_detail: detail_source,
    },
    WellKnownCrd {
        short_id: "flux_helmrepositories",
        group: SOURCE,
        kind: "HelmRepository",
        category: Category::Apps,
        columns: source_columns,
        project: project_source,
        project_detail: detail_source,
    },
    WellKnownCrd {
        short_id: "flux_buckets",
        group: SOURCE,
        kind: "Bucket",
        category: Category::Apps,
        columns: source_columns,
        project: project_source,
        project_detail: detail_source,
    },
    WellKnownCrd {
        short_id: "flux_helmcharts",
        group: SOURCE,
        kind: "HelmChart",
        category: Category::Apps,
        columns: chart_columns,
        project: project_chart,
        project_detail: detail_source,
    },
];

fn kustomization_columns() -> Vec<ColumnDef> {
    columns(&[
        ("phase", "Status", ColumnKind::Phase),
        ("source", "Source", ColumnKind::Text),
        ("path", "Path", ColumnKind::Text),
        ("revision", "Applied revision", ColumnKind::Text),
    ])
}

fn helmrelease_columns() -> Vec<ColumnDef> {
    columns(&[
        ("phase", "Status", ColumnKind::Phase),
        ("chart", "Chart / source", ColumnKind::Text),
        ("release", "Release", ColumnKind::Text),
        ("revision", "Attempted revision", ColumnKind::Text),
    ])
}

fn source_columns() -> Vec<ColumnDef> {
    columns(&[
        ("phase", "Status", ColumnKind::Phase),
        ("url", "URL / endpoint", ColumnKind::Text),
        ("reference", "Requested ref", ColumnKind::Text),
        ("revision", "Artifact revision", ColumnKind::Text),
    ])
}

fn chart_columns() -> Vec<ColumnDef> {
    columns(&[
        ("phase", "Status", ColumnKind::Phase),
        ("chart", "Chart", ColumnKind::Text),
        ("source", "Source", ColumnKind::Text),
        ("revision", "Artifact revision", ColumnKind::Text),
    ])
}

fn static_helm_repository(obj: &DynamicObject) -> bool {
    obj.types
        .as_ref()
        .is_some_and(|t| t.kind == "HelmRepository")
        && obj.data.pointer("/spec/type").and_then(Value::as_str) == Some("oci")
}

fn phase(obj: &DynamicObject) -> &'static str {
    if obj.metadata.deletion_timestamp.is_some() {
        return "Terminating";
    }
    if static_helm_repository(obj) {
        return "Static";
    }
    if obj.data.pointer("/spec/suspend").and_then(Value::as_bool) == Some(true) {
        return "Suspended";
    }
    let cs = array(&obj.data, "/status/conditions");
    let current = |c: &Value| {
        obj.metadata.generation.is_none_or(|generation| {
            c["observedGeneration"]
                .as_i64()
                .or_else(|| {
                    obj.data
                        .pointer("/status/observedGeneration")
                        .and_then(Value::as_i64)
                })
                .is_some_and(|observed| observed >= generation)
        })
    };
    for (kind, result) in [("Stalled", "Stalled"), ("Reconciling", "Reconciling")] {
        if cs
            .iter()
            .any(|c| c["type"] == kind && c["status"] == "True" && current(c))
        {
            return result;
        }
    }
    let Some(ready) = cs.iter().find(|c| c["type"] == "Ready") else {
        return "Unknown";
    };
    if obj.metadata.generation.is_some()
        && ready["observedGeneration"]
            .as_i64()
            .or_else(|| {
                obj.data
                    .pointer("/status/observedGeneration")
                    .and_then(Value::as_i64)
            })
            .is_none()
    {
        return "Unknown";
    }
    if !current(ready) {
        return "Updating";
    }
    match ready["status"].as_str() {
        Some("True") => "Ready",
        Some("False") => "NotReady",
        _ => "Unknown",
    }
}

fn project_kustomization(obj: &DynamicObject) -> Value {
    row(
        obj,
        json!({"phase": phase(obj), "source": text(&obj.data, "/spec/sourceRef/name"), "path": text(&obj.data, "/spec/path"), "revision": text(&obj.data, "/status/lastAppliedRevision")}),
    )
}

fn project_helmrelease(obj: &DynamicObject) -> Value {
    row(
        obj,
        json!({"phase": phase(obj), "chart": text(&obj.data, "/spec/chart/spec/chart").or_else(|| text(&obj.data, "/spec/chartRef/name")), "release": text(&obj.data, "/spec/releaseName"), "revision": text(&obj.data, "/status/lastAttemptedRevision")}),
    )
}

fn project_source(obj: &DynamicObject) -> Value {
    let requested_ref = ["commit", "digest", "name", "semver", "tag", "branch"]
        .iter()
        .find_map(|key| {
            obj.data
                .pointer("/spec/ref")
                .and_then(|r| r.get(key))
                .and_then(Value::as_str)
        });
    row(
        obj,
        json!({"phase": phase(obj), "url": text(&obj.data, "/spec/url").or_else(|| text(&obj.data, "/spec/endpoint")), "reference": requested_ref, "revision": text(&obj.data, "/status/artifact/revision")}),
    )
}

fn project_chart(obj: &DynamicObject) -> Value {
    row(
        obj,
        json!({"phase": phase(obj), "chart": text(&obj.data, "/spec/chart"), "source": text(&obj.data, "/spec/sourceRef/name"), "revision": text(&obj.data, "/status/artifact/revision")}),
    )
}

fn reference(
    obj: &DynamicObject,
    label: &str,
    path: &str,
    group: &str,
    default_kind: &str,
) -> Field {
    let r = obj.data.pointer(path).unwrap_or(&Value::Null);
    Field::reference(
        label,
        group,
        r["kind"].as_str().unwrap_or(default_kind),
        r["namespace"]
            .as_str()
            .or(obj.metadata.namespace.as_deref()),
        r["name"].as_str(),
        true,
    )
}

fn actions(obj: &DynamicObject) -> Vec<Value> {
    if static_helm_repository(obj) {
        return vec![];
    }
    let suspended = obj.data.pointer("/spec/suspend").and_then(Value::as_bool) == Some(true);
    // Flux compares this opaque token to lastHandledReconcileAt. A successful
    // patch advances resourceVersion, making the next request distinct.
    let nonce = format!(
        "ferrisscope:{}",
        obj.metadata.resource_version.as_deref().unwrap_or_default()
    );
    vec![
        action("reconcile", "Reconcile", json!({"metadata":{"annotations":{"reconcile.fluxcd.io/requestedAt":nonce}}}), Some("Request reconciliation now? Flux may apply changes, upgrade workloads, or prune resources according to this object's policy."), if suspended { Some("Resume before requesting reconciliation.") } else { None }),
        action(if suspended { "resume" } else { "suspend" }, if suspended { "Resume" } else { "Suspend" }, json!({"spec":{"suspend":!suspended}}), Some(if suspended { "Resume reconciliation? Flux may immediately apply pending changes and prune resources according to its policy." } else { "Suspend reconciliation? Existing workloads keep running, but changes and drift will no longer be reconciled. A parent GitOps controller may restore this field." }), None),
    ]
}

/// `revision` is the applied/produced revision; `attempted` is shown only
/// when it differs, since that gap is what an operator is looking for.
fn cards(
    obj: &DynamicObject,
    revision: Option<String>,
    attempted: Option<String>,
    at: Option<String>,
) -> Vec<Card> {
    let d = &obj.data;
    let state = phase(obj);
    let explain = condition(obj, "Stalled")
        .filter(|c| c["status"] == "True")
        .or_else(|| condition(obj, "Ready"));
    let suspended = d.pointer("/spec/suspend").and_then(Value::as_bool) == Some(true);
    vec![
        Card {
            status: Some(state.into()),
            caption: explain.and_then(|c| text(c, "/message")),
            at: condition(obj, "Ready").and_then(|c| text(c, "/lastTransitionTime")),
            ..Card::new("Status")
        },
        Card {
            caption: attempted
                .filter(|a| revision.as_ref() != Some(a))
                .map(|a| format!("Attempted {a}")),
            value: revision,
            at,
            ..Card::new("Revision")
        },
        Card {
            value: text(d, "/spec/interval"),
            caption: if suspended {
                Some("Suspended — changes are not reconciled.".into())
            } else {
                text(d, "/spec/timeout").map(|t| format!("Timeout {t}"))
            },
            ..Card::new("Interval")
        },
    ]
}

/// The object `flux reconcile --with-source` reconciles first.
fn upstream_source(obj: &DynamicObject) -> Option<Value> {
    let d = &obj.data;
    let kind = obj.types.as_ref().map(|t| t.kind.as_str());
    let (r, default_kind) = match kind {
        Some("Kustomization") => (d.pointer("/spec/sourceRef"), "GitRepository"),
        Some("HelmChart") => (d.pointer("/spec/sourceRef"), "HelmRepository"),
        Some("HelmRelease") => match d.pointer("/spec/chartRef").filter(|r| r.is_object()) {
            Some(r) => (Some(r), "OCIRepository"),
            // The generated HelmChart only rebuilds from its source's stored
            // artifact; `flux reconcile hr --with-source` fetches that source.
            None => (d.pointer("/spec/chart/spec/sourceRef"), "HelmRepository"),
        },
        _ => return None,
    };
    let r = r?;
    let name = r["name"].as_str().filter(|n| !n.is_empty())?;
    let kind = r["kind"].as_str().unwrap_or(default_kind);
    let group = r["apiVersion"]
        .as_str()
        .and_then(|a| a.split_once('/'))
        .map_or(SOURCE, |(g, _)| g);
    Some(json!({
        "group": group,
        "kind": kind,
        "namespace": r["namespace"].as_str().or(obj.metadata.namespace.as_deref()),
        "name": name,
    }))
}

fn helm_history(d: &Value) -> Vec<Value> {
    let mut history: Vec<&Value> = array(d, "/status/history")
        .iter()
        .filter(|h| h.is_object())
        .collect();
    history.sort_by_key(|h| std::cmp::Reverse(h["version"].as_i64().unwrap_or(i64::MIN)));
    history
        .into_iter()
        .map(|h| {
            json!({
                "version": h["version"].as_i64(),
                "status": text(h, "/status"),
                "chart": text(h, "/chartName"),
                "chart_version": text(h, "/chartVersion"),
                "app_version": text(h, "/appVersion"),
                "action": text(h, "/action"),
                "deployed_at": text(h, "/lastDeployed").or_else(|| text(h, "/firstDeployed")),
                "first_deployed": text(h, "/firstDeployed"),
                "digest": text(h, "/digest"),
                "config_digest": text(h, "/configDigest"),
            })
        })
        .collect()
}

fn extras(obj: &DynamicObject, history: Vec<Value>) -> Value {
    let is_release = obj.types.as_ref().is_some_and(|t| t.kind == "HelmRelease");
    json!({
        "source": upstream_source(obj),
        "force_reset": is_release,
        "suspended": obj.data.pointer("/spec/suspend").and_then(Value::as_bool) == Some(true),
        "history": history,
        "failures": obj.data.pointer("/status/failures").and_then(Value::as_i64),
    })
}

fn common(obj: &DynamicObject) -> Vec<Section> {
    let status = fields(
        &obj.data,
        &[
            ("Observed generation", "/status/observedGeneration"),
            ("Last applied revision", "/status/lastAppliedRevision"),
            ("Last attempted revision", "/status/lastAttemptedRevision"),
            ("Last handled reconcile", "/status/lastHandledReconcileAt"),
            ("Last handled force", "/status/lastHandledForceAt"),
            ("Last handled reset", "/status/lastHandledResetAt"),
        ],
    );
    let mut reconciliation = fields(
        &obj.data,
        &[
            ("Suspended", "/spec/suspend"),
            ("Interval", "/spec/interval"),
            ("Retry interval", "/spec/retryInterval"),
            ("Timeout", "/spec/timeout"),
        ],
    );
    reconciliation.push(Field::reference(
        "Service account",
        "",
        "ServiceAccount",
        obj.metadata.namespace.as_deref(),
        obj.data
            .pointer("/spec/serviceAccountName")
            .and_then(Value::as_str),
        obj.data
            .pointer("/spec/kubeConfig")
            .is_none_or(Value::is_null),
    ));
    reconciliation.push(reference(
        obj,
        "Remote kubeconfig secret",
        "/spec/kubeConfig/secretRef",
        "",
        "Secret",
    ));
    reconciliation.push(reference(
        obj,
        "Remote kubeconfig config map",
        "/spec/kubeConfig/configMapRef",
        "",
        "ConfigMap",
    ));
    vec![
        Section::fields("Controller configuration", reconciliation),
        Section::fields("Reconciliation", status),
    ]
}

fn dependencies(obj: &DynamicObject, group: &str, kind: &str) -> Section {
    Section::items(
        "Dependencies",
        array(&obj.data, "/spec/dependsOn")
            .iter()
            .map(|r| Item {
                title: r["name"].as_str().unwrap_or("Dependency").into(),
                fields: vec![
                    Field::reference(
                        "Dependency",
                        group,
                        kind,
                        r["namespace"]
                            .as_str()
                            .or(obj.metadata.namespace.as_deref()),
                        r["name"].as_str(),
                        true,
                    ),
                    Field::text("Ready expression", text(r, "/readyExpr")),
                ],
            })
            .collect(),
    )
}

fn detail_kustomization(obj: &DynamicObject) -> Value {
    let d = &obj.data;
    let local = d.pointer("/spec/kubeConfig").is_none_or(Value::is_null);
    let mut sections = common(obj);
    let mut build = vec![reference(
        obj,
        "Source",
        "/spec/sourceRef",
        SOURCE,
        "Unknown",
    )];
    build.extend(fields(
        d,
        &[
            ("Path", "/spec/path"),
            ("Target namespace", "/spec/targetNamespace"),
            ("Prune", "/spec/prune"),
            ("Deletion policy", "/spec/deletionPolicy"),
            ("Wait for health", "/spec/wait"),
            ("Force recreation", "/spec/force"),
            ("Name prefix", "/spec/namePrefix"),
            ("Name suffix", "/spec/nameSuffix"),
            ("Images", "/spec/images"),
            ("Components", "/spec/components"),
            ("Patches", "/spec/patches"),
            ("Common metadata", "/spec/commonMetadata"),
            ("Post-build substitutions", "/spec/postBuild/substitute"),
        ],
    ));
    sections.push(Section::fields("Build and apply", build));
    sections.push(dependencies(obj, KUSTOMIZE, "Kustomization"));
    sections.push(Section::items(
        "Substitution sources",
        array(d, "/spec/postBuild/substituteFrom")
            .iter()
            .map(|r| Item {
                title: r["name"].as_str().unwrap_or("Source").into(),
                fields: vec![
                    Field::reference(
                        "Source",
                        "",
                        r["kind"].as_str().unwrap_or("Unknown"),
                        obj.metadata.namespace.as_deref(),
                        r["name"].as_str(),
                        true,
                    ),
                    Field::text("Optional", r["optional"].as_bool().map(|v| v.to_string())),
                ],
            })
            .collect(),
    ));
    sections.push(Section::fields(
        "Decryption",
        vec![
            Field::text("Provider", text(d, "/spec/decryption/provider")),
            reference(obj, "Secret", "/spec/decryption/secretRef", "", "Secret"),
        ],
    ));
    sections.push(Section::items(
        "Health checks",
        array(d, "/spec/healthChecks")
            .iter()
            .map(|r| {
                let api_version = r["apiVersion"].as_str().unwrap_or_default();
                let group = api_version.split_once('/').map_or("", |(g, _)| g);
                Item {
                    title: r["name"].as_str().unwrap_or("Health check").into(),
                    fields: vec![
                        Field::reference(
                            "Resource",
                            group,
                            r["kind"].as_str().unwrap_or("Unknown"),
                            r["namespace"].as_str(),
                            r["name"].as_str(),
                            local,
                        ),
                        Field::text("API version", text(r, "/apiVersion")),
                    ],
                }
            })
            .collect(),
    ));
    sections.push(Section::items(
        "Health expressions",
        records(
            d,
            "/spec/healthCheckExprs",
            "Expression",
            &["/kind"],
            &[
                ("API version", "/apiVersion"),
                ("Kind", "/kind"),
                ("Current", "/current"),
                ("In progress", "/inProgress"),
                ("Failed", "/failed"),
            ],
        ),
    ));
    detail(
        obj,
        Detail {
            cards: cards(
                obj,
                text(d, "/status/lastAppliedRevision"),
                text(d, "/status/lastAttemptedRevision"),
                None,
            ),
            sections,
            resources: Some(inventory(d, local).unwrap_or_default()),
            actions: actions(obj),
            notice: Some(if local {
                "Flux owns the applied resources. Reconcile can apply and prune according to policy; edit Git for lasting changes."
            } else {
                "This Kustomization uses a remote kubeconfig. Inventory references are copy-only to avoid opening resources on the control cluster."
            }),
            argo: None,
            flux: Some(extras(obj, vec![])),
        },
    )
}

/// Parses cli-utils object ids: `<namespace>_<name>_<group>_<kind>`, where
/// namespace and group may be empty and RBAC names encode `:` as `__`.
fn inventory_id(id: &str) -> Option<(Option<String>, String, String, String)> {
    let (namespace, rest) = id.split_once('_')?;
    let (rest, kind) = rest.rsplit_once('_')?;
    let (name, group) = rest.rsplit_once('_')?;
    if name.is_empty() || kind.is_empty() {
        return None;
    }
    let name = if group == "rbac.authorization.k8s.io" {
        name.replace("__", ":")
    } else {
        name.into()
    };
    Some((
        (!namespace.is_empty()).then(|| namespace.into()),
        name,
        group.into(),
        kind.into(),
    ))
}

/// `None` when the controller reports no inventory (older helm-controller).
fn inventory(d: &Value, local: bool) -> Option<Vec<Resource>> {
    let entries = d.pointer("/status/inventory/entries")?.as_array()?;
    Some(
        entries
            .iter()
            .filter_map(|r| {
                let (namespace, name, group, kind) = inventory_id(r["id"].as_str()?)?;
                Some(Resource {
                    group,
                    kind,
                    namespace,
                    name,
                    local,
                    sync: None,
                    health: None,
                    message: None,
                    prune: false,
                    version: text(r, "/v"),
                    sync_wave: None,
                    hook: false,
                })
            })
            .collect(),
    )
}

fn detail_helmrelease(obj: &DynamicObject) -> Value {
    let d = &obj.data;
    let mut sections = common(obj);
    let mut release = fields(
        d,
        &[
            ("Release name", "/spec/releaseName"),
            ("Target namespace", "/spec/targetNamespace"),
            ("Storage namespace", "/spec/storageNamespace"),
            ("History limit", "/spec/maxHistory"),
            ("Chart", "/spec/chart/spec/chart"),
            ("Version constraint", "/spec/chart/spec/version"),
            ("Chart interval", "/spec/chart/spec/interval"),
            ("Reconcile strategy", "/spec/chart/spec/reconcileStrategy"),
            ("Value files", "/spec/chart/spec/valuesFiles"),
        ],
    );
    release.push(reference(
        obj,
        "Chart template source",
        "/spec/chart/spec/sourceRef",
        SOURCE,
        "HelmRepository",
    ));
    release.push(reference(
        obj,
        "Chart reference",
        "/spec/chartRef",
        SOURCE,
        "Unknown",
    ));
    if let Some(chart) = d.pointer("/status/helmChart").and_then(Value::as_str) {
        if let Some((ns, name)) = chart.split_once('/') {
            release.push(Field::reference(
                "Generated HelmChart",
                SOURCE,
                "HelmChart",
                Some(ns),
                Some(name),
                true,
            ));
        }
    }
    sections.push(Section::fields("Helm release", release));
    sections.push(dependencies(obj, HELM, "HelmRelease"));
    sections.push(Section::items(
        "Values sources",
        array(d, "/spec/valuesFrom")
            .iter()
            .map(|r| {
                let mut f = vec![Field::reference(
                    "Source",
                    "",
                    r["kind"].as_str().unwrap_or("Secret"),
                    obj.metadata.namespace.as_deref(),
                    r["name"].as_str(),
                    true,
                )];
                f.extend(fields(
                    r,
                    &[
                        ("Values key", "/valuesKey"),
                        ("Target path", "/targetPath"),
                        ("Optional", "/optional"),
                    ],
                ));
                Item {
                    title: r["name"].as_str().unwrap_or("Values").into(),
                    fields: f,
                }
            })
            .collect(),
    ));
    sections.push(Section::fields(
        "Helm policies",
        fields(
            d,
            &[
                ("Install", "/spec/install"),
                ("Upgrade", "/spec/upgrade"),
                ("Rollback", "/spec/rollback"),
                ("Uninstall", "/spec/uninstall"),
                ("Tests", "/spec/test"),
                ("Drift detection", "/spec/driftDetection"),
                ("Post renderers", "/spec/postRenderers"),
            ],
        ),
    ));
    sections.push(Section::fields(
        "Attempts",
        fields(
            d,
            &[
                ("Failures", "/status/failures"),
                ("Install failures", "/status/installFailures"),
                ("Upgrade failures", "/status/upgradeFailures"),
                (
                    "Last attempted action",
                    "/status/lastAttemptedReleaseAction",
                ),
                (
                    "Last attempted config digest",
                    "/status/lastAttemptedConfigDigest",
                ),
                (
                    "Last attempted generation",
                    "/status/lastAttemptedGeneration",
                ),
                (
                    "Observed post-renderer digest",
                    "/status/observedPostRenderersDigest",
                ),
            ],
        ),
    ));
    // History order is not guaranteed; the controller sorts by `version`.
    let latest = array(d, "/status/history")
        .iter()
        .max_by_key(|h| h["version"].as_i64().unwrap_or(i64::MIN))
        .unwrap_or(&Value::Null);
    detail(
        obj,
        Detail {
            cards: cards(
                obj,
                text(latest, "/chartVersion").map(|v| match text(latest, "/chartName") {
                    Some(chart) => format!("{chart}@{v}"),
                    None => v,
                }),
                text(d, "/status/lastAttemptedRevision"),
                text(latest, "/lastDeployed"),
            ),
            sections,
            resources: inventory(d, d.pointer("/spec/kubeConfig").is_none_or(Value::is_null)),
            actions: actions(obj),
            notice: Some("This is Flux's HelmRelease custom resource, not the installed Helm release. Inline values remain in YAML; referenced Secret contents are not fetched here."),
            argo: None,
            flux: Some(extras(obj, helm_history(d))),
        },
    )
}

fn detail_source(obj: &DynamicObject) -> Value {
    let d = &obj.data;
    let mut sections = common(obj);
    let mut source = fields(
        d,
        &[
            ("URL", "/spec/url"),
            ("Repository type", "/spec/type"),
            ("Provider", "/spec/provider"),
            ("Reference", "/spec/ref"),
            ("Recurse submodules", "/spec/recurseSubmodules"),
            ("Ignore rules", "/spec/ignore"),
            ("Sparse checkout", "/spec/sparseCheckout"),
            ("Endpoint", "/spec/endpoint"),
            ("Bucket", "/spec/bucketName"),
            ("Region", "/spec/region"),
            ("Prefix", "/spec/prefix"),
            ("Insecure transport", "/spec/insecure"),
            ("Pass credentials", "/spec/passCredentials"),
            ("Layer selector", "/spec/layerSelector"),
            ("Chart", "/spec/chart"),
            ("Chart version", "/spec/version"),
            ("Reconcile strategy", "/spec/reconcileStrategy"),
            ("Values files", "/spec/valuesFiles"),
            (
                "Ignore missing values files",
                "/spec/ignoreMissingValuesFiles",
            ),
        ],
    );
    source.push(reference(
        obj,
        "Source",
        "/spec/sourceRef",
        SOURCE,
        "Unknown",
    ));
    sections.push(Section::fields(
        "Source configuration",
        source.into_iter().filter(|f| f.value.is_some()).collect(),
    ));
    sections.push(Section::fields(
        "Authentication and verification",
        vec![
            reference(obj, "Credentials secret", "/spec/secretRef", "", "Secret"),
            reference(
                obj,
                "Certificate secret",
                "/spec/certSecretRef",
                "",
                "Secret",
            ),
            reference(obj, "Proxy secret", "/spec/proxySecretRef", "", "Secret"),
            reference(
                obj,
                "Verification secret",
                "/spec/verify/secretRef",
                "",
                "Secret",
            ),
            Field::text(
                "Verification",
                text(d, "/spec/verify/mode").or_else(|| text(d, "/spec/verify/provider")),
            ),
        ],
    ));
    sections.push(Section::items(
        "Included repositories",
        array(d, "/spec/include")
            .iter()
            .map(|r| {
                let mut f = vec![Field::reference(
                    "Repository",
                    SOURCE,
                    "GitRepository",
                    obj.metadata.namespace.as_deref(),
                    r.pointer("/repository/name").and_then(Value::as_str),
                    true,
                )];
                f.extend(fields(
                    r,
                    &[("From path", "/fromPath"), ("To path", "/toPath")],
                ));
                Item {
                    title: r
                        .pointer("/repository/name")
                        .and_then(Value::as_str)
                        .unwrap_or("Include")
                        .into(),
                    fields: f,
                }
            })
            .collect(),
    ));
    sections.push(Section::fields(
        "Artifact",
        fields(
            d,
            &[
                ("Revision", "/status/artifact/revision"),
                ("Digest", "/status/artifact/digest"),
                ("Checksum", "/status/artifact/checksum"),
                ("URL", "/status/artifact/url"),
                ("Path", "/status/artifact/path"),
                ("Size", "/status/artifact/size"),
                ("Last update", "/status/artifact/lastUpdateTime"),
                ("Metadata", "/status/artifact/metadata"),
                ("Observed values files", "/status/observedValuesFiles"),
            ],
        ),
    ));
    detail(
        obj,
        Detail {
            cards: cards(
                obj,
                text(d, "/status/artifact/revision"),
                None,
                text(d, "/status/artifact/lastUpdateTime"),
            ),
            sections,
            resources: None,
            actions: actions(obj),
            notice: static_helm_repository(obj).then_some(
                "OCI HelmRepository is a static reference; Flux does not report reconciliation readiness for it. Use OCIRepository for artifact-based OCI sources.",
            ),
            argo: None,
            flux: Some(extras(obj, vec![])),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object() -> DynamicObject {
        serde_json::from_value(json!({"apiVersion":"kustomize.toolkit.fluxcd.io/v1","kind":"Kustomization","metadata":{"name":"apps","namespace":"flux-system","generation":2,"resourceVersion":"42"},"spec":{"sourceRef":{"kind":"GitRepository","name":"config"},"path":"./apps"},"status":{"conditions":[{"type":"Ready","status":"True","observedGeneration":2}],"inventory":{"entries":[{"id":"prod_web_apps_Deployment","v":"v1"}]}}})).unwrap()
    }

    #[test]
    fn readiness_does_not_hide_staleness_reconciliation_or_suspension() {
        let mut obj = object();
        assert_eq!(phase(&obj), "Ready");
        obj.metadata.generation = Some(3);
        assert_eq!(phase(&obj), "Updating");
        obj.data["status"]["conditions"] = json!([{"type":"Ready","status":"True","observedGeneration":3},{"type":"Reconciling","status":"True","observedGeneration":3}]);
        assert_eq!(phase(&obj), "Reconciling");
        obj.data["status"]["conditions"][1]["type"] = json!("Stalled");
        assert_eq!(phase(&obj), "Stalled");
        obj.data["spec"]["suspend"] = json!(true);
        assert_eq!(phase(&obj), "Suspended");
        assert!(actions(&obj)[0]["disabled_reason"].is_string());
        assert_eq!(actions(&obj)[1]["patch"], json!({"spec":{"suspend":false}}));
    }

    #[test]
    fn readiness_requires_observed_generation_and_respects_false_unknown() {
        let mut obj = object();
        obj.data["status"]["conditions"][0]["observedGeneration"] = Value::Null;
        assert_eq!(phase(&obj), "Unknown");
        obj.data["status"]["observedGeneration"] = json!(2);
        assert_eq!(phase(&obj), "Ready");
        obj.data["status"]["conditions"][0]["status"] = json!("False");
        assert_eq!(phase(&obj), "NotReady");
        obj.data["status"]["conditions"][0]["status"] = json!("Unknown");
        assert_eq!(phase(&obj), "Unknown");
        obj.data["spec"]["ref"] = json!({"branch":"main", "commit":"abc123"});
        assert_eq!(project_source(&obj)["reference"], "abc123");
    }

    #[test]
    fn references_preserve_groups_and_remote_inventory_is_not_navigable() {
        let mut obj = object();
        obj.data["spec"]["kubeConfig"] = json!({"secretRef":{"name":"remote"}});
        let detail = detail_kustomization(&obj);
        let sections = detail["sections"].as_array().unwrap();
        let build = sections
            .iter()
            .find(|s| s["title"] == "Build and apply")
            .unwrap();
        assert_eq!(build["fields"][0]["reference"]["group"], SOURCE);
        let r = &detail["resources"][0];
        assert_eq!(r["group"], "apps");
        assert_eq!(r["kind"], "Deployment");
        assert_eq!(r["name"], "web");
        assert_eq!(r["local"], false);
        assert_eq!(r["namespace"], "prod");
        assert_eq!(
            detail["actions"][0]["patch"],
            json!({"metadata":{"annotations":{"reconcile.fluxcd.io/requestedAt":"ferrisscope:42"}}})
        );
        assert!(project_kustomization(&obj).get("inventory").is_none());
    }

    #[test]
    fn all_kinds_tolerate_missing_and_malformed_data() {
        for spec in [
            json!(null),
            json!(false),
            json!({"sourceRef":42,"dependsOn":[null],"valuesFrom":[false],"include":[1]}),
        ] {
            let obj: DynamicObject = serde_json::from_value(json!({"metadata":{},"spec":spec,"status":{"conditions":[false],"history":[null],"inventory":{"entries":[4,{"id":"bad"}]}}})).unwrap();
            for wk in OVERRIDES {
                let row = (wk.project)(&obj);
                assert_eq!(row["phase"], "Unknown");
                assert!((wk.project_detail)(&obj)["sections"].is_array());
            }
        }
    }

    #[test]
    fn cards_explain_state_and_surface_attempted_revision_gaps() {
        let mut obj = object();
        obj.data["status"]["lastAppliedRevision"] = json!("main@sha1:aaa");
        obj.data["status"]["lastAttemptedRevision"] = json!("main@sha1:bbb");
        obj.data["status"]["conditions"] = json!([
            {"type":"Ready","status":"False","message":"build failed","observedGeneration":2,"lastTransitionTime":"2026-09-01T00:00:00Z"},
            {"type":"Stalled","status":"True","message":"kustomization path not found","observedGeneration":2}
        ]);
        let d = detail_kustomization(&obj);
        assert_eq!(d["cards"][0]["status"], "Stalled");
        assert_eq!(d["cards"][0]["caption"], "kustomization path not found");
        assert_eq!(d["cards"][0]["at"], "2026-09-01T00:00:00Z");
        assert_eq!(d["cards"][1]["value"], "main@sha1:aaa");
        assert_eq!(d["cards"][1]["caption"], "Attempted main@sha1:bbb");
        let conds = d["conditions"].as_array().unwrap();
        assert_eq!(conds[0]["negative"], false);
        assert_eq!(conds[1]["negative"], true);
        assert_eq!(d["actions"][0]["id"], "reconcile");
        assert_eq!(d["actions"][1]["id"], "suspend");
    }

    #[test]
    fn inventory_ids_follow_cli_utils_encoding() {
        let parse = |id| inventory_id(id);
        assert_eq!(
            parse("prod_web_apps_Deployment"),
            Some((
                Some("prod".into()),
                "web".into(),
                "apps".into(),
                "Deployment".into()
            ))
        );
        assert_eq!(
            parse("default_cfg__ConfigMap"),
            Some((
                Some("default".into()),
                "cfg".into(),
                String::new(),
                "ConfigMap".into()
            ))
        );
        assert_eq!(
            parse("_system__controller__foo_rbac.authorization.k8s.io_ClusterRole"),
            Some((
                None,
                "system:controller:foo".into(),
                "rbac.authorization.k8s.io".into(),
                "ClusterRole".into()
            ))
        );
        assert_eq!(parse("bad"), None);
        assert_eq!(parse("ns__apps_Deployment"), None);
    }

    #[test]
    fn helmrelease_uses_highest_history_version_and_optional_inventory() {
        let mut obj = object();
        obj.types.as_mut().unwrap().kind = "HelmRelease".into();
        obj.data["status"] = json!({"history":[
            {"version":3,"chartName":"web","chartVersion":"1.2.0","lastDeployed":"2026-09-02T00:00:00Z"},
            {"version":4,"chartName":"web","chartVersion":"1.3.0","lastDeployed":"2026-09-03T00:00:00Z"}
        ]});
        let d = detail_helmrelease(&obj);
        assert_eq!(d["cards"][1]["value"], "web@1.3.0");
        assert_eq!(d["cards"][1]["at"], "2026-09-03T00:00:00Z");
        assert!(d["resources"].is_null());
        obj.data["status"]["inventory"] =
            json!({"entries":[{"id":"prod_web_apps_Deployment","v":"v1"}]});
        assert_eq!(detail_helmrelease(&obj)["resources"][0]["name"], "web");
    }

    #[test]
    fn extras_expose_upstream_source_and_sorted_history() {
        let obj = object();
        let d = detail_kustomization(&obj);
        assert_eq!(
            d["flux"]["source"],
            json!({"group": SOURCE, "kind": "GitRepository", "namespace": "flux-system", "name": "config"})
        );
        assert_eq!(d["flux"]["force_reset"], false);
        let mut rel = object();
        rel.types.as_mut().unwrap().kind = "HelmRelease".into();
        rel.data["spec"] = json!({"chart":{"spec":{"chart":"web","sourceRef":{"kind":"HelmRepository","name":"bitnami"}}}});
        rel.data["status"] = json!({"helmChart":"flux-system/apps-web","history":[{"version":1,"status":"superseded"},{"version":2,"status":"deployed","chartVersion":"1.1.0"}]});
        let d = detail_helmrelease(&rel);
        assert_eq!(d["flux"]["source"]["kind"], "HelmRepository");
        assert_eq!(d["flux"]["source"]["name"], "bitnami");
        assert_eq!(d["flux"]["force_reset"], true);
        assert_eq!(d["flux"]["history"][0]["version"], 2);
        assert_eq!(d["flux"]["history"][0]["chart_version"], "1.1.0");
        rel.data["spec"]["chartRef"] =
            json!({"kind":"OCIRepository","name":"podinfo","namespace":"charts"});
        assert_eq!(
            detail_helmrelease(&rel)["flux"]["source"],
            json!({"group": SOURCE, "kind": "OCIRepository", "namespace": "charts", "name": "podinfo"})
        );
        let mut git = object();
        git.types.as_mut().unwrap().kind = "GitRepository".into();
        assert!(detail_source(&git)["flux"]["source"].is_null());
    }

    #[test]
    fn malformed_inventory_ids_are_skipped() {
        let mut obj = object();
        obj.data["status"]["inventory"]["entries"] =
            json!([{"id":"bad"},{"id":"_ns-x__Namespace"},4]);
        let r = &detail_kustomization(&obj)["resources"];
        assert_eq!(r.as_array().unwrap().len(), 1);
        assert!(r[0]["namespace"].is_null());
        assert_eq!(r[0]["name"], "ns-x");
        assert_eq!(r[0]["group"], "");
    }

    #[test]
    fn static_oci_helm_repository_has_no_misleading_actions() {
        let mut obj = object();
        obj.types.as_mut().unwrap().kind = "HelmRepository".into();
        obj.data["spec"]["type"] = json!("oci");
        assert_eq!(phase(&obj), "Static");
        assert!(actions(&obj).is_empty());
    }
}
