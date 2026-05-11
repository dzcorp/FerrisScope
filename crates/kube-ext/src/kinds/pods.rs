use k8s_openapi::api::core::v1::{Container, ContainerStatus, Pod, Probe};
use serde_json::{json, Value};

use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct PodSpec;

impl KindSpec for PodSpec {
    type K = Pod;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "pods",
            group: "",
            version: "v1",
            kind: "Pod",
            plural: "pods",
            namespaced: true,
            category: Category::Workloads,
            // Column order mirrors the design's HV2PodTable:
            // Name · Namespace · Status · Ready · Restarts · CPU · Mem · Node · Age.
            // CPU and Mem are placeholders until metrics-server is wired.
            columns: vec![
                ColumnDef {
                    id: "name",
                    header: "Name",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "namespace",
                    header: "Namespace",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "phase",
                    header: "Status",
                    kind: Some(ColumnKind::Phase),
                },
                ColumnDef {
                    id: "ready",
                    header: "Ready",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "restarts",
                    header: "Restarts",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "cpu",
                    header: "CPU",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "mem",
                    header: "Mem",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "node",
                    header: "Node",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "creation_timestamp",
                    header: "Age",
                    kind: Some(ColumnKind::Age),
                },
            ],
        }
    }

    fn project(pod: &Pod) -> Value {
        let meta = &pod.metadata;
        let status = pod.status.as_ref();
        let containers_total = pod.spec.as_ref().map_or(0, |s| s.containers.len());
        let containers_ready = status
            .and_then(|s| s.container_statuses.as_ref())
            .map_or(0, |cs| cs.iter().filter(|c| c.ready).count());
        let restarts: i32 = status
            .and_then(|s| s.container_statuses.as_ref())
            .map_or(0, |cs| cs.iter().map(|c| c.restart_count).sum());
        let phase = status
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".to_owned());
        // Build a rich containers array — names alone don't let the UI show
        // container-state dots. We pull spec for shape (init/main/sidecar) and
        // status.{init_,}container_statuses for live state.
        let containers = build_containers(pod);

        // Names-only list kept for backwards compat (LogPanel reads it).
        let container_names: Vec<String> = pod
            .spec
            .as_ref()
            .map(|s| s.containers.iter().map(|c| c.name.clone()).collect())
            .unwrap_or_default();

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "phase": phase,
            "ready": format!("{containers_ready}/{containers_total}"),
            "restarts": restarts,
            // CPU / Mem are filled by the metrics pipeline once it lands.
            // Until then we render the column as "—" rather than fake values.
            "cpu": Value::Null,
            "mem": Value::Null,
            "node": pod.spec.as_ref().and_then(|s| s.node_name.clone()),
            "creation_timestamp": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
            "containers": container_names,
            "container_states": containers,
        })
    }
}

// Distinguish init/main/sidecar from Pod spec + the K8s 1.29 native sidecar
// signal (`restart_policy = Always` on an init container).
fn build_containers(pod: &Pod) -> Vec<Value> {
    let spec = match pod.spec.as_ref() {
        Some(s) => s,
        None => return Vec::new(),
    };
    let status = pod.status.as_ref();
    let init_statuses = status
        .and_then(|s| s.init_container_statuses.as_ref())
        .map(|v| v.as_slice())
        .unwrap_or(&[]);
    let main_statuses = status
        .and_then(|s| s.container_statuses.as_ref())
        .map(|v| v.as_slice())
        .unwrap_or(&[]);

    let mut out = Vec::new();

    if let Some(inits) = spec.init_containers.as_ref() {
        for c in inits {
            let st = init_statuses.iter().find(|s| s.name == c.name);
            // Native sidecars in K8s 1.29+ are init containers with
            // restartPolicy=Always — they keep running alongside main, so
            // surface them as sidecars in the UI.
            let kind = if c.restart_policy.as_deref() == Some("Always") {
                "sidecar"
            } else {
                "init"
            };
            out.push(container_value(&c.name, kind, c.image.as_deref(), st));
        }
    }
    for c in &spec.containers {
        let st = main_statuses.iter().find(|s| s.name == c.name);
        out.push(container_value(&c.name, "main", c.image.as_deref(), st));
    }
    out
}

