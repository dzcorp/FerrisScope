#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent;
mod agent_keyring;
mod agent_mcp;
mod agent_native;
mod agent_oauth;
mod commands;
mod helm_install;
mod kubectl_install;
mod secret_storage;
mod ssh_scratch;
mod state;
mod terminal;
mod updater;

use ferrisscope_core::{kubeconfig, sources, watcher::KubeconfigWatcher};
use tauri::{Emitter, Manager};
use tracing_subscriber::EnvFilter;

use crate::state::AppState;

// Use mimalloc instead of glibc's ptmalloc2. Long-running Tauri apps tend
// to accumulate "ghost" RSS under the default allocator because freed
// arenas aren't returned to the OS — the resident set looks like a leak
// even when no Rust object is actually retained. mimalloc tracks pages
// per thread and decommits them aggressively. Drop-in, no API changes.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    // Tell mimalloc to use `MADV_DONTNEED` (immediate RSS decrement)
    // instead of `MADV_FREE` (lazy reclaim that leaves freed pages in
    // `RssAnon` until memory pressure). Must run before mimalloc's
    // first allocation; we set the env vars *and* call `mi_option_set`
    // for belt-and-suspenders. See the rustdoc on
    // `ferrisscope_mimalloc_ext::init_purge_policy` for the full
    // rationale — short version: on Linux desktops with plenty of
    // free RAM, MADV_FREE means RSS plateaus at the high-water mark
    // of any past burst, which is what operators were seeing after
    // briefly opening a large cluster.
    ferrisscope_mimalloc_ext::init_purge_policy();

    // Linux render-path setup. Default is GPU-accelerated (WebKitGTK 2.46+
    // handles DMA-BUF + compositing fine across Mesa / nvidia-open). On
    // NVIDIA + Wayland we additionally disable EGL-Wayland's explicit-sync
    // path because the handshake still races on Plasma 6 / KWin and kills
    // the WebKit subprocess with "Error 71 (Protocol error)" before first
    // paint — harmless to set on other compositors. Users on older /
    // exotic stacks that blank-screen with the GPU path can fall back via
    // FERRISSCOPE_SAFE_MODE=1, which restores the historical conservative
    // disables. Returns a one-line summary for the startup log.
    #[cfg(target_os = "linux")]
    let linux_render_summary = configure_linux_render_env();

    // rustls 0.23 refuses to auto-pick a CryptoProvider when more than one
    // is linked into the binary. reqwest 0.13's `rustls-no-provider` keeps
    // aws-lc-rs out, and kube-rs's hyper-rustls pulls in `ring`; we wire
    // ring as the process-wide default here so any rustls client (reqwest,
    // hyper-rustls, tokio-rustls in the kube exec channel) picks it up.
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("install rustls ring crypto provider");

    // Updater helper short-circuit. When relaunched with --apply-update or
    // --elevated-copy we never bring up Tauri — just do the file swap and exit.
    match updater::maybe_run_apply_update_from_args() {
        Ok(true) => return,
        Ok(false) => {}
        Err(err) => {
            eprintln!("[updater] {err}");
            std::process::exit(1);
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,ferrisscope=debug")),
        )
        .init();

    #[cfg(target_os = "linux")]
    tracing::info!(target: "ferrisscope::startup", "{linux_render_summary}");

    // macOS GUI apps launched from Finder/Dock/Spotlight inherit a minimal
    // PATH (/usr/bin:/bin:/usr/sbin:/sbin) — not the user's shell PATH. That
    // means Homebrew/MacPorts-installed CLIs (helm, kubectl, …) are invisible
    // to `which::which` and `Command::new("foo")` until we paste the well-
    // known dirs back in. Must happen before any tool-detection cache fires.
    #[cfg(target_os = "macos")]
    augment_macos_path();

    // Best-effort: drop any .fs-update-old leftovers from the previous swap.
    updater::cleanup_old_update_files();

    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::default())
        .manage(agent::AgentState::default())
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::dev_memory_stats,
            commands::dev_compact_memory,
            commands::updater_info,
            commands::check_for_update,
            commands::apply_update,
            commands::kubectl_get_status,
            commands::kubectl_install_managed,
            commands::kubectl_uninstall_managed,
            commands::helm_get_status,
            commands::helm_install_managed,
            commands::helm_uninstall_managed,
            commands::list_contexts,
            commands::connect_context,
            commands::cancel_connect,
            commands::list_resource_kinds,
            commands::list_custom_resource_kinds,
            commands::subscribe_resource,
            commands::unsubscribe_resource,
            commands::drop_cluster_watchers,
            commands::reconnect_cluster,
            commands::forget_cluster_search_index,
            commands::search_cluster_index,
            commands::get_resource_yaml_cmd,
            commands::get_pod_detail_cmd,
            commands::get_deployment_detail_cmd,
            commands::get_replica_set_detail_cmd,
            commands::get_stateful_set_detail_cmd,
            commands::get_daemon_set_detail_cmd,
            commands::get_job_detail_cmd,
            commands::get_cron_job_detail_cmd,
            commands::get_node_detail_cmd,
            commands::get_namespace_detail_cmd,
            commands::get_event_detail_cmd,
            commands::get_service_detail_cmd,
            commands::get_endpoints_detail_cmd,
            commands::get_endpoint_slice_detail_cmd,
            commands::get_ingress_detail_cmd,
            commands::get_ingress_class_detail_cmd,
            commands::get_network_policy_detail_cmd,
            commands::get_config_map_detail_cmd,
            commands::get_secret_detail_cmd,
            commands::list_config_maps_in_namespace_cmd,
            commands::list_secrets_in_namespace_cmd,
            commands::list_persistent_volume_claims_in_namespace_cmd,
            commands::get_helm_release_detail_cmd,
            commands::upgrade_helm_release_cmd,
            commands::get_helm_chart_detail_cmd,
            commands::install_helm_chart_cmd,
            commands::helm_repo_update_cmd,
            commands::get_resource_quota_detail_cmd,
            commands::get_limit_range_detail_cmd,
            commands::get_persistent_volume_claim_detail_cmd,
            commands::get_persistent_volume_detail_cmd,
            commands::get_storage_class_detail_cmd,
            commands::get_custom_resource_definition_detail_cmd,
            commands::get_custom_resource_detail_cmd,
            commands::get_service_account_detail_cmd,
            commands::get_role_detail_cmd,
            commands::get_role_binding_detail_cmd,
            commands::get_cluster_role_detail_cmd,
            commands::get_cluster_role_binding_detail_cmd,
            commands::get_horizontal_pod_autoscaler_detail_cmd,
            commands::get_pod_disruption_budget_detail_cmd,
            commands::get_priority_class_detail_cmd,
            commands::get_replication_controller_detail_cmd,
            commands::get_lease_detail_cmd,
            commands::get_mutating_webhook_configuration_detail_cmd,
            commands::get_validating_webhook_configuration_detail_cmd,
            commands::get_well_known_detail_cmd,
            commands::apply_resource_cmd,
            commands::delete_resource_cmd,
            commands::cordon_node_cmd,
            commands::drain_node_cmd,
            commands::list_pods_on_node_cmd,
            commands::restart_pod_cmd,
            commands::restart_pods_cmd,
            commands::restart_workload_cmd,
            commands::start_log_stream,
            commands::stop_log_stream,
            commands::subscribe_metrics,
            commands::unsubscribe_metrics,
            commands::get_fleet_cache,
            commands::refresh_fleet,
            commands::list_kubeconfig_sources,
            commands::add_kubeconfig_source,
            commands::add_kubeconfig_ssh_source,
            commands::update_kubeconfig_ssh_source,
            commands::test_ssh_kubeconfig_source,
            commands::remove_kubeconfig_source,
            commands::update_kubeconfig_source,
            commands::set_default_kubeconfig_disabled,
            commands::delete_kubeconfig_context,
            commands::set_current_kubeconfig_context,
            commands::delete_kubeconfig_file,
            commands::get_table_views,
            commands::set_table_view,
            commands::get_prefs,
            commands::set_prefs,
            commands::terminal_open_shell,
            commands::terminal_open_exec,
            commands::terminal_open_kubectl,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_close,
            commands::apply_yaml_cmd,
            commands::pf_start,
            commands::pf_stop,
            commands::pf_list,
            commands::pf_set_autostart,
            commands::discover_prometheus_targets,
            commands::get_prometheus_target,
            commands::set_prometheus_target,
            commands::prometheus_redetect,
            commands::prometheus_query_instant,
            commands::prometheus_query_range,
            agent::ai_get_settings,
            agent::ai_set_settings,
            agent::ai_set_credential,
            agent::ai_delete_credential,
            agent::ai_oauth_login,
            agent::ai_oauth_cancel,
            agent::ai_test_provider,
            agent::mcp_test_server,
            agent::ai_list_models,
            agent::chat_create_session,
            agent::chat_list_sessions,
            agent::chat_load_session,
            agent::chat_rename_session,
            agent::chat_delete_session,
            agent::chat_open,
            agent::chat_send_message,
            agent::chat_cancel_streaming,
            agent::chat_set_approval_mode,
            agent::chat_set_model,
            agent::chat_compact,
            agent::chat_refresh_status,
            agent::chat_list_tools,
            agent::chat_close,
            agent::chat_approve_tool_call,
        ])
        .setup(|app| {
            // Devtools is reachable in dev via right-click → Inspect Element
            // (suppressor in App.tsx is gated on import.meta.env.DEV) but we
            // intentionally do NOT auto-open it. Attaching the WebKit web
            // inspector to large React trees (e.g. 2800-row tables) can use
            // 5–10 GB of RAM in the inspector heap alone — opt in only when
            // you need it.
            let _ = app;

            // Strip GTK's client-side decorations on Linux. The default
            // Wayland headerbar is oversized and themed via Adwaita,
            // which clashes with KDE/Plasma chrome — see the custom
            // `<TitleBar/>` in ui/src/components/TitleBar.tsx for the
            // replacement. macOS keeps native decorations because the
            // system titlebar is well-themed and gives us blur for free.
            #[cfg(target_os = "linux")]
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_decorations(false);
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = handle.emit("app://ready", ()) {
                    tracing::warn!(?e, "failed to emit ready event");
                }
            });

            // Load the models.dev catalogue used by the agent's
            // auto-compaction trigger. Two-step: hydrate from the
            // on-disk cache (instant; works offline) then kick a
            // background refresh from the network. Failures here are
            // best-effort — the agent falls back to per-provider
            // default context windows when the catalogue is empty.
            tauri::async_runtime::spawn(async move {
                let cache_root =
                    match directories::ProjectDirs::from("dev", "ferrisscope", "ferrisscope") {
                        Some(p) => p.config_dir().join("agent"),
                        None => return,
                    };
                ferrisscope_agent::provider::catalogue::load_from_disk(cache_root.clone()).await;
                ferrisscope_agent::provider::catalogue::refresh(cache_root).await;
            });

            // Load persisted sources, start the file-system watcher, and
            // forward debounced events to the frontend as `kubeconfig://changed`.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let loaded = sources::load().await;
                {
                    let mut s = state.sources.lock().await;
                    *s = loaded;
                }

                let watcher = match KubeconfigWatcher::start() {
                    Ok(w) => w,
                    Err(e) => {
                        tracing::warn!(error = %e, "kubeconfig watcher failed to start");
                        return;
                    }
                };

                // Initial path set (default + every enabled user source).
                // SSH sources have a synthetic label path (`user@host:port`)
                // and live remotely — there's nothing on the local FS to
                // watch, so they're filtered out here.
                let paths: Vec<_> = {
                    let s = state.sources.lock().await;
                    kubeconfig::resolved_sources(&s)
                        .into_iter()
                        .filter(|r| r.kind != ferrisscope_core::sources::SourceKind::Ssh)
                        .map(|r| r.path)
                        .collect()
                };
                watcher.reconfigure(&paths);

                // SSH refreshes don't fire fs events; install a notifier that
                // emits the same `kubeconfig://changed` whenever a background
                // SSH refetch lands a new kubeconfig in the cache.
                let ssh_emit_handle = handle.clone();
                kubeconfig::set_ssh_refresh_notifier(move || {
                    if let Err(e) = ssh_emit_handle.emit("kubeconfig://changed", ()) {
                        tracing::warn!(error = %e, "failed to emit kubeconfig change (ssh)");
                    }
                });

                {
                    let mut slot = state.kubeconfig_watcher.lock().await;
                    *slot = Some(watcher.clone());
                }

                let mut rx = watcher.subscribe();
                let emit_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    while rx.recv().await.is_ok() {
                        if let Err(e) = emit_handle.emit("kubeconfig://changed", ()) {
                            tracing::warn!(error = %e, "failed to emit kubeconfig change");
                        }
                    }
                });
            });

            // Background GC for the per-cluster search indices. Single
            // task for the whole app; idempotent against indices coming
            // and going as the operator connects / disconnects clusters.
            commands::spawn_search_index_gc(app.handle().clone());

            // Port-forward bring-up: mount the status forwarder once, then
            // restore every pinned forward from `portforwards.json`. Failures
            // (cluster offline, port collision) come back as `failed` status
            // events so the UI can render + retry — they don't block startup.
            commands::spawn_pf_status_forwarder_handle(app.handle().clone());
            let pf_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = pf_handle.state::<AppState>();
                commands::restore_persisted_forwards_state(&state, &pf_handle).await;
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("ferrisscope failed to start");
}

