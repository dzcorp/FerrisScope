# CLAUDE.md

Operating notes for Claude Code working in this repo. The user-facing pitch, install, layout, and build instructions live in [`README.md`](./README.md). This file is the *how* — rules, conventions, and recipes specific to changing the codebase.

## Naming — don't "fix" these

The display name is **FerrisScope** (mixed case). Everything technical stays lowercase: crates (`ferrisscope-core`, `ferrisscope-kube-ext`, `ferrisscope-agent`, `ferrisscope-app`), the binary `ferrisscope`, the Tauri identifier `dev.ferrisscope.desktop` (Tauri 2 warns against an `.app` suffix on macOS), disk paths under `~/.config/ferrisscope/`, and the SSA field manager constant `"ferrisscope"` (`fetch::FIELD_MANAGER`).

The `core` crate must stay Tauri-free so a future TUI / CLI can reuse the engine. If you're adding `tauri` to `core/Cargo.toml`, stop and reconsider.

## Hard architectural rules

- **One reflector per `(cluster, resource_kind)`.** Never start a second watch for data already cached.
- **Reflectors are lazy** — started on first subscribe, torn down a few seconds after the last unsubscribe.
- **Frontend is a mirror, not a source of truth.** All canonical state lives in Rust.
- **A "cluster" owns a task supervisor.** Disconnecting aborts the supervisor — no orphaned tasks, no leaked sockets.
- **Frontend business logic budget is near zero.** View state in Zustand; everything else over Tauri commands.

## Conventions

