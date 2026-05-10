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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UiState {
    #[serde(default)]
    pub selected_context: Option<String>,
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
    pub theme: ThemeMode,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub ui: UiState,
    #[serde(default)]
    pub update: UpdateState,
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
