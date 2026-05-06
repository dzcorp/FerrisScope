# Changelog

All notable changes to FerrisScope are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Sections we use, in order: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`.

## [Unreleased]

### Added
- **Native Kubernetes toolkit for the AI agent.** 17 new in-process tools cover the full management surface previously delegated to `kubernetes-mcp-server`: `fs_pods_list` / `_get` / `_delete` / `_run`, `fs_resources_list` / `_get` / `_delete` / `_scale` / `_apply` (multi-doc YAML SSA), `fs_nodes_log`, `fs_nodes_stats_summary`, `fs_events_list`, `fs_namespaces_list`, `fs_configuration_view`, `fs_configuration_contexts_list`, `fs_helm_install`, `fs_helm_uninstall`. The chat now ships with a complete cluster-management toolkit — no external binary required.

### Changed
- **External MCP server is now optional and fully operator-managed.** The `mcp_binary_path` setting still accepts an absolute path to any MCP-protocol server (filesystem, github, custom), and we still merge its tools with the native catalogue under the same approval gate. There is no longer a bundled `kubernetes-mcp-server`, no auto-install, no PATH lookup, no managed-install UI — leaving the path empty runs the chat with native tools only.

### Removed
- **Bundled `kubernetes-mcp-server` install/uninstall flow.** Native tools cover the same surface (and more) without a second process. Removed: the GitHub-release downloader (`agent_mcp_install.rs`), the `mcp_get_status` / `mcp_install_managed` / `mcp_uninstall_managed` Tauri commands, and the AI Settings → Managed MCP install panel. Operators who want a custom MCP server can still configure one by hand; operators who relied on the auto-install can migrate to the native tools (no action needed — the same prompts work better).

### Fixed
- _Track bug fixes here._

### Security
- _Track security-relevant fixes here. Reference the advisory ID once published._

---

## [1.0.0] — Unreleased

The initial public release. Highlights of what ships in v1.0:

### Added
- **Multi-source kubeconfigs.** Default kubeconfig plus user-added files, recursive folder scans, and SSH-mounted remote configs. Live filesystem watcher reloads on change. Stable `(source, name)` ids prevent collisions across files.
- **Reflector-backed browsing for ~50 standard kinds.** Workloads, Network, Config, Storage, Access, Cluster categories — all backed by lazy, deduplicated reflectors. One watch per `(cluster, kind)`; teardown a few seconds after the last unsubscribe.
- **Dynamic CRD discovery** with browseable instances and printer-column fallback when overrides are unavailable.
- **Well-known CRD overrides** for Gateway API (GatewayClass, Gateway, HTTPRoute, GRPCRoute, ReferenceGrant) — first-class category, columns, and detail panels without dragging a typed Rust crate per ecosystem.
- **Detail panels** with kind-agnostic primitives — Copyable values, cross-kind LinkValue navigation, ChipStrip, ConditionChip, KvEditor, SubGrid.
- **Inline Server-Side Apply editing** for ConfigMap data, Secret data, ResourceQuota hard limits, LimitRange items, plus Labels and Annotations on opted-in kinds. Stable `"ferrisscope"` field manager. Conflicts surface as a banner with an explicit Force-takeover action.
- **YAML viewer / editor** (Monaco) for any resource.
- **Live logs** with backpressure-safe streaming, ANSI colour, virtualised rendering, ring-buffered to 5 000 lines.
- **Metrics** from metrics-server (CPU / memory per pod and node), per-pod and per-PVC volume usage via the kubelet `/stats/summary` proxy.
- **Prometheus-API metrics** via apiserver proxy — discovery, instant + range queries, vendor badge.
- **Embedded terminal** (xterm.js + portable-pty) — pod shell, exec, kubectl, with PTY resize support.
- **Port-forwards** with persisted pinned forwards, owner-aware re-binding to a backing pod per connection.
- **Helm support** — install / upgrade / uninstall (when `helm` is on PATH), repo-update, release detail with revision history.
- **Node operations** — cordon / uncordon, drain.
- **Workload restart** — rollout-style for Deployments / StatefulSets / DaemonSets, plus single-pod owner-aware restart.
- **Command palette** (⌘K) with FTS5-backed cluster-resource search, context switch, kind navigation, settings jump.
- **AI agent** with 10 LLM providers (OpenRouter, Anthropic, OpenAI key + OAuth + Codex, Z.AI, MiniMax, Groq, DeepSeek, Mistral, Together, Ollama), an optional external MCP-server hook, and a comprehensive native in-process toolkit covering the full Kubernetes management surface — pods (`fs_pods_*`, `fs_pod_exec`, `fs_pod_diagnose`), arbitrary GVK resources (`fs_resources_*`, `fs_apply_resource`), nodes (`fs_nodes_log`, `fs_nodes_stats_summary`, `fs_node_diagnose`, `fs_node_shell_*`, `fs_node_ssh_*`), namespaces, events, configuration, helm (`fs_helm_*`), metrics (`fs_metrics_*`), `fs_prometheus_query`, `fs_logs_tail`, port-forwards (`fs_port_forward_*`), `fs_workload_summary`, `fs_http_fetch`, `fs_can_i`, `fs_pause`, `fs_rollout_status`.
- **Approval gate** — write tools require explicit per-call approval; `AllowAllWrites` is per-chat opt-in only.
- **Belt-and-braces TTLs** on agent-owned cluster state — debug pods carry `activeDeadlineSeconds: 300`, Jobs carry `ttlSecondsAfterFinish`.
- **In-app updater** for AppImage, macOS bundle, Windows NSIS. Package-manager installs (apt, dnf, Homebrew, AUR) defer to the system tool with a clear hint.
- **Multi-platform installers** — `.deb`, `.rpm`, `.AppImage` (Linux x64 + arm64); `.dmg` (macOS x64 + arm64); NSIS `.exe` and `.msi` (Windows x64).
- **AUR package** `ferrisscope-bin`, auto-published from CI on each release.
- **Universal Linux installer** at `packaging/linux/install.sh` with format auto-selection (.deb / .rpm / .AppImage), version pinning, and uninstall flow.

### Engineering posture
- `unsafe_code = "forbid"` workspace-wide.
- `panic = "abort"` in release builds.
- `rustls`-only TLS with the `ring` provider, set process-wide.
- Audited `tokio` feature set; no `full` flag.
- No `unwrap()` outside tests; `thiserror` in libraries, `anyhow` in the binary.
- TypeScript `strict: true`; no `any`.
- One reflector per `(cluster, kind)`; lazy lifecycle.
- `crates/core` has no Tauri dependency — engine reusable for a future TUI / CLI.

[Unreleased]: https://github.com/dzcorp/FerrisScope/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/dzcorp/FerrisScope/releases/tag/v1.0.0