#[cfg(target_os = "linux")]
fn configure_linux_render_env() -> String {
    let force_safe = matches!(
        std::env::var("FERRISSCOPE_SAFE_MODE").ok().as_deref(),
        Some("1" | "true" | "yes")
    );

    let has_nvidia = std::path::Path::new("/sys/module/nvidia").exists()
        || std::path::Path::new("/proc/driver/nvidia/version").exists();

    // GDK_BACKEND=x11 forces XWayland, in which case Wayland-specific
    // workarounds are irrelevant even if WAYLAND_DISPLAY is still in env.
    let gdk_forces_x11 = matches!(std::env::var("GDK_BACKEND").ok().as_deref(), Some("x11"));
    let is_wayland = !gdk_forces_x11
        && (std::env::var_os("WAYLAND_DISPLAY").is_some()
            || matches!(
                std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
                Some("wayland")
            ));

    let mut applied: Vec<&'static str> = Vec::new();

    if force_safe {
        // Historical conservative path — DMABUF off + compositing off.
        // WebKitGTK reads these by *presence*, so any value disables.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            applied.push("WEBKIT_DISABLE_DMABUF_RENDERER=1");
        }
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            applied.push("WEBKIT_DISABLE_COMPOSITING_MODE=1");
        }
    } else if has_nvidia && is_wayland && std::env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none() {
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
        applied.push("__NV_DISABLE_EXPLICIT_SYNC=1");
    }

    let mode = if force_safe { "safe" } else { "gpu" };
    let vendor = if has_nvidia { "nvidia" } else { "non-nvidia" };
    let session = if is_wayland {
        "wayland"
    } else if gdk_forces_x11 {
        "x11(forced)"
    } else {
        "x11"
    };
    let applied_str = if applied.is_empty() {
        "none".to_string()
    } else {
        applied.join(",")
    };
    format!("linux render: mode={mode} vendor={vendor} session={session} applied=[{applied_str}] (override via FERRISSCOPE_SAFE_MODE=1)")
}

