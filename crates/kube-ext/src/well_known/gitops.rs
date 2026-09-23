use kube::api::DynamicObject;
use serde::Serialize;
use serde_json::{json, Value};

use crate::registry::{ColumnDef, ColumnKind};

#[derive(Serialize)]
pub(super) struct Reference {
    pub group: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    pub local: bool,
}

#[derive(Serialize)]
pub(super) struct Field {
    pub label: String,
    pub value: Option<String>,
    pub reference: Option<Reference>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<(String, String)>,
}

impl Field {
    pub(super) fn text(label: &str, value: Option<String>) -> Self {
        Self {
            label: label.into(),
            value,
            reference: None,
            entries: vec![],
        }
    }

    pub(super) fn reference(
        label: &str,
        group: &str,
        kind: &str,
        namespace: Option<&str>,
        name: Option<&str>,
        local: bool,
    ) -> Self {
        let reference = name.filter(|n| !n.is_empty()).map(|name| Reference {
            group: group.into(),
            kind: kind.into(),
            namespace: namespace.map(str::to_owned),
            name: name.into(),
            local,
        });
        Self {
            label: label.into(),
            value: reference.as_ref().map(|r| match &r.namespace {
                Some(ns) => format!("{}/{ns}/{}", r.kind, r.name),
                None => format!("{}/{}", r.kind, r.name),
            }),
            reference,
            entries: vec![],
        }
    }
}

#[derive(Serialize)]
pub(super) struct Item {
    pub title: String,
    pub fields: Vec<Field>,
}

#[derive(Serialize)]
pub(super) struct Section {
    pub title: String,
    pub fields: Vec<Field>,
    pub items: Vec<Item>,
}

impl Section {
    pub(super) fn fields(title: &str, fields: Vec<Field>) -> Self {
        Self {
            title: title.into(),
            fields,
            items: vec![],
        }
    }

    pub(super) fn items(title: &str, items: Vec<Item>) -> Self {
        Self {
            title: title.into(),
            fields: vec![],
            items,
        }
    }
}

pub(super) fn text(value: &Value, path: &str) -> Option<String> {
    value
        .pointer(path)
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub(super) fn array<'a>(value: &'a Value, path: &str) -> &'a [Value] {
    value
        .pointer(path)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

pub(super) fn fields(value: &Value, paths: &[(&str, &str)]) -> Vec<Field> {
    paths
        .iter()
        .map(|(label, path)| {
            let raw = value.pointer(path).filter(|v| !v.is_null());
            let value = raw.map(|v| {
                v.as_str().map_or_else(
                    || serde_json::to_string_pretty(v).unwrap_or_default(),
                    str::to_owned,
                )
            });
            let mut field = Field::text(label, value);
            if let Some(raw) = raw.filter(|v| v.is_object() || v.is_array()) {
                field_entries(raw, "", &mut field.entries);
            }
            field
        })
        .collect()
}

fn field_entries(value: &Value, path: &str, out: &mut Vec<(String, String)>) {
    match value {
        Value::Object(map) if !map.is_empty() => {
            for (key, v) in map {
                let key = key.replace('~', "~0").replace('/', "~1");
                field_entries(v, &format!("{path}/{key}"), out);
            }
        }
        Value::Array(items) if !items.is_empty() => {
            for (i, v) in items.iter().enumerate() {
                field_entries(v, &format!("{path}/{i}"), out);
            }
        }
        _ if !path.is_empty() => out.push((
            path.into(),
            value
                .as_str()
                .map_or_else(|| value.to_string(), str::to_owned),
        )),
        _ => {}
    }
}

pub(super) fn records(
    value: &Value,
    path: &str,
    title: &str,
    title_paths: &[&str],
    paths: &[(&str, &str)],
) -> Vec<Item> {
    array(value, path)
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let parts: Vec<String> = title_paths.iter().filter_map(|p| scalar(v, p)).collect();
            Item {
                title: if parts.is_empty() {
                    format!("{title} {}", i + 1)
                } else {
                    parts.join(" · ")
                },
                fields: fields(v, paths),
            }
        })
        .collect()
}

