use kube::api::DynamicObject;
use serde_json::{json, Value};

use super::gitops::{
    action, array, columns, condition, detail, fields, records, row, text, Card, Detail, Field,
    Item, Resource, Section,
};
use super::{gitops_ops, WellKnownCrd};
use crate::registry::{Category, ColumnDef, ColumnKind};

const GROUP: &str = "argoproj.io";

pub static OVERRIDES: &[WellKnownCrd] = &[
    WellKnownCrd {
        short_id: "argocd_applications",
        group: GROUP,
        kind: "Application",
        category: Category::Apps,
        columns: application_columns,
        project: project_application,
        project_detail: detail_application,
    },
    WellKnownCrd {
        short_id: "argocd_applicationsets",
        group: GROUP,
        kind: "ApplicationSet",
        category: Category::Apps,
        columns: applicationset_columns,
        project: project_applicationset,
        project_detail: detail_applicationset,
    },
    WellKnownCrd {
        short_id: "argocd_appprojects",
        group: GROUP,
        kind: "AppProject",
        category: Category::Apps,
        columns: project_columns,
        project: project_project,
        project_detail: detail_project,
    },
];

fn application_columns() -> Vec<ColumnDef> {
    columns(&[
        ("project", "Project", ColumnKind::Text),
        ("sync", "Sync", ColumnKind::Phase),
        ("health", "Health", ColumnKind::Phase),
        ("destination", "Destination", ColumnKind::Text),
        ("revision", "Revision", ColumnKind::Text),
    ])
}

fn applicationset_columns() -> Vec<ColumnDef> {
    columns(&[
        ("generators", "Generators", ColumnKind::Text),
        ("phase", "Status", ColumnKind::Phase),
        ("project", "Project", ColumnKind::Text),
    ])
}

fn project_columns() -> Vec<ColumnDef> {
    columns(&[
        ("description", "Description", ColumnKind::Text),
        ("repositories", "Repositories", ColumnKind::Number),
        ("destinations", "Destinations", ColumnKind::Number),
    ])
}

fn project_application(obj: &DynamicObject) -> Value {
    let d = &obj.data;
    let revisions = array(d, "/status/sync/revisions")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    row(
        obj,
        json!({
            "project": text(d, "/spec/project"),
            "sync": text(d, "/status/sync/status").unwrap_or_else(|| "Unknown".into()),
            "health": text(d, "/status/health/status").unwrap_or_else(|| "Unknown".into()),
            "destination": text(d, "/spec/destination/name").or_else(|| text(d, "/spec/destination/server")),
            "revision": if revisions.is_empty() { text(d, "/status/sync/revision") } else { Some(revisions.join(", ")) },
        }),
    )
}

fn generator_names(d: &Value) -> String {
    array(d, "/spec/generators")
        .iter()
        .filter_map(Value::as_object)
        .flat_map(|g| g.keys().filter(|k| k.as_str() != "template").cloned())
        .collect::<Vec<_>>()
        .join(", ")
}

fn applicationset_status(obj: &DynamicObject) -> &'static str {
    if obj.metadata.deletion_timestamp.is_some() {
        return "Terminating";
    }
    let conditions = array(&obj.data, "/status/conditions");
    if conditions.iter().any(|c| {
        c["observedGeneration"]
            .as_i64()
            .zip(obj.metadata.generation)
            .is_some_and(|(observed, generation)| observed < generation)
    }) {
        return "Updating";
    }
    let active = |kind: &str| {
        conditions
            .iter()
            .any(|c| c["type"] == kind && c["status"] == "True")
    };
    if active("ErrorOccurred") {
        "Error"
    } else if active("ResourcesUpToDate") {
        "Ready"
    } else {
        "Unknown"
    }
}

fn project_applicationset(obj: &DynamicObject) -> Value {
    row(
        obj,
        json!({ "generators": generator_names(&obj.data), "phase": applicationset_status(obj), "project": text(&obj.data, "/spec/template/spec/project") }),
    )
}

fn project_project(obj: &DynamicObject) -> Value {
    row(
        obj,
        json!({ "description": text(&obj.data, "/spec/description"), "repositories": array(&obj.data, "/spec/sourceRepos").len(), "destinations": array(&obj.data, "/spec/destinations").len() }),
    )
}