- **Rust.** `rustfmt` defaults, `clippy::pedantic` opt-in per crate. Errors via `thiserror` in libraries, `anyhow` in the binary. No `unwrap()` outside tests. Tracing via `tracing` + `tracing-subscriber`, never `println!`.
- **TypeScript.** `strict: true`, no `any`. Tauri command bindings via the typed wrapper in `ui/src/api.ts` — never call `invoke()` with stringly-typed names from components.
- **Commits.** Conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`). Small and reviewable.
- **Task completion check.** Any task touching Rust → `cargo fmt --all -- --check` before reporting done. CI fails on drift.
- **Tests.** Backend: unit tests next to code, integration tests in `tests/` against a `kind` cluster (gated behind the `integration` feature). Frontend: Vitest for utilities; Playwright is reserved for once the UI stabilises.

## Design system

The visual + interaction reference for the **Default theme** lives in [`./design/Helmsman v2/`](./design) (`hv2-rail.jsx`, `hv2-dock.jsx`, `hv2-settings.jsx`, `hv2-ui.jsx`, plus `Helmsman v2.html` for previews). It's the source of truth for layout, spacing, colors, motion, and component anatomy for that theme.

Other themes (Lens, VS Code, Readable) are intentional siblings without matching `hv2-*.jsx` artifacts. They diverge on typography, sizing, chrome, and palette by design. Don't try to "harmonize" them back into Helmsman.

- **Read before you build (Default).** Open the matching `hv2-*.jsx` before changing any UI surface in the Default theme (rail, dock, modal, table, palette, settings, fleet card, status pill, container dot…). Don't reinvent.
- **Don't edit `design/`.** Reference artifact, not application code. Push divergences back into the relevant atom in `ui/src/components/ui/`.
- **Tokens flow one direction: design → `ui/src/theme.ts`.** No hardcoded hex values or pixel paddings inline. New token? Add it to `theme.ts` first and reference *that*. Typography sizes go through the scale steps (`xs/sm/md/lg/xl`), not new literals.
- **Status semantics are fixed.** Buckets (`good` / `warn` / `bad` / `info` / `unknown`) and the transient set (Running / Pending / Terminating / Init / ContainerCreating) are defined once in `theme.ts`. Don't introduce parallel logic; extend the helpers.
- **Reuse atoms.** Container dots, status pills, gauges, loading/empty states have canonical shapes — reuse the existing atoms in `ui/src/components/ui/`.
- **When design and reality conflict** (e.g. very long context names), adapt the layout principle (tile/flex/grid) and push the change back into the atom so every surface benefits.

## Theme system

`ui/src/theme.ts` is the single source of truth for tokens, typography, sizing, and per-theme display options. A "theme" is the whole bundle; a "palette" is the color set within it.

- **Themes shipped**: `default` (Helmsman v2, canonical), `lens`, `vscode`, `readable`. Each ships with at least one palette plus its own `Typography`, `Sizing`, and `Display` defaults.
- **Resolver**: `resolveTheme({ themeId, paletteId, mode, overrides }) → ResolvedTheme`. Components read it via `useResolvedTheme()` in `store.ts`. The legacy `tokens(mode)` helper still returns the Default theme's palette and stays in place for the migration tail — new code prefers `useResolvedTheme()`.
- **CSS custom properties.** `App.tsx` publishes the active theme as `:root` custom props on every render: `--fs-font-sans`, `--fs-font-mono`, `--fs-fs-{xs,sm,md,lg,xl}`, `--fs-radius-{sm,md,lg}`, `--fs-control-h`, `--fs-border-w`. Components read them via `var(--fs-fs-md, 12.5px)` so anything not yet swept still works via the literal fallback.
- **Atom convention** (`ui/src/components/ui/atoms.tsx`): module-level constants `FS_XS / FS_SM / FS_MD / FS_LG / FS_XL` and `FF_MONO` wrap the CSS vars + fallbacks. Use those instead of inline `fontSize: 12` / `fontFamily: FONT_MONO`. Same pattern in `ResourceTable.tsx` for the hot cell styles (`TABLE_FS_CELL`, `TABLE_FONT_MONO`) — kept module-level so React's referential-equality short-circuit still applies.
- **Density + monoTables are theme-seeded, user-overrideable.** `setTheme(themeId)` writes the new theme's `display.densityDefault` and `display.monoTablesDefault` into `settings`; the Settings → Appearance toggles still win afterward.
- **UI Scale stacks on top.** `theme.typography.base` is the baseline; the UI Scale slider continues to apply via `document.documentElement.style.zoom` on top of that.
- **Adding a theme** is rare (Lens / VS Code / Readable already cover the spread). When it happens: add a `Theme` literal to `THEMES` in `theme.ts` and a swatch in the Settings picker. No backend changes — `prefs.theme.id` is a plain string and unknown ids fall back to Default at resolve time.
- **Don't rename a shipped theme id.** Persisted prefs reference ids verbatim. If you must, add a migration in `crates/core/src/prefs.rs::parse()` (the legacy bare-string-theme handling via `ThemePrefsWire` is the precedent).

## Icons

Glyph set lives in `ui/src/components/ui/icons.tsx` (`Icons` for utility, `KindIcons` keyed by Kubernetes kind). All drawn in the same solid-filled, geometric style: 24×24 viewBox, `fill="currentColor"`, no strokes.

- **Read [`design/icon.md`](./design/icon.md) before adding or modifying any icon.** Solid filled shapes, flat, monochrome, strong silhouette. No strokes, no gradients, no decorative detail.
- **Reuse the `filled(size, content)` helper.** Don't hand-roll a new `<svg>` wrapper.
- **One glyph per Kubernetes kind** in `KindIcons`, keyed by the exact `kind` string (`"Pod"`, `"ConfigMap"`, …). Unknown kinds (CRDs) fall back to the category icon — that's intentional, don't paper over it.
- **Don't inline SVGs in components.** Add to `Icons` / `KindIcons` first.

## Detail-panel primitives

Every kind's detail panel composes the same kind-agnostic primitives in `ui/src/components/detail/`. **Do not inline equivalents** — extend the primitives.

### Layout primitives (`ui/src/components/detail/primitives.tsx`)

| Primitive | Use for |
|---|---|
| `<DetailRow t label>` | Label/value row, fixed 180px label, value-side flex-wraps. The atomic building block — every named field. |
| `<SubGrid t entries\|groups copyKeyJoin>` | Indented sub-rows under a parent `DetailRow`. `groups` for multi-section (Resources → Requests + Limits); `entries` for flat lists (env vars, mounts, last-state fields). |
| `<Copyable text>` | Click-to-copy wrapper with `.fs-copy-flash` pulse. Every value the operator might want to grab. |
| `<LinkValue t onClick copyText enabled>` | Cross-kind navigation. Click → opens that object's detail; ⌘/Ctrl-click → copies. Owner refs, node names, service-account refs, image-pull-secret refs, volume sources. |
| `<ChipWrap>` | Flex-wrap container for chips. |
| `<KeyValueChips t pairs>` | Renders `[string, string][]` as `Copyable<Chip>` "k=v" chips. Labels, node selectors, annotation displays. |
| `<ChipStrip t items mono>` | Small chips with `tone: "default" \| "warn" \| "bad"` and optional per-chip `copy`. Boolean flags (privileged, hostNetwork, capabilities). |
| `<ConditionChip t cond invert>` | True/False/Unknown coloured chip. `invert` for "True is bad" conditions (NodeMemoryPressure, NodeDiskPressure). |
| `<Mute t>` | Small dim text — placeholders ("—"), captions. |

### Behaviour helpers

- `useCopyFlash<T>()` — `[ref, flash]`. Apply `ref` to any element; `flash()` re-triggers `.fs-copy-flash`. For copy ack on a custom element rather than `Copyable`.
- `ageFromIso(iso)` — relative duration ("3m", "5h", "2d"). Returns "—" on parse failure.
- `DetailNavigate` — `(kindName, namespace, name) => void`, plumbed by the parent (`DetailPanel` → `ResourceTable`). Each summary takes it as an optional prop and forwards to `LinkValue`.

### How to add a kind's detail (recipe)

1. **Backend.** `crates/kube-ext/src/kinds/<kind>.rs` — add `pub fn project_detail(<K>: &K) -> serde_json::Value` next to the existing row `project()`. Keep on-demand — don't stuff into the row payload (those go over the bus on every update).
2. **Backend.** `crates/kube-ext/src/fetch.rs` — `pub async fn get_<kind>_detail(client, namespace, name) -> Result<Value, FetchError>`; re-export from `lib.rs`.
3. **Backend.** `crates/app/src/commands.rs` — Tauri command `get_<kind>_detail_cmd`; register in `main.rs`.
4. **Frontend.** `ui/src/types.ts` — `<Kind>Detail` + nested types. Strict, no `any`.
5. **Frontend.** `ui/src/api.ts` — `api.get<Kind>Detail(...)`.
6. **Frontend.** `<KindSummary>` (in `DetailPanel.tsx` or its own file under `components/detail/<kind>/`). Fetch on mount + on `detailVersion` bump. Compose with `<DetailRow>`, decompose nested structs with `<SubGrid>`, use `<LinkValue>` for cross-kind refs, everything else `<Copyable>`.
7. **Frontend.** Wire `<KindSummary>` into `DetailPanel.tsx`'s tab dispatch.

### Style rules

- **No inline hex.** Every colour comes from `theme.ts` tokens via the `Tokens` type.
- **No new chip / row variants.** Extend the existing primitive (add a prop) — don't fork.
- **Always `<Copyable>`.** Operators copy values constantly; missing copy support is a bug.
- **Use `<LinkValue>` for any K8s reference.** Even if the target kind isn't browseable yet, pass `enabled={!!onNavigate}` — it'll degrade to plain copy.
- **Sections via `<Section t title right>`** (from `ui/atoms.tsx`), not custom headers. The `right` slot carries counts + metadata.
- **One DetailRow per concept**, even if multi-line. `wordBreak: "break-all"` and `<SubGrid>` exist for that.

## Inline editing (Server-Side Apply)

Every editable surface goes through the **same edit kit** in `ui/src/components/detail/edit.tsx`. Don't fork — extend. Live precedents: ConfigMap / Secret / ResourceQuota / LimitRange data sections, and `MetaSection`'s Labels / Annotations rows (any kind can opt in).

### Backend contract

- Patches go through `apply_resource_cmd` → `apply_resource()` in `crates/kube-ext/src/fetch.rs`.
- Field manager is the constant `"ferrisscope"` (`fetch::FIELD_MANAGER`). **Don't introduce per-kind managers** — SSA's per-field ownership tracking depends on a stable name across edits from this app.
- The frontend sends only the field tree it owns (e.g. `{ data: { ... } }`, `{ spec: { hard: { ... } } }`, `{ metadata: { labels: { ... } } }`). The helper attaches `apiVersion` / `kind` / `metadata.name` / `metadata.namespace`.
- 409s surface as `ApplyResult::Conflict { managers, fields, message }`. UI shows them in `ConflictBanner` with a "Force takeover" action that re-invokes with `force: true`. **Never default to `force: true` in client code.**
- Adding an editable kind does **not** need a new backend command — the dynamic API covers every kind in the registry. If you're writing a per-kind apply fn, you're probably trying to do something other than SSA (e.g. subresource scale) — surface that.

### Frontend kit

| Primitive | Use for |
|---|---|
| `useApply<B>({ target, initial, serialize, dirtyCount, onSaved })` | Every editable section's lifecycle hook. Owns buffer, dirty count, save state machine, conflict surface. `serialize` returns the partial-object SSA payload. `onSaved` typically bumps a refetch counter. |
| `<EditModeChrome editing dirty saving onEnter onCancel onSave rightExtra/>` | Drop-in for `<Section>`'s `right` slot. Renders pencil → Save (N) / Cancel chips. |
| `<RowDeleteButton onClick/>` | The × on every editable row. Soft-delete (toggle `deleted` in the buffer); existing rows render struck-through with Restore tooltip; new rows are removed. |
| `<EditableTextValue value onChange invalid multiline/>` | Single + multi-line input atom. Auto-promotes to `<textarea>` when the value contains `\n` or exceeds ~60 chars. `invalid` for the red outline. |
| `<AddRowButton label onClick/>` | Dashed `+ Add` button under each editable section. |
| `<ConflictBanner conflict onForce onDismiss/>` | Amber 409 surface. Renders managers + field paths + raw message; "Force takeover" re-invokes with `force: true`. |
| `<KvEditor buffer onChange duplicates validateKey .../>` + `kvBuffer*` helpers | Generic key→value editor. Use for any `Record<string, string>` (labels, annotations, ConfigMap/Secret data) instead of writing a bespoke buffer. |

### Per-kind buffer pattern

When a kind needs more than `KvEditor` (Secret has reveal state, ResourceQuota carries `used`, LimitRange has nested groups), follow `ui/src/components/detail/config/index.tsx`:

1. `<Kind>Buffer` type — stable `id` per row, `originalKey`/`originalValue` for dirty detection, `isNew` and `deleted` flags, `nextId: number` for monotonic id allocation.
2. Pure functions: `bufferFrom<Kind>(detail)`, `<kind>DirtyCount(buffer)`, `validate<Kind>Buffer(buffer)`, `serialize<Kind>Buffer(buffer)`. No React.
3. Wire into `useApply<<Kind>Buffer>`. Render rows with kit primitives. Single baseline grid (e.g. `180px | 1fr | auto | auto`) — don't stack key above value.
4. Validate at the boundary (key regex, base64 form, `parseQuantity`); surface failures as `<InlineError>` above the rows. Save stays enabled — the apiserver is the final arbiter — but the user sees the issue first.

### Refetch after save

Each editable summary holds a local `const [refetch, setRefetch] = useState(0)` and includes it in `useDetail` deps. `onSaved` bumps it; the watcher will also bump `detailVersion` shortly after — both coalesce harmlessly. Don't rely on the watcher alone; the save-confirm UX feels broken if rows don't refresh immediately.

### Opting an existing kind into label/annotation editing

Pass `editTarget={{ clusterId, kindId, namespace, name }}` and `onSaved` to `<MetaSection>`. Labels and Annotations rows pick up the pencil + KvEditor automatically. Don't pass either when the kind shouldn't be editable yet — opt in incrementally as we build confidence.

### What edits to NOT allow

- **Subresource fields** (`status.*`) — SSA against status requires a different subresource path; not currently supported.
- **Immutable-marked objects** (ConfigMap / Secret with `immutable: true`) — show `InlineWarn` and let the apiserver reject; don't pre-block client-side.
- **Anything that needs a different field manager.** If you think you do, push back to the user — diverging managers loses the ownership benefits SSA gives us.

## Well-known CRD overrides

Some CRDs (Gateway API today; Argo / Flux / Cert-Manager / Istio / Tekton later) ship as `DynamicObject` watches but deserve first-class treatment in the rail without dragging in a Rust crate per ecosystem. The overrides layer in `crates/kube-ext/src/well_known.rs` handles this. Watcher path stays generic; what changes is projection + display metadata.

### When to use

All three must hold:
- The CRD is widely deployed and operators expect to navigate it by name.
- The default 3-column projection (name / namespace / age) hides everything that matters.
- You don't want a typed Rust dep for the API group (version skew, build cost).

If not, leave it on the generic dynamic path — Custom Resources is the right home for the long tail.

### Mechanism

- **`WellKnownCrd`** — static descriptor: `short_id` (stable, frontend-visible), `group`, `kind`, `category`, plus three function pointers: `columns()`, `project(&DynamicObject) -> Value`, `project_detail(&DynamicObject) -> Value`.
- **`well_known::registry()`** — flat `&'static [WellKnownCrd]` aggregating per-ecosystem submodules.
- **`registry::ResourceKindEntry::from_dynamic_crd`** — when CRD discovery surfaces a kind, it consults `well_known::lookup_by_gk(group, kind)`. Hit → carry the override's id, category, columns, projection. Miss → fall back to the generic `crd:` path.
- **Id format:** `wkcrd:<short>|<group>|<version>|<plural>|<kind>|<scope>`. Self-contained — no per-cluster cache. `version` and `plural` come from CRD discovery so we don't hard-code (e.g.) HTTPRoute at v1 and break clusters still on v1beta1.
- **Generic detail fetch:** `fetch::get_well_known_detail(client, kind_id, ns, name)` — one Tauri command (`get_well_known_detail_cmd`) serves every override. Adding a new ecosystem doesn't add a backend command.