fn container_value(
    name: &str,
    kind: &str,
    image: Option<&str>,
    st: Option<&ContainerStatus>,
) -> Value {
    let (state, reason) = derive_state(st);
    json!({
        "name": name,
        "kind": kind,
        "image": image,
        "state": state,
        "reason": reason,
        "ready": st.map(|s| s.ready).unwrap_or(false),
        "restart_count": st.map(|s| s.restart_count).unwrap_or(0),
    })
}

// Rich projection used by the detail panel — fetched on-demand via
// `get_pod_detail`, never streamed over the watcher bus. Carries every field
// the Lens-style summary surface renders, so the frontend doesn't have to
// parse YAML itself.
pub fn project_detail(pod: &Pod) -> Value {
    let meta = &pod.metadata;
    let spec = pod.spec.as_ref();
    let status = pod.status.as_ref();

    // BTreeMap iteration is alphabetical, which matches Lens.
    let labels: Vec<Value> = meta
        .labels
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| json!([k, v])).collect())
        .unwrap_or_default();
    let annotations = crate::kinds::pod_template::project_annotations(meta.annotations.as_ref());

    let controlled_by = meta
        .owner_references
        .as_ref()
        .and_then(|owners| owners.first())
        .map(|o| json!({ "kind": o.kind, "name": o.name }));

    let host_ips: Vec<String> = status
        .and_then(|s| s.host_ips.as_ref())
        .map(|ips| ips.iter().map(|ip| ip.ip.clone()).collect())
        .filter(|v: &Vec<String>| !v.is_empty())
        .or_else(|| status.and_then(|s| s.host_ip.clone()).map(|ip| vec![ip]))
        .unwrap_or_default();
    let pod_ips: Vec<String> = status
        .and_then(|s| s.pod_ips.as_ref())
        .map(|ips| ips.iter().map(|ip| ip.ip.clone()).collect())
        .filter(|v: &Vec<String>| !v.is_empty())
        .or_else(|| status.and_then(|s| s.pod_ip.clone()).map(|ip| vec![ip]))
        .unwrap_or_default();

    let tolerations: Vec<Value> = spec
        .and_then(|s| s.tolerations.as_ref())
        .map(|ts| {
            ts.iter()
                .map(|t| {
                    json!({
                        "key": t.key.clone(),
                        "operator": t.operator.clone(),
                        "value": t.value.clone(),
                        "effect": t.effect.clone(),
                        "toleration_seconds": t.toleration_seconds,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let conditions: Vec<Value> = status
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| {
            cs.iter()
                .map(|c| {
                    json!({
                        "type": c.type_.clone(),
                        "status": c.status.clone(),
                        "reason": c.reason.clone(),
                        "message": c.message.clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let containers = build_container_details(pod);
    let volumes = build_volume_details(pod);
    let totals = build_resource_totals(pod);
    let scheduling = build_scheduling(pod);
    let security = build_pod_security(pod);
    let image_pull_secrets: Vec<String> = spec
        .and_then(|s| s.image_pull_secrets.as_ref())
        .map(|ips| ips.iter().map(|r| r.name.clone()).collect())
        .unwrap_or_default();
    let owners: Vec<Value> = meta
        .owner_references
        .as_ref()
        .map(|os| {
            os.iter()
                .map(|o| {
                    json!({
                        "kind": o.kind.clone(),
                        "name": o.name.clone(),
                        "controller": o.controller.unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    json!({
        "name": meta.name.clone().unwrap_or_default(),
        "namespace": meta.namespace.clone(),
        "uid": meta.uid.clone(),
        "created_at": meta.creation_timestamp.as_ref().map(|t| t.0.to_string()),
        "labels": labels,
        "annotations": annotations,
        "controlled_by": controlled_by,
        "managers": super::pod_template::project_managers(meta),
        "status_phase": status.and_then(|s| s.phase.clone()),
        "status_reason": status.and_then(|s| s.reason.clone()),
        "status_message": status.and_then(|s| s.message.clone()),
        "node": spec.and_then(|s| s.node_name.clone()),
        "host_ips": host_ips,
        "pod_ips": pod_ips,
        "service_account": spec.and_then(|s| s.service_account_name.clone()),
        "qos_class": status.and_then(|s| s.qos_class.clone()),
        "termination_grace_period_s": spec.and_then(|s| s.termination_grace_period_seconds),
        "priority_class": spec.and_then(|s| s.priority_class_name.clone()),
        "tolerations": tolerations,
        "conditions": conditions,
        "containers": containers,
        "volumes": volumes,
        "totals": totals,
        "scheduling": scheduling,
        "security": security,
        "image_pull_secrets": image_pull_secrets,
        "owners": owners,
        "restart_policy": spec.and_then(|s| s.restart_policy.clone()),
    })
}

// Sum container resource requests + limits at the pod level, so the
// summary surfaces a "this pod needs N CPU + M memory" line instead of
// forcing operators to mentally add per-container rows. Init containers
// are excluded — they don't contribute to long-running scheduling cost
// (kubelet picks max(initContainers) vs sum(containers), which is more
// nuance than the summary needs; sum-of-main is the closer match to what
// metrics-server will eventually report).
fn build_resource_totals(pod: &Pod) -> Value {
    use std::collections::BTreeMap;
    let Some(spec) = pod.spec.as_ref() else {
        return json!({ "requests": {}, "limits": {} });
    };
    let mut requests: BTreeMap<String, (i64, &'static str)> = BTreeMap::new();
    let mut limits: BTreeMap<String, (i64, &'static str)> = BTreeMap::new();
    for c in &spec.containers {
        if let Some(r) = c.resources.as_ref() {
            if let Some(req) = r.requests.as_ref() {
                for (k, v) in req {
                    accumulate(&mut requests, k, &v.0);
                }
            }
            if let Some(lim) = r.limits.as_ref() {
                for (k, v) in lim {
                    accumulate(&mut limits, k, &v.0);
                }
            }
        }
    }
    json!({
        "requests": format_totals(&requests),
        "limits": format_totals(&limits),
    })
}

// Parse a Kubernetes quantity into (amount-in-base-unit, unit). CPU is
// normalised to millicores; memory to MiB. Anything we don't recognise
// passes through as a single string so the UI just lists it.
fn accumulate(
    acc: &mut std::collections::BTreeMap<String, (i64, &'static str)>,
    key: &str,
    raw: &str,
) {
    let lower = key.to_ascii_lowercase();
    if lower == "cpu" {
        if let Some(milli) = parse_cpu_milli(raw) {
            let entry = acc.entry(key.to_owned()).or_insert((0, "m"));
            entry.0 += milli;
        }
    } else if lower == "memory" || lower.ends_with("memory") {
        if let Some(mib) = parse_memory_mib(raw) {
            let entry = acc.entry(key.to_owned()).or_insert((0, "Mi"));
            entry.0 += mib;
        }
    } else if let Some(n) = parse_plain_int(raw) {
        let entry = acc.entry(key.to_owned()).or_insert((0, ""));
        entry.0 += n;
    }
}

fn format_totals(
    m: &std::collections::BTreeMap<String, (i64, &'static str)>,
) -> serde_json::Map<String, Value> {
    m.iter()
        .map(|(k, (n, unit))| {
            let formatted = if unit.is_empty() {
                n.to_string()
            } else {
                format!("{n}{unit}")
            };
            (k.clone(), Value::String(formatted))
        })
        .collect()
}

fn parse_cpu_milli(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    if let Some(rest) = raw.strip_suffix('m') {
        rest.parse::<i64>().ok()
    } else {
        // whole cores or fractional cores
        raw.parse::<f64>().ok().map(|f| (f * 1000.0).round() as i64)
    }
}

fn parse_memory_mib(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    let (num, unit): (&str, &str) = if let Some(idx) = raw.find(|c: char| c.is_alphabetic()) {
        raw.split_at(idx)
    } else {
        (raw, "")
    };
    let n: f64 = num.parse().ok()?;
    let bytes = match unit {
        "" => n,
        "K" => n * 1_000.0,
        "Ki" => n * 1_024.0,
        "M" => n * 1_000_000.0,
        "Mi" => n * 1_024.0 * 1_024.0,
        "G" => n * 1_000_000_000.0,
        "Gi" => n * 1_024.0 * 1_024.0 * 1_024.0,
        "T" => n * 1e12,
        "Ti" => n * 1_024_f64.powi(4),
        "P" => n * 1e15,
        "Pi" => n * 1_024_f64.powi(5),
        _ => return None,
    };
    Some((bytes / (1024.0 * 1024.0)).round() as i64)
}

fn parse_plain_int(raw: &str) -> Option<i64> {
    raw.trim().parse::<i64>().ok()
}

// Compact view of pod-level scheduling controls. These shape *where* a pod
// can land — operators tracking down "why isn't this scheduled" will read
// node selector / tolerations / affinity / topology spread together, so we
// surface them as one section.
fn build_scheduling(pod: &Pod) -> Value {
    let Some(spec) = pod.spec.as_ref() else {
        return Value::Null;
    };

    let node_selector: Vec<Value> = spec
        .node_selector
        .as_ref()
        .map(|m| m.iter().map(|(k, v)| json!([k, v])).collect())
        .unwrap_or_default();

    let topology_spread: Vec<Value> = spec
        .topology_spread_constraints
        .as_ref()
        .map(|cs| {
            cs.iter()
                .map(|c| {
                    json!({
                        "max_skew": c.max_skew,
                        "topology_key": c.topology_key.clone(),
                        "when_unsatisfiable": c.when_unsatisfiable.clone(),
                        "min_domains": c.min_domains,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    // Affinity is huge — flatten to counts + a one-line summary per kind so
    // the UI doesn't drown the panel. Operators reading the full rules will
    // pivot to YAML.
    let affinity = spec.affinity.as_ref().map(|a| {
        let node = a.node_affinity.as_ref().map(|na| {
            let required = na
                .required_during_scheduling_ignored_during_execution
                .as_ref()
                .map_or(0, |s| s.node_selector_terms.len());
            let preferred = na
                .preferred_during_scheduling_ignored_during_execution
                .as_ref()
                .map_or(0, |v| v.len());
            json!({ "required_terms": required, "preferred_terms": preferred })
        });
        let pod_aff = a.pod_affinity.as_ref().map(|pa| {
            json!({
                "required_terms": pa.required_during_scheduling_ignored_during_execution.as_ref().map_or(0, |v| v.len()),
                "preferred_terms": pa.preferred_during_scheduling_ignored_during_execution.as_ref().map_or(0, |v| v.len()),
            })
        });
        let pod_anti = a.pod_anti_affinity.as_ref().map(|pa| {
            json!({
                "required_terms": pa.required_during_scheduling_ignored_during_execution.as_ref().map_or(0, |v| v.len()),
                "preferred_terms": pa.preferred_during_scheduling_ignored_during_execution.as_ref().map_or(0, |v| v.len()),
            })
        });
        json!({
            "node_affinity": node,
            "pod_affinity": pod_aff,
            "pod_anti_affinity": pod_anti,
        })
    });

    json!({
        "node_selector": node_selector,
        "topology_spread": topology_spread,
        "affinity": affinity,
        "scheduler_name": spec.scheduler_name.clone(),
        "priority": spec.priority,
        "runtime_class": spec.runtime_class_name.clone(),
    })
}

// Pod-level securityContext. Per-container security context is folded into
// each container's projection (see container_detail).
fn build_pod_security(pod: &Pod) -> Value {
    let Some(spec) = pod.spec.as_ref() else {
        return Value::Null;
    };
    let Some(s) = spec.security_context.as_ref() else {
        return Value::Null;
    };
    json!({
        "run_as_user": s.run_as_user,
        "run_as_group": s.run_as_group,
        "run_as_non_root": s.run_as_non_root,
        "fs_group": s.fs_group,
        "fs_group_change_policy": s.fs_group_change_policy.clone(),
        "supplemental_groups": s.supplemental_groups.clone(),
        "seccomp_profile_type": s.seccomp_profile.as_ref().map(|p| p.type_.clone()),
        "se_linux_type": s.se_linux_options.as_ref().and_then(|o| o.type_.clone()),
        "host_network": spec.host_network,
        "host_pid": spec.host_pid,
        "host_ipc": spec.host_ipc,
        "share_process_namespace": spec.share_process_namespace,
    })
}

// Surface every entry under `pod.spec.volumes` with its source kind plus
// (where applicable) the referenced object's name. The Kubernetes Volume
// type is a giant tagged union — only one of its many `Option` fields is
// set per volume — so we walk the discriminator inline rather than
// reflecting it. Anything we don't have a tailored mapping for falls back
// to a single "kind" so the UI still shows the volume row.
fn build_volume_details(pod: &Pod) -> Vec<Value> {
    let Some(spec) = pod.spec.as_ref() else {
        return Vec::new();
    };
    let Some(vols) = spec.volumes.as_ref() else {
        return Vec::new();
    };
    vols.iter().map(volume_value).collect()
}

fn volume_value(v: &k8s_openapi::api::core::v1::Volume) -> Value {
    // Each branch maps to a Kubernetes Kind name — the one we'd navigate to
    // when the user clicks the volume's source link. `target_kind` stays None
    // for in-place sources (emptyDir, hostPath, downwardAPI, …) since there's
    // nothing browseable behind them.
    let (kind, source_name, target_kind): (&'static str, Option<String>, Option<&'static str>) =
        if let Some(s) = v.config_map.as_ref() {
            ("configMap", Some(s.name.clone()), Some("ConfigMap"))
        } else if let Some(s) = v.secret.as_ref() {
            ("secret", s.secret_name.clone(), Some("Secret"))
        } else if let Some(s) = v.persistent_volume_claim.as_ref() {
            (
                "persistentVolumeClaim",
                Some(s.claim_name.clone()),
                Some("PersistentVolumeClaim"),
            )
        } else if v.projected.is_some() {
            ("projected", None, None)
        } else if v.empty_dir.is_some() {
            ("emptyDir", None, None)
        } else if let Some(s) = v.host_path.as_ref() {
            ("hostPath", Some(s.path.clone()), None)
        } else if v.downward_api.is_some() {
            ("downwardAPI", None, None)
        } else if let Some(s) = v.csi.as_ref() {
            ("csi", Some(s.driver.clone()), None)
        } else if let Some(s) = v.nfs.as_ref() {
            ("nfs", Some(format!("{}:{}", s.server, s.path)), None)
        } else if v.iscsi.is_some() {
            ("iscsi", None, None)
        } else if v.cephfs.is_some() {
            ("cephfs", None, None)
        } else if v.rbd.is_some() {
            ("rbd", None, None)
        } else if v.glusterfs.is_some() {
            ("glusterfs", None, None)
        } else if v.fc.is_some() {
            ("fc", None, None)
        } else if v.flex_volume.is_some() {
            ("flexVolume", None, None)
        } else if v.azure_disk.is_some() {
            ("azureDisk", None, None)
        } else if v.azure_file.is_some() {
            ("azureFile", None, None)
        } else if v.gce_persistent_disk.is_some() {
            ("gcePersistentDisk", None, None)
        } else if v.aws_elastic_block_store.is_some() {
            ("awsElasticBlockStore", None, None)
        } else if v.ephemeral.is_some() {
            ("ephemeral", None, None)
        } else if v.git_repo.is_some() {
            ("gitRepo", None, None)
        } else {
            ("other", None, None)
        };

    // Round-trip blob for the volume editor: opaque snapshot of the *full*
    // volume object (name + source) so the operator can save unrelated edits
    // without us flattening unsupported fields. Strips `name` so the caller
    // can rebuild a Volume by `{ ...raw, name }`.
    let raw = serde_json::to_value(v)
        .ok()
        .map(|mut v| {
            if let Value::Object(ref mut map) = v {
                map.remove("name");
            }
            v
        })
        .unwrap_or(Value::Null);

    json!({
        "name": v.name.clone(),
        "kind": kind,
        "source_name": source_name,
        "target_kind": target_kind,
        "raw": raw,
    })
}

fn build_container_details(pod: &Pod) -> Vec<Value> {
    let Some(spec) = pod.spec.as_ref() else {
        return Vec::new();
    };
    let status = pod.status.as_ref();
    let init_statuses = status
        .and_then(|s| s.init_container_statuses.as_ref())
        .map(|v| v.as_slice())
        .unwrap_or(&[]);
    let main_statuses = status
        .and_then(|s| s.container_statuses.as_ref())
        .map(|v| v.as_slice())
        .unwrap_or(&[]);

    let mut out = Vec::new();
    if let Some(inits) = spec.init_containers.as_ref() {
        for c in inits {
            let st = init_statuses.iter().find(|s| s.name == c.name);
            let kind = if c.restart_policy.as_deref() == Some("Always") {
                "sidecar"
            } else {
                "init"
            };
            out.push(container_detail(c, kind, st));
        }
    }
    for c in &spec.containers {
        let st = main_statuses.iter().find(|s| s.name == c.name);
        out.push(container_detail(c, "main", st));
    }
    out
}

fn container_detail(c: &Container, kind: &str, st: Option<&ContainerStatus>) -> Value {
    let (state, reason) = derive_state(st);
    let last_state = st.and_then(|s| s.last_state.as_ref()).and_then(|ls| {
        // Almost always: last_state.terminated when CrashLoopBackOff is in
        // play. We surface exit code + reason + finish time; that's the
        // minimum needed to diagnose "why is this restarting".
        if let Some(tm) = ls.terminated.as_ref() {
            Some(json!({
                "kind": "terminated",
                "reason": tm.reason.clone(),
                "exit_code": tm.exit_code,
                "signal": tm.signal,
                "started_at": tm.started_at.as_ref().map(|t| t.0.to_string()),
                "finished_at": tm.finished_at.as_ref().map(|t| t.0.to_string()),
                "message": tm.message.clone(),
            }))
        } else {
            ls.waiting.as_ref().map(|w| {
                json!({
                    "kind": "waiting",
                    "reason": w.reason.clone(),
                    "message": w.message.clone(),
                })
            })
        }
    });
    let started_at = st
        .and_then(|s| s.state.as_ref())
        .and_then(|cs| cs.running.as_ref())
        .and_then(|r| r.started_at.as_ref())
        .map(|t| t.0.to_string());

    let security = c.security_context.as_ref().map(|sc| {
        let caps_add = sc
            .capabilities
            .as_ref()
            .and_then(|c| c.add.as_ref())
            .cloned()
            .unwrap_or_default();
        let caps_drop = sc
            .capabilities
            .as_ref()
            .and_then(|c| c.drop.as_ref())
            .cloned()
            .unwrap_or_default();
        json!({
            "privileged": sc.privileged,
            "allow_privilege_escalation": sc.allow_privilege_escalation,
            "read_only_root_filesystem": sc.read_only_root_filesystem,
            "run_as_user": sc.run_as_user,
            "run_as_group": sc.run_as_group,
            "run_as_non_root": sc.run_as_non_root,
            "capabilities_add": caps_add,
            "capabilities_drop": caps_drop,
        })
    });

    let ports: Vec<Value> = c
        .ports
        .as_ref()
        .map(|ps| {
            ps.iter()
                .map(|p| {
                    json!({
                        "name": p.name.clone(),
                        "container_port": p.container_port,
                        "protocol": p.protocol.clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    // Round-trippable env shape (literal `value` or full `valueFrom` ref) so
    // the inline editor can display ref details (ConfigMap / Secret name+key,
    // fieldRef path, resourceFieldRef container/resource) without a second
    // round-trip and re-serialize them faithfully on save.
    let env: Vec<Value> = c
        .env
        .as_ref()
        .map(|es| {
            es.iter()
                .map(super::pod_template::project_env_var)
                .collect()
        })
        .unwrap_or_default();

    let mounts: Vec<Value> = c
        .volume_mounts
        .as_ref()
        .map(|ms| {
            ms.iter()
                .map(super::pod_template::project_volume_mount)
                .collect()
        })
        .unwrap_or_default();
    // envFrom on Pod is rarely set post-creation but worth surfacing — and
    // shape parity with WorkloadContainerSummary keeps the FE simple.
    let env_from: Vec<Value> = c
        .env_from
        .as_ref()
        .map(|es| {
            es.iter()
                .map(super::pod_template::project_env_from)
                .collect()
        })
        .unwrap_or_default();

    let resources = c.resources.as_ref().map(|r| {
        json!({
            "requests": r.requests.as_ref().map(|m| {
                m.iter()
                    .map(|(k, v)| (k.clone(), Value::String(v.0.clone())))
                    .collect::<serde_json::Map<_, _>>()
            }),
            "limits": r.limits.as_ref().map(|m| {
                m.iter()
                    .map(|(k, v)| (k.clone(), Value::String(v.0.clone())))
                    .collect::<serde_json::Map<_, _>>()
            }),
        })
    });

    json!({
        "name": c.name.clone(),
        "kind": kind,
        "image": c.image.clone(),
        "image_id": st.map(|s| s.image_id.clone()),
        "container_id": st.and_then(|s| s.container_id.clone()),
        "image_pull_policy": c.image_pull_policy.clone(),
        "command": c.command.clone(),
        "args": c.args.clone(),
        "state": state,
        "reason": reason,
        "ready": st.map(|s| s.ready).unwrap_or(false),
        "started": st.and_then(|s| s.started),
        "started_at": started_at,
        "restart_count": st.map(|s| s.restart_count).unwrap_or(0),
        "last_state": last_state,
        "ports": ports,
        "env": env,
        "env_from": env_from,
        "mounts": mounts,
        "liveness": c.liveness_probe.as_ref().map(probe_value),
        "readiness": c.readiness_probe.as_ref().map(probe_value),
        "startup": c.startup_probe.as_ref().map(probe_value),
        "resources": resources,
        "security": security,
    })
}

// Flatten Probe into a small typed struct the UI renders as a chip row, like
// Lens. The probe shape is one of {http-get, tcp, exec, grpc} — exactly one
// is set in a valid spec, so we discriminate on `type` and copy the relevant
// scalars.
fn probe_value(p: &Probe) -> Value {
    let (kind, target) = if let Some(h) = p.http_get.as_ref() {
        let scheme = h.scheme.as_deref().unwrap_or("HTTP").to_lowercase();
        let port = match &h.port {
            k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(i) => i.to_string(),
            k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s) => s.clone(),
        };
        let path = h.path.clone().unwrap_or_else(|| "/".to_owned());
        ("http-get", Some(format!("{scheme}://:{port}{path}")))
    } else if let Some(t) = p.tcp_socket.as_ref() {
        let port = match &t.port {
            k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(i) => i.to_string(),
            k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(s) => s.clone(),
        };
        ("tcp-socket", Some(format!(":{port}")))
    } else if let Some(e) = p.exec.as_ref() {
        let cmd = e.command.as_ref().map(|c| c.join(" ")).unwrap_or_default();
        ("exec", Some(cmd))
    } else if let Some(g) = p.grpc.as_ref() {
        let svc = g.service.clone().unwrap_or_default();
        (
            "grpc",
            Some(format!(":{} {}", g.port, svc).trim().to_owned()),
        )
    } else {
        ("unknown", None)
    };

    json!({
        "type": kind,
        "target": target,
        "delay": p.initial_delay_seconds,
        "timeout": p.timeout_seconds,
        "period": p.period_seconds,
        "success": p.success_threshold,
        "failure": p.failure_threshold,
    })
}

// Translate the kubelet's per-container state into a single status string the
// UI maps onto a status bucket. Reason wins over plain "Waiting" when present
// (e.g. CrashLoopBackOff, ImagePullBackOff) — that's what `kubectl get pod`
// renders too.
fn derive_state(st: Option<&ContainerStatus>) -> (String, Option<String>) {
    let Some(st) = st else {
        return ("Waiting".to_owned(), None);
    };
    if let Some(s) = st.state.as_ref() {
        if let Some(w) = s.waiting.as_ref() {
            let reason = w.reason.clone();
            let label = reason.clone().unwrap_or_else(|| "Waiting".to_owned());
            return (label, reason);
        }
        if let Some(r) = s.running.as_ref() {
            let _ = r;
            return ("Running".to_owned(), None);
        }
        if let Some(term) = s.terminated.as_ref() {
            let reason = term.reason.clone();
            // Treat exit_code 0 as Completed regardless of reason wording.
            if term.exit_code == 0 {
                return ("Completed".to_owned(), reason);
            }
            let label = reason.clone().unwrap_or_else(|| "Terminated".to_owned());
            return (label, reason);
        }
    }
    ("Unknown".to_owned(), None)
}