fn scalar(value: &Value, path: &str) -> Option<String> {
    match value.pointer(path)? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Headline status tile rendered above the sections.
#[derive(Serialize, Default)]
pub(super) struct Card {
    pub label: String,
    pub status: Option<String>,
    pub value: Option<String>,
    pub caption: Option<String>,
    /// RFC 3339 timestamp; the UI renders it relative.
    pub at: Option<String>,
}

impl Card {
    pub(super) fn new(label: &str) -> Self {
        Self {
            label: label.into(),
            ..Self::default()
        }
    }
}

#[derive(Serialize)]
pub(super) struct Resource {
    pub group: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
    pub local: bool,
    pub sync: Option<String>,
    pub health: Option<String>,
    pub message: Option<String>,
    pub prune: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_wave: Option<i64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub hook: bool,
}

#[derive(Serialize)]
pub(super) struct Condition {
    #[serde(rename = "type")]
    pub kind: String,
    pub status: String,
    /// "True" is the unhealthy state (Stalled, SyncError, …).
    pub negative: bool,
    pub reason: Option<String>,
    pub message: Option<String>,
    pub at: Option<String>,
    pub observed_generation: Option<i64>,
}

fn negative_condition(kind: &str) -> bool {
    matches!(
        kind,
        "Stalled"
            | "Reconciling"
            | "Remediated"
            | "Drifted"
            | "ArtifactOutdated"
            | "RolloutProgressing"
            | "InvalidRolloutConfig"
    ) || ["Error", "Occurred", "Warning", "Failed", "Unavailable"]
        .iter()
        .any(|s| kind.ends_with(s))
}

pub(super) fn conditions(obj: &DynamicObject) -> Vec<Condition> {
    array(&obj.data, "/status/conditions")
        .iter()
        .filter_map(|c| {
            let kind = c["type"].as_str().filter(|s| !s.is_empty())?;
            // Argo CD Application conditions carry no status: presence is the signal.
            let status = c["status"].as_str();
            Some(Condition {
                kind: kind.into(),
                status: status.unwrap_or("True").into(),
                negative: status.is_none() || negative_condition(kind),
                reason: text(c, "/reason"),
                message: text(c, "/message"),
                at: text(c, "/lastTransitionTime"),
                observed_generation: c["observedGeneration"].as_i64(),
            })
        })
        .collect()
}

pub(super) fn condition<'a>(obj: &'a DynamicObject, kind: &str) -> Option<&'a Value> {
    array(&obj.data, "/status/conditions")
        .iter()
        .find(|c| c["type"] == kind)
}

pub(super) fn columns(extra: &[(&'static str, &'static str, ColumnKind)]) -> Vec<ColumnDef> {
    let mut columns = vec![
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
    ];
    columns.extend(extra.iter().map(|(id, header, kind)| ColumnDef {
        id,
        header,
        kind: Some(*kind),
    }));
    columns.push(ColumnDef {
        id: "creation_timestamp",
        header: "Age",
        kind: Some(ColumnKind::Age),
    });
    columns
}

pub(super) fn row(obj: &DynamicObject, extra: Value) -> Value {
    let mut row = json!({
        "name": obj.metadata.name.as_deref().unwrap_or_default(),
        "namespace": obj.metadata.namespace,
        "creation_timestamp": obj.metadata.creation_timestamp.as_ref().map(|t| t.0.to_string()),
    });
    if let (Some(row), Some(extra)) = (row.as_object_mut(), extra.as_object()) {
        row.extend(extra.clone());
    }
    row
}

pub(super) struct Detail {
    pub cards: Vec<Card>,
    pub sections: Vec<Section>,
    /// `None` when the kind has no notion of managed resources.
    pub resources: Option<Vec<Resource>>,
    pub actions: Vec<Value>,
    pub notice: Option<&'static str>,
    /// Kind-specific typed extras (`argo` / `flux` on the wire).
    pub argo: Option<Value>,
    pub flux: Option<Value>,
}