### How to add an ecosystem (recipe)

1. **Backend.** New `crates/kube-ext/src/well_known/<ecosystem>.rs` with `pub static OVERRIDES: &[WellKnownCrd] = &[…]`. Use the `arr_at` / `str_at` / `obj_get` / `dyn_meta_value` helpers in `well_known.rs` — projections must be total, never panic on shape drift.
2. **Backend.** `pub mod <ecosystem>;` in `well_known.rs`; concatenate its `OVERRIDES` into `well_known::registry()`.
3. **Frontend.** `<Kind>Detail` types in `ui/src/types.ts`. Strict, no `any`.
4. **Frontend.** Summary components in `ui/src/components/detail/<ecosystem>/index.tsx`. They take `kindId: string` (the full `wkcrd:` id) and call `api.getWellKnownDetail<T>(clusterId, kindId, namespace, name)` — the generic getter is already wired. Compose standard primitives.
5. **Frontend.** `DetailPanel.tsx` — add the new `short_id`s to `WELL_KNOWN_SUMMARY_SHORTS` and a `case` in the `wkShort` dispatch block. Don't touch `SUMMARY_KINDS` or the typed switch.
6. **Frontend.** Add a glyph per kind to `KindIcons`, keyed by the Kubernetes `kind` string.

### Rules

