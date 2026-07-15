use k8s_openapi::api::core::v1::Event;
use serde_json::{json, Value};

use crate::kinds::pod_template::project_meta;
use crate::registry::{Category, ColumnDef, ColumnKind, KindSpec, ResourceKind};

pub struct EventSpec;

fn event_count(ev: &Event) -> i32 {
    ev.series
        .as_ref()
        .and_then(|series| series.count)
        .or(ev.count)
        .unwrap_or(1)
}

fn event_last_seen(ev: &Event) -> Option<String> {
    ev.series
        .as_ref()
        .and_then(|series| series.last_observed_time.as_ref())
        .map(|time| time.0.to_string())
        .or_else(|| ev.last_timestamp.as_ref().map(|time| time.0.to_string()))
        .or_else(|| ev.event_time.as_ref().map(|time| time.0.to_string()))
        .or_else(|| ev.first_timestamp.as_ref().map(|time| time.0.to_string()))
        .or_else(|| {
            ev.metadata
                .creation_timestamp
                .as_ref()
                .map(|time| time.0.to_string())
        })
}

impl KindSpec for EventSpec {
    type K = Event;

    fn meta() -> ResourceKind {
        ResourceKind {
            id: "events",
            group: "",
            version: "v1",
            kind: "Event",
            plural: "events",
            namespaced: true,
            category: Category::Cluster,
            columns: vec![
                ColumnDef {
                    id: "namespace",
                    header: "Namespace",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "type",
                    header: "Type",
                    kind: Some(ColumnKind::Phase),
                },
                ColumnDef {
                    id: "reason",
                    header: "Reason",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "object",
                    header: "Object",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "message",
                    header: "Message",
                    kind: Some(ColumnKind::Text),
                },
                ColumnDef {
                    id: "count",
                    header: "Count",
                    kind: Some(ColumnKind::Number),
                },
                ColumnDef {
                    id: "last_seen",
                    header: "Last Seen",
                    kind: Some(ColumnKind::Age),
                },
            ],
        }
    }

    fn project(ev: &Event) -> Value {
        let meta = &ev.metadata;
        let involved = &ev.involved_object;
        let object_label = match (&involved.kind, &involved.name) {
            (Some(k), Some(n)) => format!("{k}/{n}"),
            (None, Some(n)) => n.clone(),
            _ => String::new(),
        };
        // Modern repeated Events advance series.lastObservedTime while their
        // eventTime remains the first observation.
        let last_seen = event_last_seen(ev);
        let source = ev.source.as_ref().and_then(|s| s.component.clone());

        json!({
            "namespace": meta.namespace.clone().unwrap_or_default(),
            "name": meta.name.clone().unwrap_or_default(),
            "type": ev.type_.clone().unwrap_or_else(|| "Normal".to_owned()),
            "reason": ev.reason.clone().unwrap_or_default(),
            "object": object_label,
            "message": ev.message.clone().unwrap_or_default(),
            "count": event_count(ev),
            "last_seen": last_seen,
            "source": source,
            // For per-object filtering on the detail panel.
            "involved_uid": involved.uid.clone(),
            "involved_kind": involved.kind.clone(),
            "involved_namespace": involved.namespace.clone(),
            "involved_name": involved.name.clone(),
        })
    }
}

/// Project a fetched Event into the same row shape used by the reflector.
/// Real API objects always carry a UID; malformed rows without one are skipped
/// so the frontend never receives an unstable table key.
pub fn project_row(ev: &Event) -> Option<Value> {
    let uid = ev.metadata.uid.clone()?;
    let mut row = EventSpec::project(ev);
    row.as_object_mut()?
        .insert("uid".to_owned(), Value::String(uid));
    Some(row)
}