fn sources(spec: &Value) -> Vec<Item> {
    let multiple = array(spec, "/sources");
    let single = spec.get("source").filter(|v| v.is_object());
    let sources: Vec<&Value> = if multiple.is_empty() {
        single.into_iter().collect()
    } else {
        multiple.iter().collect()
    };
    sources
        .into_iter()
        .enumerate()
        .map(|(i, source)| Item {
            title: text(source, "/repoURL")
                .map(
                    |repo| match text(source, "/path").or_else(|| text(source, "/chart")) {
                        Some(sub) => format!("{repo} · {sub}"),
                        None => repo,
                    },
                )
                .unwrap_or_else(|| format!("Source {}", i + 1)),
            fields: fields(
                source,
                &[
                    ("Repository", "/repoURL"),
                    ("Target revision", "/targetRevision"),
                    ("Path", "/path"),
                    ("Chart", "/chart"),
                    ("Ref", "/ref"),
                    ("Helm release", "/helm/releaseName"),
                    ("Value files", "/helm/valueFiles"),
                    ("Helm parameters", "/helm/parameters"),
                    ("Ignore missing files", "/helm/ignoreMissingValueFiles"),
                    ("Kustomize images", "/kustomize/images"),
                    ("Kustomize prefix", "/kustomize/namePrefix"),
                    ("Kustomize suffix", "/kustomize/nameSuffix"),
                    ("Directory recurse", "/directory/recurse"),
                    ("Include", "/directory/include"),
                    ("Exclude", "/directory/exclude"),
                    ("Plugin", "/plugin/name"),
                ],
            )
            .into_iter()
            .filter(|f| f.value.is_some())
            .collect(),
        })
        .collect()
}

fn revisions(d: &Value, single: &str, multiple: &str) -> Option<String> {
    let many = array(d, multiple)
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    if many.is_empty() {
        text(d, single)
    } else {
        Some(many.join(", "))
    }
}

fn auto_sync(spec: &Value) -> String {
    if !gitops_ops::auto_sync_enabled(spec) {
        return "Manual sync".into();
    }
    let auto = &spec["syncPolicy"]["automated"];
    let flags: Vec<&str> = [("prune", "prune"), ("selfHeal", "self-heal")]
        .into_iter()
        .filter(|(k, _)| auto[k].as_bool() == Some(true))
        .map(|(_, label)| label)
        .collect();
    if flags.is_empty() {
        "Auto-sync".into()
    } else {
        format!("Auto-sync · {}", flags.join(", "))
    }
}

fn operation_requested(d: &Value) -> bool {
    d.get("operation").is_some_and(|o| !o.is_null())
}

/// `Running` with `finishedAt` set is a sync waiting to retry — still busy.
fn operation_active(d: &Value) -> bool {
    matches!(
        text(d, "/status/operationState/phase").as_deref(),
        Some("Running" | "Terminating")
    )
}

fn application_cards(d: &Value) -> Vec<Card> {
    let op = &d["status"]["operationState"];
    let mut last = Card::new("Last sync");
    if d.get("operation").is_some_and(|o| !o.is_null())
        && text(op, "/phase").as_deref() != Some("Running")
    {
        last.status = Some("Pending".into());
        last.caption = Some("Sync requested; waiting for the controller.".into());
    } else if op.is_object() {
        last.status = text(op, "/phase");
        last.value = revisions(op, "/syncResult/revision", "/syncResult/revisions");
        last.caption = text(op, "/message");
        last.at = text(op, "/finishedAt").or_else(|| text(op, "/startedAt"));
    } else {
        last.caption = Some("No sync recorded.".into());
    }
    vec![
        Card {
            status: Some(text(d, "/status/health/status").unwrap_or_else(|| "Unknown".into())),
            caption: text(d, "/status/health/message"),
            ..Card::new("Health")
        },
        Card {
            status: Some(text(d, "/status/sync/status").unwrap_or_else(|| "Unknown".into())),
            value: revisions(d, "/status/sync/revision", "/status/sync/revisions"),
            caption: Some(auto_sync(&d["spec"])),
            at: text(d, "/status/reconciledAt"),
            ..Card::new("Sync")
        },
        last,
    ]
}

fn last_operation(d: &Value) -> Vec<Field> {
    let op = &d["status"]["operationState"];
    let initiator = &op["operation"]["initiatedBy"];
    let mut out = vec![Field::text(
        "Initiated by",
        text(initiator, "/username")
            .or_else(|| (initiator["automated"] == true).then(|| "automated".into())),
    )];
    out.extend(fields(
        op,
        &[
            ("Phase", "/phase"),
            ("Message", "/message"),
            ("Started", "/startedAt"),
            ("Finished", "/finishedAt"),
            ("Retry count", "/retryCount"),
            ("Revision", "/syncResult/revision"),
            ("Revisions", "/syncResult/revisions"),
            ("Requested revision", "/operation/sync/revision"),
            ("Prune", "/operation/sync/prune"),
            ("Dry run", "/operation/sync/dryRun"),
            ("Sync options", "/operation/sync/syncOptions"),
        ],
    ));
    out
}

