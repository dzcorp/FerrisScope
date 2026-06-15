<div align="center">

<img src="crates/app/icons/icon-256.svg" alt="FerrisScope logo" width="128" height="128" />

# FerrisScope

**A Rust-native, open-source desktop IDE for Kubernetes.**
A lightweight Lens replacement built on Tauri 2 + `kube-rs` + React.

⚡ **Fast and lightweight, built in Rust — free and open-source.**

[![CI](https://github.com/dzcorp/FerrisScope/actions/workflows/ci.yml/badge.svg)](https://github.com/dzcorp/FerrisScope/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/dzcorp/FerrisScope?label=release&color=blue)](https://github.com/dzcorp/FerrisScope/releases)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](#install)
[![Rust 1.94+](https://img.shields.io/badge/rust-1.94%2B-orange.svg)](https://www.rust-lang.org)
[![AUR](https://img.shields.io/aur/version/ferrisscope-bin?label=AUR)](https://aur.archlinux.org/packages/ferrisscope-bin)

[Install](#install) · [Features](#what-you-get) · [Why](#why-another-kubernetes-ide) · [Develop](#develop) · [Architecture](#architecture)

</div>

---

## Demos

<p>
  <a href="screenshots/demo.webm"><img src="screenshots/demo.gif" alt="End-to-end tour" width="100%" /></a>
  <br /><sub>End-to-end tour · <a href="screenshots/demo.webm">full-quality .webm</a></sub>
</p>

<p>
  <a href="screenshots/ai-demo.webm"><img src="screenshots/ai-demo.gif" alt="Cluster-aware AI chat" width="100%" /></a>
  <br /><sub>Cluster-aware AI chat · <a href="screenshots/ai-demo.webm">full-quality .webm</a></sub>
</p>

<sub>GIFs are sped-up previews so they render inline on GitHub; the `.webm` links are the original full-quality captures.</sub>

## Screenshots

<table>
  <tr>
    <td><a href="screenshots/01-fleet.png"><img src="screenshots/01-fleet.png" alt="Fleet landing" width="420" /></a></td>
    <td><a href="screenshots/02-resource-table.png"><img src="screenshots/02-resource-table.png" alt="Resource table — Pods" width="420" /></a></td>
  </tr>
  <tr>
    <td><a href="screenshots/03-detail-panel.png"><img src="screenshots/03-detail-panel.png" alt="Detail panel" width="420" /></a></td>
    <td><a href="screenshots/04-edit-ssa.png"><img src="screenshots/04-edit-ssa.png" alt="Inline SSA editing" width="420" /></a></td>
  </tr>
  <tr>
    <td><a href="screenshots/06-logs.png"><img src="screenshots/06-logs.png" alt="Live logs" width="420" /></a></td>
    <td><a href="screenshots/07-terminal.png"><img src="screenshots/07-terminal.png" alt="Embedded terminal" width="420" /></a></td>
  </tr>
  <tr>
    <td><a href="screenshots/09-agent-chat.png"><img src="screenshots/09-agent-chat.png" alt="AI agent chat" width="420" /></a></td>
    <td><a href="screenshots/10-command-palette.png"><img src="screenshots/10-command-palette.png" alt="Command palette" width="420" /></a></td>
  </tr>
</table>

---

## Why another Kubernetes IDE?

Lens is the de-facto desktop IDE for Kubernetes, but it bundles an entire Chromium runtime, runs business logic in the renderer, and the open-source build has been pared back over time. FerrisScope keeps the desktop UX but moves the engine into Rust:

- **Tiny shell.** Tauri 2 uses the system webview (~10–40 MB) instead of bundling Chromium.
- **One reflector per `(cluster, kind)`.** Watches are shared, started lazily on first subscribe, torn down a few seconds after the last unsubscribe. No duplicate watches, no orphaned tasks.
- **Frontend is a mirror, not a source of truth.** All canonical state lives in Rust. The renderer is a thin view over typed Tauri commands and event streams.
- **No bundled monitoring stack.** We *consume* whatever Prometheus / VictoriaMetrics / Thanos / Mimir / Cortex / M3 the operator already has — we never deploy one.
- **Reusable engine.** The core engine is Tauri-free, so a future TUI or CLI can sit on the same foundation.
- **Pure-Rust SSH for kubeconfig sources.** No `/usr/bin/ssh` shell-out; passphrases live in the OS keychain, never on disk.
- **`unsafe_code = "forbid"`, `panic = "abort"`, rustls + `ring` for all network TLS.** No aws-lc-rs, no unwind tables in the release binary.
- **Memory that comes back.** A tuned mimalloc allocator returns freed pages to the OS promptly, so RSS settles back down after big-cluster excursions instead of lingering.

## What you get

### Cluster operations
- **Multi-source kubeconfigs.** Default kubeconfig + user-added files, folder scans, and SSH-mounted remote configs. Live FS watcher reloads on change. Each context gets a stable `(source, name)` id so duplicate names across files never collide.
- **Virtual contexts — multi-cluster views.** Select 2+ clusters in the fleet and save them as a named *virtual context*; opening it connects every member in parallel and merges resource tables across them with a per-row Cluster column (stable identity colors so same-uid objects on two clusters never collide). A failed member gets its own Reconnect banner while the table keeps serving the healthy ones. Ad-hoc widening too — the cluster bar's **+** menu adds a cluster to the current view for the session. The AI chat is briefed on the active members and switches its target cluster on demand.
- **Fleet landing.** Per-cluster cards with cached probes (server version, node count, pod count, CPU / Mem load). Refresh is best-effort and never clears the last known good values.
- **Cloud-provider auth.** GKE / EKS / AKS / OIDC (dex / keycloak) exec plugins run through `kube-rs` — including legacy `auth-provider: gcp`/`oidc` id-token refresh and `HTTPS_PROXY` / `NO_PROXY` on corporate networks. On Dock / `.desktop` launches the full login-shell environment (`AWS_*` / `CLOUDSDK_*` / `GOOGLE_*` / `AZURE_*` / proxy / TLS) is synced so a plugin that authenticates in your terminal also authenticates in the app.
- **Auth-plugin diagnostics.** `gke-gcloud-auth-plugin` / `aws-iam-authenticator` / OIDC failures surface clearly — readable, credential-redacted plugin stderr instead of raw bytes, plus a passive **Diagnose** button on the connect-error banner that reports the resolved PATH, whether the context's exec plugin is findable, and which cloud / proxy / TLS env vars are present — never executing the plugin. Silent auth failures are the #1 Lens UX papercut we wanted to fix.

### Resource browsing — 40+ built-in kinds, reflector-backed
| Category | Kinds |
|---|---|
| **Workloads** | Pod, Deployment, ReplicaSet, StatefulSet, DaemonSet, Job, CronJob, ReplicationController, HorizontalPodAutoscaler, PodDisruptionBudget |
| **Network** | Service, Endpoints, EndpointSlice, Ingress, IngressClass, NetworkPolicy |
| **Config** | ConfigMap, Secret, ResourceQuota, LimitRange, MutatingWebhookConfiguration, ValidatingWebhookConfiguration |
| **Storage** | PersistentVolume, PersistentVolumeClaim, StorageClass |
| **Access** | ServiceAccount, Role, RoleBinding, ClusterRole, ClusterRoleBinding |
| **Cluster** | Node, Namespace, Event, Lease, PriorityClass |
| **Apps** | Helm releases (read from `helm.sh/release.v1` Secrets) and discovered charts |
| **Custom Resources** | Dynamic CRD discovery + browseable instances |
| **Well-known CRDs** | Gateway API today (GatewayClass / Gateway / HTTPRoute / GRPCRoute / ReferenceGrant) — first-class category, columns, and detail panel without a typed crate per ecosystem |

### Detail panels & inline editing
- Kind-agnostic detail primitives: copyable values everywhere, cross-kind navigation (owner refs, node names, service-account refs, image-pull-secret refs, volume sources), key/value chip strips, condition chips with invert support for "True is bad" conditions, sub-grids for nested structs.
- **Inline editing** — ConfigMap and Secret data, ResourceQuota limits, LimitRange items, Deployment / StatefulSet / ReplicaSet replicas, PVC size, plus labels and annotations, straight from the detail panel. Edits go through Server-Side Apply, so FerrisScope coexists with your controllers and GitOps instead of stomping their fields.
- **Concurrent-edit safety.** If another controller owns a field you're changing, you get a banner showing exactly who owns it before anything is overwritten — a *Force takeover* is always an explicit choice, never the default.
- **Full-manifest YAML editor** (Monaco) for any resource — edit and apply just like `kubectl edit`. Removing a field or clearing a value does exactly what you'd expect, and if the object changed underneath you, you get a Reload / Apply-anyway prompt instead of a silent overwrite.

### Live data — logs, metrics, terminal, port-forwards
- **Live logs** with backpressure-safe streaming that flags dropped lines instead of stalling when the UI can't keep up; ANSI-colored, virtualized, ring-buffered to 5 000 lines, with in-log find (⌘F, next/prev, match highlighting).
- **Metrics** from metrics-server (CPU / mem per pod and node) plus per-pod and per-PVC volume usage scraped via the kubelet `/stats/summary` proxy. If metrics-server isn't installed, it says so plainly — no fake spinners.
- **Prometheus-API metrics** via apiserver proxy — discovery by service labels, instant + range queries, vendor badge (Prom / VM / Thanos / Mimir / Cortex / M3 / Promscale).
- **Embedded terminal** (xterm.js + portable-pty): pod shell, exec, kubectl, with in-terminal find (⌘F). Survives window resizes; Cmd+\` spawns a shell pre-pointed at the active context.
- **Port-forwards.** Pinned forwards persist across restarts and re-bind on next launch; the listener resolves Service / Deployment / StatefulSet / DaemonSet / ReplicaSet / Job to a backing pod per connection so it survives pod restarts. Ephemeral forwards opened from a detail panel live in memory only.

### Cluster mutation
- **Helm.** Install / upgrade / uninstall (when the `helm` binary is on PATH), repo-update, release detail with revision history.
- **Node operations.** Cordon / uncordon, drain (force flag to evict uncontrolled pods; DaemonSet and mirror pods are skipped, eviction respects PodDisruptionBudgets server-side).
- **Workload restart.** Rollout-style restart for Deployments / StatefulSets / DaemonSets, plus single-pod owner-aware restart.

### AI agent — multi-provider, native in-process toolkit, optional MCP
- **11 providers, one config shape.** OpenCode Zen (the zero-config default — ships a free-tier key so a fresh install can chat immediately), OpenRouter, Anthropic, OpenAI (key + OAuth + Codex Responses for ChatGPT subscriptions), Z.AI, MiniMax, Groq, DeepSeek, Mistral, Together.ai, Ollama. API keys stored in the OS keychain by default.
- **Native in-process tools** (`fs_*`) — full Kubernetes management surface (~45 tools), no external binary required. Pods (list/get/delete/run/exec/diagnose), arbitrary GVK resources (list/get/delete/scale/apply with SSA / merge-patch / JSON-patch modes), nodes (kubelet logs + stats summary + diagnose), namespaces, events, helm (list/get/history/install/uninstall), metrics (pod + node), prometheus query, log tail with selector fan-out, port-forward open/close/list, HTTP fetch, SubjectAccessReview, workload + rollout status, configuration introspection (including context switch), plus privileged node shell via debug pod and direct SSH fallback. Oversized tool output spools to disk and is paged / grepped on demand.
- **Multimodal chat.** Paste images from the clipboard or attach files; they're sent to vision-capable providers alongside the prompt.
- **Optional external MCP servers.** Plug any number of MCP-protocol servers (filesystem, github, custom) into a chat via `mcp_servers` — stdio (subprocess), Streamable HTTP, or legacy HTTP+SSE transports, each with custom headers and an optional `trust_as_read` bypass of the approval gate. Their tools merge with the native catalogue. Not bundled; not auto-installed.
- **Belt-and-braces TTLs.** Debug pods carry `activeDeadlineSeconds: 900`, so the apiserver reaps orphans even if the chat crashes or the app is force-quit.
- **Approval is never silent.** Write tools always require explicit approval per call; operators can opt into `AllowAllWrites` per chat — never globally.

### Workspace UX
- **Command palette** (⌘K) with global cluster-resource search (FTS5), context switch, kind navigation, settings jump.
- **4 themes, each with multiple palettes.** Default (Helmsman v2, canonical), Lens, VS Code, and Readable — each ships its own typography, sizing, density, and corner-radius profile plus several light/dark palettes (Default's Slate / Forest / Violet, VS Code's Dark+ / Monokai / Solarized, …). Tokens flow one direction: design → `ui/src/theme.ts`, no hardcoded hex across components. Per-window UI scale (⌘+ / ⌘− / ⌘0) stacks on top.
- **Dark console** for logs + embedded terminal, independent of the app theme.
- **Notifications panel**, port-forwards panel, namespace picker, bulk action bar, and a chat dock that minimizes to a pill.
- **Native chrome.** Integrated title bar with traffic-light insets and window vibrancy on macOS; borderless window on Linux.

### Distribution & updates
- **Multi-platform installers** — `.deb`, `.rpm`, `.AppImage` (Linux x64); `.dmg` (macOS x64 + arm64); NSIS `.exe` and `.msi` (Windows x64).
- **AUR**: `ferrisscope-bin` auto-published from CI on every release.
- **In-app updater** for self-managed installs (AppImage, macOS bundle, Windows NSIS). Package-manager installs (apt / dnf / Homebrew / AUR) defer to the system tool with a clear hint instead of silently breaking.

## Install

**Linux** (Debian / Ubuntu / Fedora / RHEL / openSUSE / Arch / NixOS / …):

```bash
curl -fsSL https://raw.githubusercontent.com/dzcorp/FerrisScope/main/packaging/linux/install.sh | bash
```

The script picks `.deb`, `.rpm`, or `.AppImage` based on what's available on the host. Pin a version with `FERRISSCOPE_VERSION=v1.0.0 bash`. Uninstall with `... | bash -s -- --uninstall`. See [`packaging/linux/README.md`](./packaging/linux/README.md) for details.

**macOS** (Apple silicon and Intel):

1. Download the `.dmg` for your architecture (`-macos-arm64.dmg` or `-macos-x64.dmg`) from [Releases](https://github.com/dzcorp/FerrisScope/releases).
2. Open the DMG and drag *FerrisScope.app* into `/Applications`.
3. **First launch:** right-click (or Control-click) *FerrisScope.app* and choose **Open**. macOS will warn that the developer can't be verified — confirm once and the choice sticks. Builds are currently unsigned and unnotarized; manual approval unblocks Gatekeeper. (Notarization is on the v1.0 roadmap.)

   If macOS still refuses to open the app (e.g. *"FerrisScope.app is damaged and can't be opened"*, or **Open** is greyed out):

   ```bash
   sudo xattr -dr com.apple.quarantine /Applications/FerrisScope.app
   ```

**Arch / Manjaro / EndeavourOS** — install from the AUR:

```bash
yay -S ferrisscope-bin     # or: paru -S ferrisscope-bin
```

**Windows** (x64): download the `.exe` (NSIS installer) from [Releases](https://github.com/dzcorp/FerrisScope/releases) and run it. The installer is currently unsigned, so SmartScreen will warn on first run — click **More info → Run anyway**. The in-app updater handles future upgrades.

## Quick tour

1. **Launch FerrisScope.** It loads `~/.kube/config` and any extra sources you've added; if you've never used kubectl on this machine you'll land on an empty fleet view — that's fine.
2. **Pick a cluster** from the fleet landing or via ⌘K → "switch context".
3. **Browse** with the rail (left sidebar) — Workloads → Pods, Network → Services, etc. Tables are virtualized so 5 000-pod namespaces stay snappy.
4. **Open a detail panel.** Click any row. Cross-kind links (owner refs, node, service-account, mounted ConfigMaps / Secrets) navigate inline.
5. **Edit live.** ConfigMap, Secret, ResourceQuota, LimitRange, replicas, PVC storage, plus labels / annotations on opted-in kinds — pencil → edit → Save. Conflicts surface a banner with the colliding manager. Or edit the whole manifest in the YAML tab, `kubectl edit`-style.
6. **Talk to the cluster.** Open the AI dock (right side) — the bundled OpenCode Zen free tier works with zero setup, or pick your own provider — and ask "*why is this pod CrashLoopBackOff?*" The agent runs `fs_pod_diagnose`, pulls events, tails logs, and explains.

## Stack

- **Shell:** Tauri 2 (system webview, ~10–40 MB)
- **Backend:** Rust 1.94+, Tokio (audited feature set), [`kube-rs`](https://kube.rs) (`runtime`, `client`, `ws`, `config`)
- **Allocator:** mimalloc (`#[global_allocator]`), with a tuned Linux purge policy via the `mimalloc-ext` shim
- **Frontend:** React 19 + TypeScript 6 + Vite 8 + Tailwind 4 + Zustand 5
- **Editor:** Monaco
- **Terminal:** xterm.js + portable-pty
- **Tables:** TanStack Table + TanStack Virtual
- **Search index:** rusqlite + FTS5 (bundled SQLite so macOS predates-FTS5 doesn't matter)
- **SSH:** russh (pure Rust async SSH-2)
- **Targets:** Linux x64, macOS x64/arm64, Windows x64.

## Layout

```
crates/
  core/        # cluster engine: kubeconfig, watchers, fleet probes, metrics,
               # Prometheus, port-forwards, prefs, search index. No Tauri deps.
  kube-ext/    # helpers on top of kube-rs: row + detail projections, resource
               # registry, generic dynamic watcher, well-known CRD overrides,
               # fetch / apply / merge-patch / delete / drain / restart.
  agent/       # Tauri-free agent crate: provider abstraction, tool registry,
               # MCP client (stdio / http / sse), native-tool trait, session
               # store, approval gate.
  app/         # Tauri 2 binary: commands, event bridge, terminal PTYs, app
               # state, in-app updater, native agent tools.
  mimalloc-ext/  # safe shim over mimalloc's extended FFI (purge policy,
               # mi_collect, process_info) — isolates the one unsafe block so
               # the rest of the workspace keeps forbid(unsafe_code).
  test-support/  # fixtures + helpers for unit + integration tests.
ui/            # Vite + React frontend. Thin renderer over typed Tauri commands.
e2e/           # Playwright + tauri-driver end-to-end harness (smoke flows).
tests/         # shared on-disk JSON/YAML fixtures (k8s, well-known CRDs).
design/        # Helmsman v2 reference (read-only — source of truth for layout,
               # spacing, motion, tokens). See ./design/icon.md for icon spec.
packaging/
  linux/       # Universal install.sh (.deb / .rpm / .AppImage selector).
.github/
  workflows/   # ci.yml, release.yml (multi-platform bundles + AUR publish).
```

## Architecture

These rules are enforced — see [`CLAUDE.md`](./CLAUDE.md) for the full set:

- **One reflector per `(cluster, resource_kind)`.** Never start a second watch for data already cached.
- **Reflectors are lazy.** Started on first subscribe, torn down a few seconds after the last unsubscribe.
- **A "cluster" owns a task supervisor.** Disconnecting aborts the supervisor — no orphaned tasks, no leaked sockets.
- **`core` has no Tauri dep.** If you find yourself adding `tauri` to `core/Cargo.toml`, stop and reconsider.
- **No `unwrap()` outside tests.** `thiserror` in libraries, `anyhow` in the binary, `tracing` everywhere.
- **TS `strict: true`, no `any`.** Tauri command bindings flow through the typed wrapper in `ui/src/api.ts`.
- **Structured field edits are SSA with a stable field manager** — no per-kind apply functions, the dynamic API covers every kind in the registry. The free-form YAML tab is the deliberate exception: it uses an RFC 7386 merge patch for honest deletes.
- **Auth-plugin failures (gke / aws / oidc) surface as diagnostics, never silent.**

## Develop

Prereqs:

- Rust ≥ 1.94 (stable)
- Node ≥ 22 LTS
- On Linux: `webkit2gtk-4.1`
- Optional: `helm` binary on PATH for Helm install / upgrade / uninstall

```bash
make install        # one-time: npm deps for ui/
make dev            # vite + tauri (auto-detects Linux render path)
make dev-x11        # force XWayland with GPU acceleration (NVIDIA fallback)
make dev-safe       # conservative: WebKitGTK DMA-BUF + compositing off
```

On Linux the binary picks a render path at startup. Default is GPU-accelerated WebKitGTK (DMA-BUF + compositing on); on NVIDIA + Wayland it additionally sets `__NV_DISABLE_EXPLICIT_SYNC=1` to dodge the EGL-Wayland explicit-sync race that crashes WebKit on Plasma 6 / KWin. The chosen mode is logged once at startup as `linux render: mode=… vendor=… session=… applied=[…]`. If you hit a blank window or a crash on first paint (typically older NVIDIA proprietary or broken Mesa stacks), set `FERRISSCOPE_SAFE_MODE=1` or run `make dev-safe`.

`make help` lists everything. Common targets: `check`, `clippy`, `test`, `build-release`, `bundle`.

The Tauri CLI ships via npm (`@tauri-apps/cli`) and runs through the `tauri` script in `ui/package.json`. The `Makefile` invokes `ui/node_modules/.bin/tauri` directly so its project search starts at the repo root (`npm --prefix ui run tauri` would chdir into `ui/` first and miss `crates/app/tauri.conf.json`).

### Build & test

```bash
make fmt               # cargo fmt --all
make check             # cargo check --workspace + tsc --noEmit
make clippy            # cargo clippy --workspace -- -D warnings
make test              # cargo test --workspace
make test-frontend     # vitest run
make test-all          # backend + frontend
make build-release     # release build (frontend bundled)
make bundle            # produce installable bundles via `tauri build`

# integration tests against a kind cluster (Docker required)
make test-integration  # = cargo test --workspace --features integration -- --test-threads=1
```

CI runs `cargo fmt --check`, clippy `-D warnings`, the workspace test suite on Linux + macOS + Windows, and integration tests against two Kubernetes versions. See [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

### Release flow

Tag a commit with `vX.Y.Z` and push — [`.github/workflows/release.yml`](./.github/workflows/release.yml) builds Linux x64, macOS x64/arm64, and Windows x64 bundles in parallel, publishes the GitHub Release, and updates the AUR `ferrisscope-bin` package. Manual `workflow_dispatch` runs are also supported for off-cycle bundles.

## Design system

The visual + interaction reference lives in [`./design/Helmsman v2/`](./design) (`hv2-rail.jsx`, `hv2-dock.jsx`, `hv2-settings.jsx`, `hv2-ui.jsx`, plus `Helmsman v2.html` and `Helmsman v2 - Design principles.html` for previews). It's the **source of truth** for layout, spacing, colors, motion, and component anatomy. Tokens flow one direction: design → `ui/src/theme.ts`. Don't edit `design/` directly — push divergences back into the relevant atom in `ui/src/components/ui/`.

Icons follow a single solid-filled, geometric style (24×24 viewBox, `fill="currentColor"`, no strokes). All glyphs live in `ui/src/components/ui/icons.tsx` (`Icons` for utility, `KindIcons` per Kubernetes kind). See [`design/icon.md`](./design/icon.md) for the spec.

## Contributing

Contributions are welcome — bug reports, fixes, well-known CRD overrides, new kind detail panels, agent tools, packaging recipes. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for setup, the architectural rules above (and in [`CLAUDE.md`](./CLAUDE.md)), the conventional-commits style we use, and the PR checklist. By contributing you agree to release your changes under Apache-2.0.

If you find a security issue, please do **not** open a public issue — see [`SECURITY.md`](./SECURITY.md) for responsible disclosure.

## Acknowledgments

FerrisScope stands on the shoulders of:

- [`kube-rs`](https://kube.rs) — the Kubernetes client + runtime that makes the engine possible.
- [Tauri](https://tauri.app) — the lightweight desktop shell.
- [`russh`](https://github.com/Eugeny/russh) — pure-Rust async SSH-2 client.
- [Monaco Editor](https://microsoft.github.io/monaco-editor/), [xterm.js](https://xtermjs.org/), [TanStack](https://tanstack.com/), and the React + Vite + Tailwind ecosystem.
- The Lens project, for proving the desktop-IDE-for-K8s shape works — and for the UX papercuts that motivated this rewrite.

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).