/// Prepend well-known macOS tool dirs to the process `PATH`. Why: GUI apps
/// launched outside a login shell (Finder, Dock, Spotlight, Launchpad) inherit
/// `/usr/bin:/bin:/usr/sbin:/sbin` — none of which contain Homebrew or
/// MacPorts. Anything we shell out to (helm install/uninstall/upgrade, an
/// operator-installed kubectl, mcp binaries…) must still resolve via `$PATH`,
/// so we paste the well-known dirs in once at startup. Idempotent: dirs
/// already present in `PATH` are not duplicated.
///
/// We also include our own `<config>/bin` so a managed helm/kubectl install
/// is picked up by `which::which` without a separate detection codepath.
#[cfg(target_os = "macos")]
fn augment_macos_path() {
    use std::path::PathBuf;

    // `(path, always_include)` — `always_include` skips the `is_dir` filter
    // so we still cover paths that don't exist yet (notably our managed-bin
    // dir on a fresh install: helm/kubectl land there *after* startup, and
    // we want them resolvable without a restart).
    let mut additions: Vec<(PathBuf, bool)> = vec![
        // Homebrew Apple-silicon prefix.
        (PathBuf::from("/opt/homebrew/bin"), false),
        (PathBuf::from("/opt/homebrew/sbin"), false),
        // Homebrew Intel prefix + traditional manual-install dir.
        (PathBuf::from("/usr/local/bin"), false),
        (PathBuf::from("/usr/local/sbin"), false),
        // MacPorts.
        (PathBuf::from("/opt/local/bin"), false),
        (PathBuf::from("/opt/local/sbin"), false),
    ];
    if let Ok(home) = std::env::var("HOME") {
        additions.push((PathBuf::from(format!("{home}/.local/bin")), false));
    }
    if let Some(managed) = kubectl_install::managed_bin_dir() {
        additions.push((managed, true));
    }

    let existing = std::env::var_os("PATH").unwrap_or_default();
    let existing_entries: Vec<PathBuf> = std::env::split_paths(&existing).collect();

    let (new_entries, applied) = plan_path_additions(&additions, &existing_entries, |p| p.is_dir());

    let summary = if applied.is_empty() {
        "none".to_string()
    } else {
        applied.join(",")
    };
    match std::env::join_paths(&new_entries) {
        Ok(joined) => {
            std::env::set_var("PATH", joined);
            tracing::info!(
                target: "ferrisscope::startup",
                "macos path: prepended=[{summary}]"
            );
        }
        Err(e) => {
            tracing::warn!(
                target: "ferrisscope::startup",
                "macos path: could not join entries — leaving PATH untouched ({e})"
            );
        }
    }
}

