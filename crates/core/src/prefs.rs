//! User preferences — theme, settings panel values, and small UI state.
//!
//! Single hand-rolled JSON file at `<config-dir>/prefs.json`. Same shape as
//! `sources.rs` / `table_views.rs` / `fleet.rs`: load once at startup, save
//! on every mutation. Selection state (cluster, kind, namespaces, rail pin)
//! is persisted here too so the operator returns to the same view on relaunch.
//!
//! All fields are `#[serde(default)]` so partial / older files load cleanly.
//! Unknown fields are dropped — extending the schema is additive only.

use std::collections::HashSet;
use std::path::PathBuf;

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use tokio::fs;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum ThemeMode {
    Light,
    #[default]
    Dark,
}

/// Theme record persisted at `prefs.theme`. `id` selects a theme from the
/// frontend's bundled registry (`default`, `lens`, `vscode`, `readable`);
/// `palette_id` picks a palette within it; `mode` is the light/dark variant.
/// `overrides` is a free-form JSON bag the Customize UI fills in — kept
/// opaque on the backend so a future override-schema change doesn't force a
/// migration here.
///
/// Legacy files wrote `prefs.theme` as a bare `"light"` / `"dark"` string;
/// the wire enum below accepts both forms so plain `serde_json::from_str`
/// (e.g. inside Tauri command deserialization) tolerates the old shape too.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "ThemePrefsWire")]
pub struct ThemePrefs {
    #[serde(default = "default_theme_id")]
    pub id: String,
    #[serde(default = "default_palette_id")]
    pub palette_id: String,
    #[serde(default)]
    pub mode: ThemeMode,
    #[serde(default)]
    pub overrides: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum ThemePrefsWire {
    /// New shape — full record. All inner fields default so partial
    /// records from a transitional frontend still load.
    Record {
        #[serde(default = "default_theme_id")]
        id: String,
        #[serde(default = "default_palette_id")]
        palette_id: String,
        #[serde(default)]
        mode: ThemeMode,
        #[serde(default)]
        overrides: Option<serde_json::Value>,
    },
    /// Legacy shape — bare `"light"` / `"dark"` string written by builds
    /// that predate the theme record.
    BareMode(ThemeMode),
}

impl From<ThemePrefsWire> for ThemePrefs {
    fn from(wire: ThemePrefsWire) -> Self {
        match wire {
            ThemePrefsWire::Record {
                id,
                palette_id,
                mode,
                overrides,
            } => Self {
                id,
                palette_id,
                mode,
                overrides,
            },
            ThemePrefsWire::BareMode(mode) => Self {
                id: default_theme_id(),
                palette_id: default_palette_id(),
                mode,
                overrides: None,
            },
        }
    }
}

fn default_theme_id() -> String {
    "default".to_string()
}

fn default_palette_id() -> String {
    "default".to_string()
}

impl Default for ThemePrefs {
    fn default() -> Self {
        Self {
            id: default_theme_id(),
            palette_id: default_palette_id(),
            mode: ThemeMode::default(),
            overrides: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum Density {
    Compact,
    #[default]
    Comfortable,
    Spacious,
}

/// Fleet-landing layout. Independent of the global `Density` because
/// "show less per card" on the fleet shouldn't drag every detail panel
/// along with it. Tiles is today's rich card; Mini drops the gauges and
/// summary line for a denser tile; Rows is a single-line list view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum FleetView {
    #[default]
    Tiles,
    Mini,
    Rows,
}

/// How the left rail behaves. Auto: collapsed by default, expands on hover
/// (legacy behaviour). Pinned: always expanded. Collapsed: always collapsed,
/// no hover-expand — except for the CustomResources group, which always
/// expands the rail on hover because every CRD falls back to the same icon
/// and would otherwise be indistinguishable when collapsed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum RailMode {
    #[default]
    Auto,
    Pinned,
    Collapsed,
}

fn default_ui_scale() -> f32 {
    1.0
}

fn default_dark_console() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub refresh_sec: u32,
    pub confirm_destructive: bool,
    pub show_system_ns: bool,
    pub density: Density,
    pub mono_tables: bool,
    pub refresh_on_launch: bool,
    #[serde(default = "default_ui_scale")]
    pub ui_scale: f32,
    #[serde(default)]
    pub fleet_view: FleetView,
    /// Force logs + terminal surfaces to a dark, console-style palette even
    /// when the active theme is light. Defaults to true — operators expect a
    /// terminal to look like a terminal. Toggleable in Settings → Appearance.
    #[serde(default = "default_dark_console")]
    pub dark_console: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            refresh_sec: 15,
            confirm_destructive: true,
            show_system_ns: false,
            density: Density::default(),
            mono_tables: true,
            refresh_on_launch: true,
            ui_scale: default_ui_scale(),
            fleet_view: FleetView::default(),
            dark_console: default_dark_console(),
        }
    }
}