fn resources(items: &[Value], local: bool) -> Vec<Resource> {
    items
        .iter()
        .filter_map(|r| {
            Some(Resource {
                group: r["group"].as_str().unwrap_or_default().into(),
                kind: r["kind"].as_str().filter(|s| !s.is_empty())?.into(),
                namespace: text(r, "/namespace").filter(|s| !s.is_empty()),
                name: r["name"].as_str().filter(|s| !s.is_empty())?.into(),
                local,
                sync: text(r, "/status"),
                health: text(r, "/health/status"),
                message: text(r, "/health/message"),
                prune: r["requiresPruning"].as_bool() == Some(true),
                version: text(r, "/version"),
                sync_wave: r["syncWave"].as_i64(),
                hook: r["hook"].as_bool() == Some(true),
            })
        })
        .collect()
}

fn sync_action(d: &Value) -> Value {
    let spec = &d["spec"];
    let target = |s: &Value| {
        s["targetRevision"]
            .as_str()
            .filter(|r| !r.is_empty())
            .unwrap_or("HEAD")
            .to_owned()
    };
    let multiple = array(spec, "/sources");
    // Pin the spec's target revision(s), as the Argo CD UI does; Argo falls
    // back differently per version when the revision is empty.
    let mut sync = json!({ "prune": false });
    let has_source = if !multiple.is_empty() {
        sync["revisions"] = multiple.iter().map(target).collect();
        true
    } else if spec["source"].is_object() {
        sync["revision"] = json!(target(&spec["source"]));
        true
    } else {
        false
    };
    if let Some(opts) = spec
        .pointer("/syncPolicy/syncOptions")
        .filter(|o| o.is_array())
    {
        sync["syncOptions"] = opts.clone();
    }
    // The controller reads options and retry from the operation only, never
    // from spec.syncPolicy — the API server copies them in the same way.
    let mut operation = json!({ "initiatedBy": { "username": "ferrisscope" }, "sync": sync });
    if let Some(retry) = spec.pointer("/syncPolicy/retry").filter(|r| r.is_object()) {
        operation["retry"] = retry.clone();
    }
    action(
        "sync",
        "Sync",
        json!({ "operation": operation }),
        Some("Apply the target revision from Git now? Resources that require pruning are left in place."),
        // A merge patch would merge into a pending operation, not replace it.
        if operation_requested(d) || operation_active(d) {
            Some("A sync operation is already in progress.")
        } else if !has_source {
            Some("No source is configured.")
        } else {
            None
        },
    )
}

fn refresh_action(obj: &DynamicObject, hard: bool) -> Value {
    // The timestamp is an opaque request id the controller clears with a test
    // op, so a refresh asked for mid-refresh is not dropped.
    let token = format!(
        "ferrisscope:{}",
        obj.metadata.resource_version.as_deref().unwrap_or_default()
    );
    let patch = json!({"metadata":{"annotations":{
        "argocd.argoproj.io/refresh": if hard { "hard" } else { "normal" },
        "argocd.argoproj.io/refresh-timestamp": token,
    }}});
    if hard {
        action("hard_refresh", "Hard refresh", patch, Some("Invalidate the manifest cache and compare again? This is not a sync, but automated sync may act on newly detected changes."), None)
    } else {
        action("refresh", "Refresh", patch, None, None)
    }
}

/// Mirrors `argocd app terminate-op`. Only offered while a sync is running:
/// the Application CRD has no status subresource, so this is a plain patch.
fn terminate_action(d: &Value) -> Option<Value> {
    (operation_requested(d)
        && text(d, "/status/operationState/phase").as_deref() == Some("Running"))
    .then(|| {
        action(
            "terminate",
            "Terminate sync",
            json!({"status":{"operationState":{"phase":"Terminating"}}}),
            Some("Stop the running sync? Resources already applied stay as they are."),
            None,
        )
    })
}

