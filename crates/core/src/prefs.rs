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
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let data = serde_json::to_string_pretty(prefs)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    fs::write(&path, data).await?;
    Ok(())
}