/// Background update-check state. Persisted so the "v… available" mark on
/// the Settings → About entry survives restarts, and so a user's "Skip this
/// version" choice is durable until a strictly-newer release ships.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateState {
    /// Latest release version observed by the background checker. `None`
    /// until the first successful check.
    #[serde(default)]
    pub last_known_version: Option<String>,
    /// Version the operator has explicitly acknowledged via "Skip this
    /// version". The About-entry mark suppresses while this equals
    /// `last_known_version`; reappears when `last_known_version` advances.
    #[serde(default)]
    pub last_seen_version: Option<String>,
    /// Last successful check timestamp (unix ms; 0 = never). Informational.
    #[serde(default)]
    pub last_check_at: u64,
    /// Whether the periodic background check runs. Operators on air-gapped
    /// clusters or who simply don't want the GitHub call can turn this off
    /// in Settings → General. Defaults to true.
    #[serde(default = "default_auto_check_enabled")]
    pub auto_check_enabled: bool,
}

fn default_auto_check_enabled() -> bool {
    true
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            last_known_version: None,
            last_seen_version: None,
            last_check_at: 0,
            auto_check_enabled: true,
        }
    }
}

/// A saved multi-cluster view: a user-named set of kubeconfig contexts that
/// open together. Members are `ContextInfo.id` composites
/// (`"<source_id>::<context_name>"`). Purely a frontend + prefs concept —
/// the data plane only ever sees the member cluster ids, never the virtual
/// id. Members that no longer resolve against the kubeconfig sources are
/// filtered at hydrate/selection time rather than rewritten here, so a
/// temporarily-missing kubeconfig file doesn't permanently shrink the set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VirtualContext {
    /// Frontend-generated UUID. Stable across renames and member edits.
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub members: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UiState {
    #[serde(default)]
    pub selected_context: Option<String>,
    /// Id of the active `VirtualContext`, mutually exclusive with
    /// `selected_context`. Dropped at hydrate if it no longer exists in
    /// `Prefs::virtual_contexts`.
    #[serde(default)]
    pub selected_virtual_context: Option<String>,
    #[serde(default)]
    pub selected_kind_id: Option<String>,
    #[serde(default)]
    pub selected_namespaces: HashSet<String>,
    #[serde(default)]
    pub rail_mode: RailMode,
    /// Persisted dock pane sizes. `None` ⇒ use the first-launch default
    /// computed from the viewport. Right placement is width (px); bottom
    /// placement is height (px).
    #[serde(default)]
    pub dock_size_right: Option<u32>,
    #[serde(default)]
    pub dock_size_bottom: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Prefs {
    #[serde(default)]
    pub theme: ThemePrefs,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub ui: UiState,
    #[serde(default)]
    pub update: UpdateState,
    #[serde(default, deserialize_with = "lenient_virtual_contexts")]
    pub virtual_contexts: Vec<VirtualContext>,
}

/// Deserialize `virtual_contexts` entry-by-entry, dropping malformed entries
/// instead of failing the whole document. A single bad entry (hand-edited
/// file, interrupted write) must not reset every other preference — `parse()`
/// falls back to `Prefs::default()` on any top-level error.
fn lenient_virtual_contexts<'de, D>(deserializer: D) -> Result<Vec<VirtualContext>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Vec::<serde_json::Value>::deserialize(deserializer)?;
    Ok(raw
        .into_iter()
        .filter_map(|v| serde_json::from_value::<VirtualContext>(v).ok())
        .filter(|vc| !vc.id.is_empty() && !vc.name.is_empty())
        .collect())
}

#[must_use]
pub fn config_path() -> Option<PathBuf> {
    ProjectDirs::from("dev", "ferrisscope", "ferrisscope")
        .map(|p| p.config_dir().join("prefs.json"))
}