- **Never pull in a typed Rust crate for an ecosystem we override.** Walk the unstructured JSON; tolerate missing fields.
- **`short_id` must not collide** with built-in kind ids or other overrides.
- **Projections must be total.** `as_str() / as_array()` returning `None` is the norm on shape drift; project to `null` or `—`. `arr_at` returns `&[]` when missing.
- **Don't promote a CRD to a built-in category if its install footprint is rare.** Custom Resources is the right home for the long tail.
- **Version is per-cluster.** Override entries declare `(group, kind)` only — `version` and `plural` come from CRD discovery and are embedded in the runtime id. Don't hard-code a version in projection logic.

Currently overridden: Gateway API (`gateway.networking.k8s.io`) — promoted to **Network**: GatewayClass, Gateway, HTTPRoute, GRPCRoute, ReferenceGrant. See `crates/kube-ext/src/well_known/gateway_api.rs` + `ui/src/components/detail/gateway/index.tsx`.

## Agent tools (native + optional MCP)

The chat agent runs an LLM loop. Native (in-process) tools cover the full Kubernetes management surface; an external MCP server is optional and operator-configured.

1. **Native (in-process) tools** — `crates/app/src/agent_native/`, registered through the `NativeTool` trait in `crates/agent/src/native.rs`. The complete K8s toolkit lives here: pods (list/get/delete/run/exec), arbitrary GVK resources (list/get/delete/scale/apply), nodes (kubelet logs + stats summary + diagnose), namespaces, events, helm (list/get/history/install/uninstall), metrics, prometheus, port-forwards, node shells, configuration introspection, plus app-resident capabilities (supervisor inspection, terminal handoff, privileged node shells).
2. **External MCP server (optional)** — operator-configured via `mcp_binary_path` in AI settings. **Not bundled** — there is no installer or auto-detect; the binary must already exist on disk. We spawn it per chat and merge its tools with the native catalogue. Useful for non-K8s MCP servers (filesystem, github, custom) since native tools already cover Kubernetes.