// Rich projection used by the event detail panel. The interesting structure
// is the involved-object reference (kind / namespace / name / fieldPath), the
// full message, and the timeline (first/last/event_time + count). Everything
// else just goes through verbatim — Events are flat by design.
pub fn project_detail(ev: &Event) -> Value {
    let meta = project_meta(&ev.metadata);
    let involved = &ev.involved_object;
    let involved_obj = json!({
        "api_version": involved.api_version.clone(),
        "kind": involved.kind.clone(),
        "namespace": involved.namespace.clone(),
        "name": involved.name.clone(),
        "uid": involved.uid.clone(),
        "field_path": involved.field_path.clone(),
        "resource_version": involved.resource_version.clone(),
    });
    let source = ev.source.as_ref().map(|s| {
        json!({
            "component": s.component.clone(),
            "host": s.host.clone(),
        })
    });
    let related = ev.related.as_ref().map(|r| {
        json!({
            "api_version": r.api_version.clone(),
            "kind": r.kind.clone(),
            "namespace": r.namespace.clone(),
            "name": r.name.clone(),
            "uid": r.uid.clone(),
            "field_path": r.field_path.clone(),
        })
    });
    let series = ev.series.as_ref().map(|s| {
        json!({
            "count": s.count,
            "last_observed_time": s.last_observed_time.as_ref().map(|t| t.0.to_string()),
        })
    });

    json!({
        "meta": meta,
        "type": ev.type_.clone().unwrap_or_else(|| "Normal".to_owned()),
        "reason": ev.reason.clone(),
        "message": ev.message.clone(),
        "count": event_count(ev),
        "action": ev.action.clone(),
        "reporting_controller": ev.reporting_component.clone(),
        "reporting_instance": ev.reporting_instance.clone(),
        "first_timestamp": ev.first_timestamp.as_ref().map(|t| t.0.to_string()),
        "last_timestamp": ev.last_timestamp.as_ref().map(|t| t.0.to_string()),
        "event_time": ev.event_time.as_ref().map(|t| t.0.to_string()),
        "involved_object": involved_obj,
        "source": source,
        "related": related,
        "series": series,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn modern_series_drives_row_recency_and_count() {
        let event: Event = serde_json::from_value(json!({
            "metadata": {
                "name": "pod-started.abc",
                "namespace": "default",
                "uid": "event-uid",
                "creationTimestamp": "2026-07-15T08:00:00Z"
            },
            "involvedObject": {
                "kind": "Pod",
                "namespace": "default",
                "name": "api-0",
                "uid": "pod-uid"
            },
            "type": "Normal",
            "reason": "Started",
            "eventTime": "2026-07-15T08:01:00.000000Z",
            "lastTimestamp": "2026-07-15T08:02:00Z",
            "count": 2,
            "series": {
                "count": 7,
                "lastObservedTime": "2026-07-15T08:07:00.000000Z"
            }
        }))
        .expect("valid Event fixture");

        let row = project_row(&event).expect("API Event has a UID");
        assert_eq!(row["uid"], "event-uid");
        assert_eq!(row["involved_uid"], "pod-uid");
        assert_eq!(row["count"], 7);
        assert_eq!(row["last_seen"], "2026-07-15T08:07:00Z");

        let detail = project_detail(&event);
        assert_eq!(detail["count"], 7);
    }

    #[test]
    fn singleton_event_defaults_to_count_one_and_creation_time() {
        let event: Event = serde_json::from_value(json!({
            "metadata": {
                "name": "scheduled.abc",
                "namespace": "default",
                "uid": "event-uid",
                "creationTimestamp": "2026-07-15T08:00:00Z"
            },
            "involvedObject": {
                "kind": "Pod",
                "namespace": "default",
                "name": "api-0",
                "uid": "pod-uid"
            },
            "reason": "Scheduled"
        }))
        .expect("valid Event fixture");

        let row = EventSpec::project(&event);
        assert_eq!(row["count"], 1);
        assert_eq!(row["last_seen"], "2026-07-15T08:00:00Z");
    }
}