pub(super) fn detail(obj: &DynamicObject, d: Detail) -> Value {
    let writable =
        obj.metadata.deletion_timestamp.is_none() && obj.metadata.resource_version.is_some();
    json!({
        "meta": crate::kinds::pod_template::project_meta(&obj.metadata),
        "resource_version": obj.metadata.resource_version,
        "cards": d.cards,
        "sections": d.sections,
        "resources": d.resources,
        "conditions": conditions(obj),
        "actions": if writable { d.actions } else { vec![] },
        "notice": d.notice,
        "argo": d.argo,
        "flux": d.flux,
    })
}

/// `id` is stable and picks the icon; `label` is display text.
pub(super) fn action(
    id: &str,
    label: &str,
    patch: Value,
    confirmation: Option<&str>,
    disabled_reason: Option<&str>,
) -> Value {
    json!({ "id": id, "label": label, "patch": patch, "confirmation": confirmation, "disabled_reason": disabled_reason })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fields_preserve_false_zero_and_nested_values() {
        let v = json!({"enabled": false, "count": 0, "config": {"a": "b"}});
        let result = fields(
            &v,
            &[
                ("Enabled", "/enabled"),
                ("Count", "/count"),
                ("Config", "/config"),
                ("Missing", "/missing"),
            ],
        );
        assert_eq!(result[0].value.as_deref(), Some("false"));
        assert_eq!(result[1].value.as_deref(), Some("0"));
        assert!(result[2].value.as_ref().unwrap().contains("\"a\""));
        assert_eq!(result[2].entries, vec![("/a".into(), "b".into())]);
        assert!(result[3].value.is_none());
        assert!(array(&v, "/config").is_empty());
        assert!(text(&v, "/count").is_none());
    }

    #[test]
    fn structured_fields_keep_unambiguous_paths_and_empty_values() {
        let mut entries = vec![];
        field_entries(
            &json!({"a/b":[false,0,null,{},[]],"a":{"b":""}}),
            "",
            &mut entries,
        );
        assert_eq!(
            entries,
            vec![
                ("/a/b".into(), String::new()),
                ("/a~1b/0".into(), "false".into()),
                ("/a~1b/1".into(), "0".into()),
                ("/a~1b/2".into(), "null".into()),
                ("/a~1b/3".into(), "{}".into()),
                ("/a~1b/4".into(), "[]".into()),
            ]
        );
    }

    #[test]
    fn record_titles_use_identifying_fields_with_indexed_fallback() {
        let v = json!({"list":[{"id":3,"revision":"abc"},{"revision":""},{}]});
        let items = records(&v, "/list", "Deployment", &["/id", "/revision"], &[]);
        assert_eq!(items[0].title, "3 · abc");
        assert_eq!(items[1].title, "Deployment 2");
        assert_eq!(items[2].title, "Deployment 3");
    }

    #[test]
    fn conditions_carry_observed_generation() {
        let obj: DynamicObject = serde_json::from_value(json!({"metadata":{"name":"x"},"status":{"conditions":[{"type":"Ready","status":"True","observedGeneration":4}]}})).unwrap();
        assert_eq!(conditions(&obj)[0].observed_generation, Some(4));
    }

    #[test]
    fn condition_polarity_follows_type_semantics() {
        for (kind, negative) in [
            ("Ready", false),
            ("Healthy", false),
            ("ResourcesUpToDate", false),
            ("Stalled", true),
            ("Reconciling", true),
            ("ErrorOccurred", true),
            ("SyncError", true),
            ("OrphanedResourceWarning", true),
            ("FetchFailed", true),
            ("IncludeUnavailable", true),
            ("Remediated", true),
            ("Drifted", true),
            ("InvalidRolloutConfig", true),
            ("ArtifactInStorage", false),
            ("SourceVerified", false),
            ("Released", false),
        ] {
            assert_eq!(negative_condition(kind), negative, "{kind}");
        }
    }

    #[test]
    fn references_are_explicit_about_group_and_destination() {
        let f = Field::reference(
            "Release",
            "helm.toolkit.fluxcd.io",
            "HelmRelease",
            Some("apps"),
            Some("web"),
            false,
        );
        assert_eq!(f.value.as_deref(), Some("HelmRelease/apps/web"));
        assert!(!f.reference.unwrap().local);
        assert!(Field::reference("Missing", "", "Secret", None, None, true)
            .reference
            .is_none());
    }
}