Both surface as the same `ToolSchema`, hit the same `ApprovalMode` gate, and appear in the `chat_list_tools` inspector tree.

### Hard rules

- **Native is the full kubernetes toolkit.** The chat must work end-to-end against any cluster with no MCP binary configured. Don't add features that depend on a specific external MCP server being present.
- **Name native tools `fs_<area>_<verb>`.** The `fs_` prefix prevents collisions with any external MCP server's namespace. On collision MCP wins (registered first); just don't collide.
- **Each tool declares its own `category()`.** The name heuristic in `mcp::classify` is for external MCP tools we don't control. Native tools know exactly whether they read or write — return `Write` for anything that mutates cluster state, runs commands on a node, or grants the agent elevated privileges. `Unknown` is treated as Write by the approval gate.
- **Stay Tauri-free in the agent crate.** The `NativeTool` trait lives in `crates/agent/`. Concrete impls live in `crates/app/src/agent_native/` where they can hold `tauri::AppHandle`, look up `AppState`, talk to the kube `Client`. Don't push Tauri types down into the trait.
- **Per-call timeout is enforced by the loop, not by the tool.** `agent.rs` wraps every native call in `TOOL_CALL_TIMEOUT`. Tools may apply tighter internal timeouts (e.g. `fs_node_shell_exec`'s `timeout_seconds` arg).
- **Errors are values, not panics.** Return `NativeToolError::Failed(...)`; the loop turns it into `is_error: true` so the LLM can recover. Never `unwrap()` on cluster state, JSON shape, or kube responses.
- **Anything you allocate, you clean up.** External state (debug pods, port-forwards, ephemeral files, child processes) → implement `on_chat_close`. Hook fires from `chat_close` (operator close, app shutdown, *and* cluster switch — switching cluster means closing the chat and opening a new one against the new cluster). Best-effort; log failures, never propagate.
- **Belt-and-braces for cluster-resident state.** Don't rely on `on_chat_close` alone — set a server-side TTL so orphans get reaped after crashes / force-quits. Pods: `spec.activeDeadlineSeconds`. Jobs: `spec.ttlSecondsAfterFinish`. Node-shell pod uses 5 minutes (`POD_TTL_SECONDS` in `node_shell.rs`).
- **Tell the LLM about lifetime in the tool's `description`.** If a session has a TTL or auto-closes, say so explicitly so the model plans around it.

### How to add a new native tool (recipe)

1. **Decide the surface.** One tool per discrete operation. Stateful (multi-call session like `fs_node_shell_*`) → design open / exec / close as three separate tools sharing a session table.
2. **Backend.** New file under `crates/app/src/agent_native/<area>.rs`. Define a struct per tool (`AppHandle`, `cluster_id`, shared session table…). Impl `NativeTool`: `schema()` returns `{ name, description, parameters }`, `category()` returns the truth, `call(args)` does the work, `on_chat_close` releases external state.
3. **Backend.** Register in `agent_native::build_registry`. Order doesn't matter; keep related tools adjacent.
4. **Backend.** No new Tauri command — `chat_*` already routes everything. `chat_list_tools` and the merged-schemas pipeline pick up new tools automatically.
5. **Frontend.** No type changes if the wire shape stays as `ChatToolWire`.
6. **Test.** `cargo fmt --all -- --check` + `cargo check --workspace` + `cargo clippy -p ferrisscope-agent -p ferrisscope-app -- -D warnings`. Spin a chat against a `kind` cluster and verify (a) inspector visibility, (b) approval if Write, (c) result rendering, (d) cleanup on chat-close / cluster switch.

### What native tools should NOT do

- **Don't add a duplicate of an existing native tool.** Check `agent_native/` first; the K8s toolkit is comprehensive (pods, resources/GVK, nodes, namespaces, events, helm, metrics, prometheus, port-forwards, node shells, configuration). Extend an existing tool with a new arg before forking a new file.
- **Don't bypass the approval gate.** Even if "obviously safe", classify correctly and let the operator's `ApprovalMode` decide. Operators can opt into `AllowAllWrites` per chat — don't make that decision for them.
- **Don't store mutable state in the tool struct itself.** Use an `Arc<Mutex<…>>` shared across related tools (see `NodeShellSessions`). Single-tool state is fine if it's truly per-tool.
- **Don't promote a native tool to an MCP server prematurely.** If we ever need *external* MCP clients (Claude Desktop, Cursor) to use these, we can stand up an in-process MCP server — `crates/agent/src/mcp/mod.rs::McpClient` already takes any `AsyncRead`/`AsyncWrite` pair so a duplex pipe works without a second process. Future move; today, native is faster, simpler, and avoids a second framing layer.

For the current shipping inventory of native tools, the sources live in `crates/app/src/agent_native/` (one file per area) — that's the authoritative list. Per-release deltas are on the [GitHub releases page](https://github.com/dzcorp/FerrisScope/releases).

## Working with kube-rs

- Prefer `kube::runtime::reflector` and `Controller` over raw `watcher` streams. They handle 410 Gone, resync, and bookmarks correctly.
- Use the dynamic API (`DynamicObject`, `ApiResource`) for CRD support. Don't hand-roll typed structs for every CRD a user might have.
- For pod exec / attach use `AttachParams` and stream over Tauri events. Backpressure matters — if the frontend can't keep up, drop, don't buffer unbounded.
- Auth plugins (gke / aws / oidc) shell out via `kube-rs` exec auth. Surface plugin failures clearly in a diagnostics panel — silent auth failures are the #1 Lens UX papercut we want to fix.

## Out of scope

See the corresponding section in [`README.md`](./README.md). Don't drift here; if a request points at one of those areas, push back and link to it.

## When in doubt

Code wins over docs. The rules above describe what the codebase enforces today; if you find a divergence, fix it in the same change rather than papering over it. For strategic questions (scope, milestones, open decisions), surface them to the user before settling them silently in code.
