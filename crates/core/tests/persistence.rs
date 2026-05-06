//! Round-trip + default tests for the persisted-config shapes.
//!
//! These types are loaded from JSON on disk (`sources.json`, `prefs.json`,
//! `portforwards.json`). They use `#[serde(default)]` everywhere so older
//! files keep loading after the schema grows. The tests below pin that
//! contract: each new field must default cleanly.

use ferrisscope_core::portforwards::{make_id, ForwardSpec, ForwardTarget, PortForwardsFile};
use ferrisscope_core::prefs::{Density, Prefs, RailMode, ThemeMode};
use ferrisscope_core::sources::{KubeconfigSource, SourceKind, SourcesFile};
use pretty_assertions::assert_eq;

#[test]
fn sources_file_defaults_when_empty_json() {
    let f: SourcesFile = serde_json::from_str("{}").unwrap();
    assert!(!f.default_disabled);
    assert!(f.last_picked_dir.is_none());
    assert!(f.sources.is_empty());
}

#[test]
fn sources_file_round_trip_preserves_fields() {
    let mut f = SourcesFile {
        default_disabled: true,
        ..Default::default()
    };
    f.sources.push(KubeconfigSource {
        id: "abc".into(),
        path: "/tmp/kc".into(),
        kind: SourceKind::Folder,
        group_override: Some("Lab".into()),
        enabled: false,
        ssh: None,
    });
    let s = serde_json::to_string(&f).unwrap();
    let back: SourcesFile = serde_json::from_str(&s).unwrap();
    assert!(back.default_disabled);
    assert_eq!(back.sources.len(), 1);
    let src = &back.sources[0];
    assert_eq!(src.id, "abc");
    assert_eq!(src.kind, SourceKind::Folder);
    assert_eq!(src.group_override.as_deref(), Some("Lab"));
    assert!(!src.enabled);
}

#[test]
fn kubeconfig_source_effective_group_uses_override_then_falls_back() {
    let folder = KubeconfigSource {
        id: "x".into(),
        path: "/some/team-a".into(),
        kind: SourceKind::Folder,
        group_override: None,
        enabled: true,
        ssh: None,
    };
    assert_eq!(folder.effective_group(), "team-a");

    let file = KubeconfigSource {
        kind: SourceKind::File,
        ..folder.clone()
    };
    assert_eq!(file.effective_group(), "Custom");

    let overridden = KubeconfigSource {
        group_override: Some("Production".into()),
        ..folder
    };
    assert_eq!(overridden.effective_group(), "Production");
}

#[test]
fn prefs_defaults_match_documented_values() {
    let p = Prefs::default();
    assert_eq!(p.theme, ThemeMode::Dark);
    assert_eq!(p.settings.density, Density::Comfortable);
    assert!(p.settings.confirm_destructive);
    assert!(!p.settings.show_system_ns);
    assert!(p.settings.mono_tables);
    assert!(p.settings.refresh_on_launch);
    assert_eq!(p.settings.refresh_sec, 15);
    assert!((p.settings.ui_scale - 1.0).abs() < 1e-6);
    assert!(p.ui.selected_context.is_none());
    assert!(p.ui.selected_kind_id.is_none());
    assert!(p.ui.selected_namespaces.is_empty());
    assert_eq!(p.ui.rail_mode, RailMode::Auto);
}

#[test]
fn prefs_load_partial_json_and_round_trip() {
    // Older file written before ui_scale + rail_mode existed — must still
    // load (ui_scale defaults to 1.0; legacy rail_pinned: true migrates to
    // rail_mode: pinned via prefs::parse).
    let raw = r#"{
        "theme": "light",
        "settings": {
            "refresh_sec": 30,
            "confirm_destructive": false,
            "show_system_ns": true,
            "density": "compact",
            "mono_tables": false,
            "refresh_on_launch": false
        },
        "ui": { "rail_pinned": true }
    }"#;
    let p = ferrisscope_core::prefs::parse(raw);
    assert_eq!(p.theme, ThemeMode::Light);
    assert_eq!(p.settings.density, Density::Compact);
    assert_eq!(p.settings.refresh_sec, 30);
    assert!(!p.settings.confirm_destructive);
    assert!(p.settings.show_system_ns);
    assert!(!p.settings.mono_tables);
    assert!(!p.settings.refresh_on_launch);
    assert!((p.settings.ui_scale - 1.0).abs() < 1e-6);
    assert_eq!(p.ui.rail_mode, RailMode::Pinned);

    let back = serde_json::to_string(&p).unwrap();
    let again: Prefs = serde_json::from_str(&back).unwrap();
    assert_eq!(again.theme, ThemeMode::Light);
    assert_eq!(again.settings.refresh_sec, 30);
    assert_eq!(again.ui.rail_mode, RailMode::Pinned);
}