/// Parse a prefs JSON document, applying legacy-field migrations.
///
/// Migrations applied:
/// - `ui.rail_pinned: true` → `ui.rail_mode: pinned` (only when rail_mode is
///   at its default Auto; an explicit rail_mode always wins).
/// - Legacy bare-string `theme: "dark"` / `"light"` → full `ThemePrefs`
///   record. Handled by `ThemePrefs`' `serde(from = ThemePrefsWire)` so
///   plain `serde_json::from_str` tolerates both shapes — this function
///   doesn't need a manual rewrite.
#[must_use]
pub fn parse(data: &str) -> Prefs {
    let mut prefs: Prefs = serde_json::from_str(data).unwrap_or_default();
    if matches!(prefs.ui.rail_mode, RailMode::Auto) {
        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(data) {
            if raw.pointer("/ui/rail_pinned").and_then(|v| v.as_bool()) == Some(true) {
                prefs.ui.rail_mode = RailMode::Pinned;
            }
        }
    }
    prefs
}

pub async fn load() -> Prefs {
    let Some(path) = config_path() else {
        return Prefs::default();
    };
    let data = match fs::read_to_string(&path).await {
        Ok(d) => d,
        Err(_) => return Prefs::default(),
    };
    parse(&data)
}

pub async fn save(prefs: &Prefs) -> std::io::Result<()> {
    let Some(path) = config_path() else {
        return Ok(());
    };
    let data = serde_json::to_string_pretty(prefs)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    crate::atomic_write::atomic_write(&path, data.as_bytes()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_prefs_without_update_block_loads_with_defaults() {
        // A prefs.json written before the `update` field existed must
        // deserialise cleanly. `auto_check_enabled` must default to true so
        // existing installs opt in to the periodic check on next launch.
        let legacy = r#"{
            "theme": "dark",
            "settings": {
                "refresh_sec": 15,
                "confirm_destructive": true,
                "show_system_ns": false,
                "density": "comfortable",
                "mono_tables": true,
                "refresh_on_launch": true
            },
            "ui": {}
        }"#;
        let prefs = parse(legacy);
        assert_eq!(prefs.update.last_known_version, None);
        assert_eq!(prefs.update.last_seen_version, None);
        assert_eq!(prefs.update.last_check_at, 0);
        assert!(
            prefs.update.auto_check_enabled,
            "auto_check_enabled must default to true so legacy installs opt in"
        );
    }

    #[test]
    fn legacy_prefs_without_dark_console_defaults_to_true() {
        // `dark_console` post-dates the first Settings shape. A prefs.json
        // written before it existed must deserialise with the field defaulting
        // to true so existing installs get the dark console without re-opting.
        let legacy = r#"{
            "theme": "dark",
            "settings": {
                "refresh_sec": 15,
                "confirm_destructive": true,
                "show_system_ns": false,
                "density": "comfortable",
                "mono_tables": true,
                "refresh_on_launch": true
            },
            "ui": {}
        }"#;
        let prefs = parse(legacy);
        assert!(
            prefs.settings.dark_console,
            "dark_console must default to true for prefs files written before it existed"
        );
    }

    #[test]
    fn dark_console_round_trips_when_disabled() {
        // An operator who turns the dark console off must have that choice
        // survive a serialise → parse round-trip.
        let mut prefs = Prefs::default();
        assert!(prefs.settings.dark_console, "default is on");
        prefs.settings.dark_console = false;
        let json = serde_json::to_string(&prefs).unwrap();
        let parsed = parse(&json);
        assert!(!parsed.settings.dark_console);
    }

    #[test]
    fn legacy_bare_string_theme_migrates_to_record() {
        // Pre-theme-record prefs.json wrote `"theme": "dark"`. The new shape
        // is an object; parse() must lift the bare string into the record
        // form so the operator's mode choice survives the upgrade.
        let legacy = r#"{ "theme": "light", "ui": {} }"#;
        let prefs = parse(legacy);
        assert_eq!(prefs.theme.id, "default");
        assert_eq!(prefs.theme.palette_id, "default");
        assert!(matches!(prefs.theme.mode, ThemeMode::Light));
        assert!(prefs.theme.overrides.is_none());
    }

    #[test]
    fn new_theme_record_round_trips() {
        // A prefs.json written by the new shape comes back identical.
        let payload = r#"{
            "theme": {
                "id": "lens",
                "palette_id": "lens",
                "mode": "dark",
                "overrides": null
            }
        }"#;
        let prefs = parse(payload);
        assert_eq!(prefs.theme.id, "lens");
        assert_eq!(prefs.theme.palette_id, "lens");
        assert!(matches!(prefs.theme.mode, ThemeMode::Dark));
    }

    #[test]
    fn missing_theme_defaults_to_default_dark() {
        // Brand-new install: no `theme` key at all.
        let prefs = parse("{}");
        assert_eq!(prefs.theme.id, "default");
        assert_eq!(prefs.theme.palette_id, "default");
        assert!(matches!(prefs.theme.mode, ThemeMode::Dark));
    }

    #[test]
    fn legacy_prefs_without_virtual_contexts_loads_with_defaults() {
        // A prefs.json written before virtual contexts existed must load
        // with an empty list and no selected virtual context.
        let legacy = r#"{ "theme": "dark", "ui": { "selected_context": "default::minikube" } }"#;
        let prefs = parse(legacy);
        assert!(prefs.virtual_contexts.is_empty());
        assert_eq!(prefs.ui.selected_virtual_context, None);
        assert_eq!(
            prefs.ui.selected_context,
            Some("default::minikube".to_string())
        );
    }

    #[test]
    fn virtual_contexts_round_trip() {
        let mut prefs = Prefs::default();
        prefs.virtual_contexts = vec![
            VirtualContext {
                id: "vc-1".to_string(),
                name: "prod".to_string(),
                members: vec![
                    "default::prod-eu".to_string(),
                    "default::prod-us".to_string(),
                ],
            },
            VirtualContext {
                id: "vc-2".to_string(),
                name: "edge".to_string(),
                members: vec!["src-a::edge-1".to_string()],
            },
        ];
        prefs.ui.selected_virtual_context = Some("vc-1".to_string());
        let json = serde_json::to_string(&prefs).unwrap();
        let parsed = parse(&json);
        assert_eq!(parsed.virtual_contexts.len(), 2);
        assert_eq!(parsed.virtual_contexts[0].id, "vc-1");
        assert_eq!(parsed.virtual_contexts[0].name, "prod");
        assert_eq!(
            parsed.virtual_contexts[0].members,
            vec![
                "default::prod-eu".to_string(),
                "default::prod-us".to_string()
            ]
        );
        assert_eq!(parsed.ui.selected_virtual_context, Some("vc-1".to_string()));
    }

    #[test]
    fn malformed_virtual_context_entries_are_dropped_not_fatal() {
        // A hand-edited or corrupted entry must not reset the rest of the
        // prefs file. Bad entries: wrong type, missing id/name, empty name.
        let payload = r#"{
            "settings": { "refresh_sec": 42, "confirm_destructive": true,
                          "show_system_ns": false, "density": "compact",
                          "mono_tables": true, "refresh_on_launch": true },
            "virtual_contexts": [
                { "id": "vc-good", "name": "prod", "members": ["default::a", "default::b"] },
                "not-an-object",
                { "name": "missing-id" },
                { "id": "vc-empty-name", "name": "" },
                { "id": "vc-bad-members", "name": "x", "members": [1, 2] }
            ]
        }"#;
        let prefs = parse(payload);
        assert_eq!(
            prefs.virtual_contexts.len(),
            1,
            "only the well-formed entry survives"
        );
        assert_eq!(prefs.virtual_contexts[0].id, "vc-good");
        assert_eq!(
            prefs.settings.refresh_sec, 42,
            "rest of the document must still parse"
        );
    }

    #[test]
    fn update_state_round_trips_through_json() {
        let mut prefs = Prefs::default();
        prefs.update.last_known_version = Some("1.2.3".to_string());
        prefs.update.last_seen_version = Some("1.2.2".to_string());
        prefs.update.last_check_at = 1_700_000_000_000;
        prefs.update.auto_check_enabled = false;
        let json = serde_json::to_string(&prefs).unwrap();
        let parsed = parse(&json);
        assert_eq!(parsed.update.last_known_version, Some("1.2.3".to_string()));
        assert_eq!(parsed.update.last_seen_version, Some("1.2.2".to_string()));
        assert_eq!(parsed.update.last_check_at, 1_700_000_000_000);
        assert!(!parsed.update.auto_check_enabled);
    }
}