fn detail_application(obj: &DynamicObject) -> Value {
    let d = &obj.data;
    let spec = &d["spec"];
    // A destination name is controller configuration, not a kubeconfig context.
    let local = spec.pointer("/destination/server").and_then(Value::as_str)
        == Some("https://kubernetes.default.svc");
    let mut destination = vec![
        // AppProjects live in Argo's installation namespace, which need not
        // be the Application's namespace (Applications in any namespace).
        Field::reference(
            "Project",
            GROUP,
            "AppProject",
            None,
            spec["project"].as_str(),
            false,
        ),
    ];
    destination.extend(fields(
        spec,
        &[
            ("Server", "/destination/server"),
            ("Cluster name", "/destination/name"),
            ("Namespace", "/destination/namespace"),
        ],
    ));
    detail(
        obj,
        Detail {
            cards: application_cards(d),
            sections: vec![
                Section::fields("Destination", destination),
                Section::items("Sources", sources(spec)),
                Section::fields(
                    "Sync policy",
                    fields(
                        spec,
                        &[
                            ("Automated", "/syncPolicy/automated"),
                            ("Sync options", "/syncPolicy/syncOptions"),
                            ("Retry", "/syncPolicy/retry"),
                            (
                                "Managed namespace metadata",
                                "/syncPolicy/managedNamespaceMetadata",
                            ),
                            ("Ignore differences", "/ignoreDifferences"),
                            ("Revision history limit", "/revisionHistoryLimit"),
                        ],
                    ),
                ),
                Section::fields("Last operation", last_operation(d)),
                Section::fields(
                    "Reconciliation",
                    fields(
                        d,
                        &[
                            ("Reconciled at", "/status/reconciledAt"),
                            ("Observed at", "/status/observedAt"),
                            ("Source type", "/status/sourceType"),
                            ("Source types", "/status/sourceTypes"),
                            ("Controller namespace", "/status/controllerNamespace"),
                        ],
                    ),
                ),
            ],
            resources: Some(resources(array(d, "/status/resources"), local)),
            actions: vec![
                sync_action(d),
                refresh_action(obj, false),
                refresh_action(obj, true),
            ]
            .into_iter()
            .chain(terminate_action(d))
            .collect(),
            notice: (!local).then_some(
                "Managed resources target another or unresolved cluster and are copy-only.",
            ),
            argo: Some(application_extras(obj)),
            flux: None,
        },
    )
}

fn source_summary(s: &Value) -> Value {
    json!({
        "repo": text(s, "/repoURL"),
        "path": text(s, "/path"),
        "chart": text(s, "/chart"),
        "ref": text(s, "/ref"),
        "target_revision": text(s, "/targetRevision").filter(|r| !r.is_empty()).unwrap_or_else(|| "HEAD".into()),
    })
}

/// Typed inputs for the sync / rollback / auto-sync dialogs and tables.
fn application_extras(obj: &DynamicObject) -> Value {
    let d = &obj.data;
    let spec = &d["spec"];
    let sources: Vec<Value> = {
        let many = array(spec, "/sources");
        if many.is_empty() {
            spec.get("source")
                .filter(|s| s.is_object())
                .map(source_summary)
                .into_iter()
                .collect()
        } else {
            many.iter().map(source_summary).collect()
        }
    };
    let auto = spec.pointer("/syncPolicy/automated");
    let auto_on = gitops_ops::auto_sync_enabled(spec);
    let busy = gitops_ops::operation_busy(d);
    let mut history: Vec<Value> = array(d, "/status/history")
        .iter()
        .filter(|h| h.is_object())
        .map(|h| {
            let has_source = h.get("source").is_some_and(|s| s.as_object().is_some_and(|o| !o.is_empty()))
                || h.get("sources").is_some_and(|s| s.as_array().is_some_and(|a| !a.is_empty()));
            json!({
                "id": h["id"].as_i64(),
                "revision": revisions(h, "/revision", "/revisions"),
                "deployed_at": text(h, "/deployedAt"),
                "started_at": text(h, "/deployStartedAt"),
                "initiated_by": text(h, "/initiatedBy/username").or_else(|| (h["initiatedBy"]["automated"] == true).then(|| "automated".into())),
                "source": text(h, "/source/repoURL").or_else(|| text(h, "/sources/0/repoURL")),
                "rollback": has_source,
            })
        })
        .collect();
    history.sort_by_key(|h| std::cmp::Reverse(h["id"].as_i64().unwrap_or(i64::MIN)));
    let sync_result: Vec<Value> = array(d, "/status/operationState/syncResult/resources")
        .iter()
        .filter(|r| r.is_object())
        .map(|r| {
            json!({
                "group": r["group"].as_str().unwrap_or_default(),
                "kind": text(r, "/kind"),
                "namespace": text(r, "/namespace").filter(|n| !n.is_empty()),
                "name": text(r, "/name"),
                "status": text(r, "/status"),
                "message": text(r, "/message"),
                "hook_type": text(r, "/hookType"),
                "hook_phase": text(r, "/hookPhase"),
                "sync_phase": text(r, "/syncPhase"),
            })
        })
        .collect();
    json!({
        "sources": sources,
        "sync_options": spec.pointer("/syncPolicy/syncOptions").filter(|o| o.is_array()).cloned().unwrap_or_else(|| json!([])),
        "retry": spec.pointer("/syncPolicy/retry").filter(|r| r.is_object()),
        "auto_sync": {
            "enabled": auto_on,
            "prune": auto.is_some_and(|a| a["prune"] == true),
            "self_heal": auto.is_some_and(|a| a["selfHeal"] == true),
        },
        "operation_active": busy,
        "rollback_blocked": if auto_on { Some("Disable auto-sync to roll back; it would sync straight back to the target revision.") } else if busy { Some("A sync operation is already in progress.") } else { None },
        "history": history,
        "sync_result": sync_result,
        "images": array(d, "/status/summary/images"),
        "urls": array(d, "/status/summary/externalURLs"),
        "cascade": obj.metadata.finalizers.iter().flatten().any(|f| f.starts_with("resources-finalizer.argocd.argoproj.io")),
    })
}