#[test]
fn prefs_rail_mode_explicit_wins_over_legacy_pinned() {
    // If both legacy rail_pinned and the new rail_mode are present, the
    // explicit rail_mode wins — migration only fires when rail_mode is at
    // its default.
    let raw = r#"{ "ui": { "rail_pinned": true, "rail_mode": "collapsed" } }"#;
    let p = ferrisscope_core::prefs::parse(raw);
    assert_eq!(p.ui.rail_mode, RailMode::Collapsed);
}

#[test]
fn prefs_load_unknown_fields_are_dropped() {
    // Forward-compat: a newer version of the app might add fields; older
    // ones must drop them silently rather than fail to load.
    let raw = r#"{
        "theme": "dark",
        "future_flag": true,
        "settings": { "refresh_sec": 5, "confirm_destructive": true,
                      "show_system_ns": false, "density": "spacious",
                      "mono_tables": true, "refresh_on_launch": true,
                      "unknown_setting": 42 }
    }"#;
    let p: Prefs = serde_json::from_str(raw).unwrap();
    assert_eq!(p.settings.density, Density::Spacious);
    assert_eq!(p.settings.refresh_sec, 5);
}

#[test]
fn forward_id_is_deterministic_and_dedupable() {
    let target = ForwardTarget {
        kind: "Service".into(),
        namespace: "default".into(),
        name: "web".into(),
    };
    let id_a = make_id("ctx-a", &target, 8080);
    let id_b = make_id("ctx-a", &target, 8080);
    assert_eq!(id_a, id_b, "same triple must produce same id");
    assert_eq!(id_a, "ctx-a::Service/default/web:8080");

    // Different cluster → different id.
    let id_c = make_id("ctx-b", &target, 8080);
    assert_ne!(id_a, id_c);

    // Different remote port → different id.
    let id_d = make_id("ctx-a", &target, 8081);
    assert_ne!(id_a, id_d);
}

#[test]
fn portforwards_file_round_trip_preserves_optional_fields() {
    let f = PortForwardsFile {
        specs: vec![
            ForwardSpec {
                id: "ctx-a::Pod/default/p:80".into(),
                cluster_id: "ctx-a".into(),
                target: ForwardTarget {
                    kind: "Pod".into(),
                    namespace: "default".into(),
                    name: "p".into(),
                },
                remote_port: 80,
                requested_local_port: Some(18080),
                autostart: true,
            },
            ForwardSpec {
                id: "ctx-a::Service/x/y:443".into(),
                cluster_id: "ctx-a".into(),
                target: ForwardTarget {
                    kind: "Service".into(),
                    namespace: "x".into(),
                    name: "y".into(),
                },
                remote_port: 443,
                // None means "any free port" — must serialize as
                // null/absent and round-trip back to None.
                requested_local_port: None,
                autostart: false,
            },
        ],
    };
    let s = serde_json::to_string(&f).unwrap();
    let back: PortForwardsFile = serde_json::from_str(&s).unwrap();
    assert_eq!(back.specs.len(), 2);
    assert_eq!(back.specs[0].requested_local_port, Some(18080));
    assert!(back.specs[0].autostart);
    assert!(back.specs[1].requested_local_port.is_none());
    assert!(!back.specs[1].autostart);
}

#[test]
fn portforwards_file_old_shape_loads_without_autostart() {
    // Earlier release of the app didn't have `autostart` — must default
    // to false so old files keep loading.
    let raw = r#"{
        "specs": [{
            "id": "x::Pod/d/p:80",
            "cluster_id": "x",
            "target": {"kind": "Pod", "namespace": "d", "name": "p"},
            "remote_port": 80
        }]
    }"#;
    let f: PortForwardsFile = serde_json::from_str(raw).unwrap();
    assert_eq!(f.specs.len(), 1);
    assert!(!f.specs[0].autostart);
    assert!(f.specs[0].requested_local_port.is_none());
}