/// Pure planner for the PATH augmentation. Takes the proposed additions,
/// the current PATH entries, and a closure that decides whether a non-
/// always-included dir exists on disk. Returns `(new_entries, applied)`:
/// `new_entries` is the full ordered PATH (additions first, then existing),
/// `applied` lists what we actually prepended for the startup log.
#[cfg(target_os = "macos")]
fn plan_path_additions(
    additions: &[(std::path::PathBuf, bool)],
    existing: &[std::path::PathBuf],
    exists: impl Fn(&std::path::Path) -> bool,
) -> (Vec<std::path::PathBuf>, Vec<String>) {
    let mut new_entries: Vec<std::path::PathBuf> =
        Vec::with_capacity(additions.len() + existing.len());
    let mut applied: Vec<String> = Vec::new();
    for (add, always) in additions {
        if existing.iter().any(|e| e == add) {
            continue;
        }
        if !*always && !exists(add) {
            continue;
        }
        applied.push(add.display().to_string());
        new_entries.push(add.clone());
    }
    new_entries.extend(existing.iter().cloned());
    (new_entries, applied)
}

#[cfg(all(test, target_os = "macos"))]
mod path_planner_tests {
    use super::plan_path_additions;
    use std::path::PathBuf;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn skips_missing_unless_always() {
        let additions = vec![(p("/opt/homebrew/bin"), false), (p("/managed/bin"), true)];
        let existing = vec![p("/usr/bin"), p("/bin")];
        let (new_entries, applied) =
            plan_path_additions(&additions, &existing, |path| path == p("/opt/homebrew/bin"));
        assert_eq!(
            new_entries,
            vec![
                p("/opt/homebrew/bin"),
                p("/managed/bin"),
                p("/usr/bin"),
                p("/bin")
            ]
        );
        assert_eq!(applied, vec!["/opt/homebrew/bin", "/managed/bin"]);
    }

    #[test]
    fn dedupes_against_existing() {
        let additions = vec![(p("/usr/local/bin"), false), (p("/managed/bin"), true)];
        let existing = vec![p("/usr/local/bin"), p("/usr/bin")];
        let (new_entries, applied) = plan_path_additions(&additions, &existing, |_| true);
        // /usr/local/bin is already in PATH — must not be duplicated.
        assert_eq!(
            new_entries,
            vec![p("/managed/bin"), p("/usr/local/bin"), p("/usr/bin")]
        );
        assert_eq!(applied, vec!["/managed/bin"]);
    }

    #[test]
    fn preserves_existing_when_no_additions_apply() {
        let additions = vec![(p("/opt/homebrew/bin"), false)];
        let existing = vec![p("/usr/bin")];
        let (new_entries, applied) = plan_path_additions(&additions, &existing, |_| false);
        assert_eq!(new_entries, vec![p("/usr/bin")]);
        assert!(applied.is_empty());
    }
}