fn app_health_caption(apps: &[Value]) -> Option<String> {
    let reported: Vec<&str> = apps
        .iter()
        .filter_map(|a| a["health"]["status"].as_str())
        .collect();
    if reported.is_empty() {
        return None;
    }
    Some(match reported.iter().filter(|h| **h != "Healthy").count() {
        0 => "All healthy".into(),
        n => format!("{n} not healthy"),
    })
}

fn detail_applicationset(obj: &DynamicObject) -> Value {
    let d = &obj.data;
    let spec = &d["spec"];
    let status_message = ["ErrorOccurred", "ResourcesUpToDate"]
        .iter()
        .find_map(|k| condition(obj, k).and_then(|c| text(c, "/message")));
    let apps = array(d, "/status/resources");
    detail(
        obj,
        Detail {
            cards: vec![
                Card {
                    status: Some(applicationset_status(obj).into()),
                    caption: status_message,
                    ..Card::new("Status")
                },
                Card {
                    // status.resources is truncated; resourcesCount is the total.
                    value: Some(
                        d.pointer("/status/resourcesCount")
                            .and_then(Value::as_u64)
                            .map_or_else(|| apps.len().to_string(), |n| n.to_string()),
                    ),
                    caption: app_health_caption(apps),
                    ..Card::new("Applications")
                },
                Card {
                    value: Some(generator_names(d)).filter(|g| !g.is_empty()),
                    caption: text(spec, "/strategy/type").map(|s| format!("{s} rollout")),
                    ..Card::new("Generators")
                },
            ],
            sections: vec![
                Section::fields("Template", fields(spec, &[("Name", "/template/metadata/name"), ("Namespace", "/template/metadata/namespace"), ("Project", "/template/spec/project"), ("Destination", "/template/spec/destination"), ("Sync policy", "/template/spec/syncPolicy"), ("Go template", "/goTemplate"), ("Go template options", "/goTemplateOptions")])),
                Section::items("Template sources", sources(&spec["template"]["spec"])),
                Section::items("Generators", array(spec, "/generators").iter().enumerate().map(|(i, g)| Item { title: g.as_object().and_then(|o| o.keys().find(|k| k.as_str() != "template").cloned()).unwrap_or_else(|| format!("Generator {}", i + 1)), fields: fields(g, &[("List", "/list"), ("Clusters", "/clusters"), ("Git", "/git"), ("Matrix", "/matrix"), ("Merge", "/merge"), ("SCM provider", "/scmProvider"), ("Pull request", "/pullRequest"), ("Cluster decision", "/clusterDecisionResource"), ("Plugin", "/plugin"), ("Template override", "/template")]).into_iter().filter(|f| f.value.is_some()).collect() }).collect()),
                Section::fields("Reconciliation policy", fields(spec, &[("Sync policy", "/syncPolicy"), ("Strategy", "/strategy"), ("Preserved fields", "/preservedFields"), ("Ignore application differences", "/ignoreApplicationDifferences")])),
                Section::items("Application rollout status", records(d, "/status/applicationStatus", "Application", &["/application"], &[("Status", "/status"), ("Message", "/message"), ("Step", "/step"), ("Target revisions", "/targetRevisions"), ("Last transition", "/lastTransitionTime")])),
            ],
            // Generated Applications live beside their ApplicationSet.
            resources: Some(resources(apps, true)),
            actions: vec![],
            notice: Some("Generated Applications remain controlled by this ApplicationSet. Change the generator or Git source rather than editing generated intent."),
            argo: None,
            flux: None,
        },
    )
}

fn detail_project(obj: &DynamicObject) -> Value {
    let spec = &obj.data["spec"];
    let count = |path: &str| Some(array(spec, path).len().to_string());
    detail(
        obj,
        Detail {
            cards: vec![
                Card {
                    value: count("/sourceRepos"),
                    ..Card::new("Repositories")
                },
                Card {
                    value: count("/destinations"),
                    ..Card::new("Destinations")
                },
                Card {
                    value: count("/syncWindows"),
                    caption: Some(if array(spec, "/syncWindows").is_empty() {
                        "Sync anytime".into()
                    } else {
                        "Sync restricted by schedule".into()
                    }),
                    ..Card::new("Sync windows")
                },
            ],
            sections: vec![
                Section::fields(
                    "Project",
                    fields(
                        spec,
                        &[
                            ("Description", "/description"),
                            ("Source repositories", "/sourceRepos"),
                            ("Source namespaces", "/sourceNamespaces"),
                            (
                                "Permit scoped clusters only",
                                "/permitOnlyProjectScopedClusters",
                            ),
                        ],
                    ),
                ),
                Section::items(
                    "Allowed destinations",
                    records(
                        spec,
                        "/destinations",
                        "Destination",
                        &["/name", "/server", "/namespace"],
                        &[
                            ("Server", "/server"),
                            ("Name", "/name"),
                            ("Namespace", "/namespace"),
                        ],
                    ),
                ),
                Section::fields(
                    "Resource permissions",
                    fields(
                        spec,
                        &[
                            ("Cluster allow list", "/clusterResourceWhitelist"),
                            ("Cluster deny list", "/clusterResourceBlacklist"),
                            ("Namespace allow list", "/namespaceResourceWhitelist"),
                            ("Namespace deny list", "/namespaceResourceBlacklist"),
                            ("Orphaned resources", "/orphanedResources"),
                        ],
                    ),
                ),
                Section::items(
                    "Roles",
                    records(
                        spec,
                        "/roles",
                        "Role",
                        &["/name"],
                        &[
                            ("Name", "/name"),
                            ("Description", "/description"),
                            ("Groups", "/groups"),
                            ("Policies", "/policies"),
                        ],
                    ),
                ),
                Section::items(
                    "Sync windows",
                    records(
                        spec,
                        "/syncWindows",
                        "Window",
                        &["/kind", "/schedule"],
                        &[
                            ("Kind", "/kind"),
                            ("Schedule", "/schedule"),
                            ("Duration", "/duration"),
                            ("Time zone", "/timeZone"),
                            ("Applications", "/applications"),
                            ("Namespaces", "/namespaces"),
                            ("Clusters", "/clusters"),
                            ("Manual sync", "/manualSync"),
                        ],
                    ),
                ),
            ],
            resources: None,
            actions: vec![],
            notice: None,
            argo: None,
            flux: None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_keeps_sync_and_health_independent_and_remote_refs_safe() {
        let obj: DynamicObject = serde_json::from_value(json!({"metadata":{"name":"app","namespace":"argocd","resourceVersion":"10"},"spec":{"project":"default","destination":{"name":"production"},"sources":[{"repoURL":"https://git/a","targetRevision":"main"},{"repoURL":"https://git/b","ref":"values"}]},"status":{"sync":{"status":"OutOfSync","revisions":["a","b"]},"health":{"status":"Healthy"},"resources":[{"group":"apps","kind":"Deployment","namespace":"prod","name":"web"}]}})).unwrap();
        let row = project_application(&obj);
        assert_eq!(row["sync"], "OutOfSync");
        assert_eq!(row["health"], "Healthy");
        assert_eq!(row["revision"], "a, b");
        assert!(row.get("resources").is_none());
        let d = detail_application(&obj);
        assert_eq!(d["sections"][1]["items"].as_array().unwrap().len(), 2);
        assert_eq!(d["sections"][1]["items"][0]["title"], "https://git/a");
        assert_eq!(d["resources"][0]["local"], false);
        assert_eq!(d["resources"][0]["group"], "apps");
        assert_eq!(
            d["actions"][1]["patch"]["metadata"]["annotations"]["argocd.argoproj.io/refresh"],
            "normal"
        );
        assert_eq!(d["resource_version"], "10");
        assert_eq!(d["sections"][0]["fields"][0]["reference"]["local"], false);
        assert!(d["sections"][0]["fields"][0]["reference"]["namespace"].is_null());
        assert_eq!(d["cards"][0]["status"], "Healthy");
        assert_eq!(d["cards"][1]["status"], "OutOfSync");
        assert_eq!(d["cards"][1]["value"], "a, b");
        assert_eq!(d["cards"][1]["caption"], "Manual sync");
        assert_eq!(d["cards"][2]["caption"], "No sync recorded.");
        let refresh = &d["actions"][1]["patch"]["metadata"]["annotations"];
        assert_eq!(
            refresh["argocd.argoproj.io/refresh-timestamp"],
            "ferrisscope:10"
        );
        assert_eq!(d["actions"][2]["id"], "hard_refresh");
        assert_eq!(d["actions"].as_array().unwrap().len(), 3);
    }

    fn app(extra: Value) -> DynamicObject {
        let mut v = json!({"metadata":{"name":"app","namespace":"argocd","resourceVersion":"7"},"spec":{"project":"default","source":{"repoURL":"https://git/a","targetRevision":"release-1"},"syncPolicy":{"automated":{"prune":true,"selfHeal":true},"syncOptions":["CreateNamespace=true"]}},"status":{}});
        if let (Some(v), Some(extra)) = (v.as_object_mut(), extra.as_object()) {
            v.extend(extra.clone());
        }
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn sync_pins_target_revision_and_never_prunes() {
        let d = detail_application(&app(json!({})));
        let sync = &d["actions"][0];
        assert_eq!(sync["id"], "sync");
        assert!(sync["disabled_reason"].is_null());
        let op = &sync["patch"]["operation"];
        assert_eq!(op["sync"]["revision"], "release-1");
        assert_eq!(op["sync"]["prune"], false);
        assert_eq!(op["sync"]["syncOptions"], json!(["CreateNamespace=true"]));
        assert_eq!(op["initiatedBy"]["username"], "ferrisscope");
        assert_eq!(d["cards"][1]["caption"], "Auto-sync · prune, self-heal");

        let multi = app(
            json!({"spec":{"project":"default","sources":[{"repoURL":"a"},{"repoURL":"b","targetRevision":"v2"}]}}),
        );
        let op = &detail_application(&multi)["actions"][0]["patch"]["operation"]["sync"];
        assert_eq!(op["revisions"], json!(["HEAD", "v2"]));
        assert!(op.get("revision").is_none());

        let none = app(json!({"spec":{"project":"default"}}));
        assert!(detail_application(&none)["actions"][0]["disabled_reason"].is_string());
    }

    #[test]
    fn sync_is_blocked_while_an_operation_is_pending_or_running() {
        let requested = app(json!({"operation":{"sync":{}}}));
        let d = detail_application(&requested);
        assert!(d["actions"][0]["disabled_reason"].is_string());
        assert_eq!(d["cards"][2]["status"], "Pending");
        let running = app(
            json!({"status":{"operationState":{"phase":"Running","startedAt":"2026-09-01T00:00:00Z","syncResult":{"revision":"abc"}}}}),
        );
        let d = detail_application(&running);
        assert!(d["actions"][0]["disabled_reason"].is_string());
        assert_eq!(d["cards"][2]["status"], "Running");
        assert_eq!(d["cards"][2]["value"], "abc");
        assert_eq!(d["cards"][2]["at"], "2026-09-01T00:00:00Z");
    }

    #[test]
    fn extras_feed_sync_and_rollback_dialogs() {
        let obj = app(
            json!({"metadata":{"name":"app","namespace":"argocd","resourceVersion":"7","finalizers":["resources-finalizer.argocd.argoproj.io"]},"status":{
                "history":[{"id":1,"revision":"a","source":{"repoURL":"r"},"deployedAt":"2026-09-01T00:00:00Z"},{"id":2,"revision":"b","initiatedBy":{"automated":true}},{"id":3,"revision":"c","source":{"repoURL":"r"},"initiatedBy":{"username":"alice"}}],
                "operationState":{"phase":"Failed","syncResult":{"resources":[{"group":"apps","kind":"Deployment","namespace":"prod","name":"web","status":"SyncFailed","message":"boom","hookPhase":"Failed"}]}},
                "summary":{"images":["nginx:1"],"externalURLs":["https://app.example"]}
            }}),
        );
        let x = &detail_application(&obj)["argo"];
        assert_eq!(x["sources"][0]["target_revision"], "release-1");
        assert_eq!(x["sync_options"], json!(["CreateNamespace=true"]));
        assert_eq!(
            x["auto_sync"],
            json!({"enabled": true, "prune": true, "self_heal": true})
        );
        assert!(x["rollback_blocked"].is_string());
        let ids: Vec<_> = x["history"]
            .as_array()
            .unwrap()
            .iter()
            .map(|h| h["id"].clone())
            .collect();
        assert_eq!(ids, vec![json!(3), json!(2), json!(1)]);
        assert_eq!(x["history"][0]["initiated_by"], "alice");
        assert_eq!(x["history"][1]["initiated_by"], "automated");
        assert_eq!(x["history"][1]["rollback"], false);
        assert_eq!(x["sync_result"][0]["message"], "boom");
        assert_eq!(x["images"], json!(["nginx:1"]));
        assert_eq!(x["urls"], json!(["https://app.example"]));
        assert_eq!(x["cascade"], true);
        let sections: Vec<_> = detail_application(&obj)["sections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["title"].clone())
            .collect();
        assert!(!sections.contains(&json!("Deployment history")));
        assert!(sections.contains(&json!("Last operation")));
        assert!(sections.contains(&json!("Reconciliation")));
    }

    #[test]
    fn resources_keep_wave_hook_version_and_last_operation_details() {
        let obj = app(json!({"status":{
            "resources":[{"group":"batch","version":"v1","kind":"Job","namespace":"prod","name":"migrate","status":"Synced","hook":true,"syncWave":-1}],
            "operationState":{"phase":"Succeeded","startedAt":"s","finishedAt":"f","retryCount":2,"operation":{"initiatedBy":{"automated":true}}},
            "observedAt":"o"
        }}));
        let d = detail_application(&obj);
        let r = &d["resources"][0];
        assert_eq!(r["version"], "v1");
        assert_eq!(r["sync_wave"], -1);
        assert_eq!(r["hook"], true);
        let section = |title: &str| {
            d["sections"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["title"] == title)
                .unwrap()
                .clone()
        };
        let op = section("Last operation");
        let value = |label: &str| {
            op["fields"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["label"] == label)
                .unwrap()["value"]
                .clone()
        };
        assert_eq!(value("Initiated by"), "automated");
        assert_eq!(value("Retry count"), "2");
        assert_eq!(value("Finished"), "f");
        assert_eq!(section("Reconciliation")["fields"][1]["value"], "o");
    }

    #[test]
    fn application_conditions_without_status_are_problems() {
        let obj =
            app(json!({"status":{"conditions":[{"type":"ComparisonError","message":"boom"}]}}));
        let c = &detail_application(&obj)["conditions"][0];
        assert_eq!(c["type"], "ComparisonError");
        assert_eq!(c["status"], "True");
        assert_eq!(c["negative"], true);
    }

    #[test]
    fn applicationset_lists_generated_applications() {
        let obj: DynamicObject = serde_json::from_value(json!({"metadata":{"name":"set","namespace":"argocd"},"spec":{"generators":[{"list":{}}]},"status":{"resources":[{"group":"argoproj.io","kind":"Application","namespace":"argocd","name":"a","status":"Synced","health":{"status":"Healthy"}},{"group":"argoproj.io","kind":"Application","namespace":"argocd","name":"b","status":"OutOfSync","health":{"status":"Degraded","message":"x"}}]}})).unwrap();
        let d = detail_applicationset(&obj);
        assert_eq!(d["resources"].as_array().unwrap().len(), 2);
        assert_eq!(d["resources"][1]["health"], "Degraded");
        assert_eq!(d["resources"][1]["local"], true);
        assert_eq!(d["cards"][1]["value"], "2");
        assert_eq!(d["cards"][1]["caption"], "1 not healthy");
        assert!(app_health_caption(&[json!({"name":"x"})]).is_none());
        let mut truncated = obj.clone();
        truncated.data["status"]["resourcesCount"] = json!(5000);
        assert_eq!(
            detail_applicationset(&truncated)["cards"][1]["value"],
            "5000"
        );
        assert_eq!(d["cards"][2]["value"], "list");
    }

    #[test]
    fn projections_are_total_on_missing_and_malformed_shapes() {
        for data in [
            json!({}),
            json!({"spec":false,"status":[]}),
            json!({"spec":{"generators":[null,4],"sources":[false]},"status":{"conditions":[false],"resources":[null]}}),
        ] {
            let obj: DynamicObject = serde_json::from_value(
                json!({"metadata":{"name":"x"},"spec":data["spec"],"status":data["status"]}),
            )
            .unwrap();
            for wk in OVERRIDES {
                assert!((wk.project)(&obj).is_object());
                let d = (wk.project_detail)(&obj);
                assert!(d["sections"].is_array());
                assert_eq!(d["actions"], json!([]));
            }
        }
    }

    #[test]
    fn applicationset_errors_win_and_project_permissions_are_visible() {
        let obj: DynamicObject = serde_json::from_value(json!({"metadata":{},"spec":{"roles":[{"name":"reader","policies":["p, read"]}],"syncWindows":[{"kind":"deny","schedule":"0 1 * * *"}]},"status":{"conditions":[{"type":"ErrorOccurred","status":"True"},{"type":"ResourcesUpToDate","status":"True"}]}})).unwrap();
        assert_eq!(applicationset_status(&obj), "Error");
        let d = detail_project(&obj);
        assert_eq!(d["sections"][3]["items"][0]["fields"][0]["value"], "reader");
        assert_eq!(d["sections"][4]["items"][0]["fields"][0]["value"], "deny");
    }
}
