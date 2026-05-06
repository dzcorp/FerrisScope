# Contributing to FerrisScope

Thanks for your interest in contributing! This document covers how to get a development build running, the conventions the project follows, and the checklist a PR should clear before review.

For the *why* behind specific architectural choices, read [`README.md`](./README.md). For the full set of internal rules — including the ones AI assistants follow — read [`CLAUDE.md`](./CLAUDE.md). They are the source of truth; this file is a friendlier on-ramp.

---

## Ways to contribute

- **Bug reports and reproductions** — open an issue with the [Bug report](.github/ISSUE_TEMPLATE/bug_report.yml) template. A minimal kubeconfig + cluster shape (kind / vanilla / managed / version) helps a lot.
- **Feature requests** — open a [Feature request](.github/ISSUE_TEMPLATE/feature_request.yml) issue. Sketching the *user-visible* behaviour is more useful than a proposed implementation.
- **Well-known CRD overrides** — Argo, Flux, Cert-Manager, Istio, Tekton are all on the v1.0 roadmap. Each one is a self-contained module under `crates/kube-ext/src/well_known/<ecosystem>.rs` plus a summary component under `ui/src/components/detail/<ecosystem>/index.tsx`. Recipe and rules in [`CLAUDE.md` § Well-known CRD overrides](./CLAUDE.md#well-known-crd-overrides).
- **New kind detail panels** — pick a Kubernetes kind not yet in `SUMMARY_KINDS`, follow the recipe in [`CLAUDE.md` § Detail-panel primitives](./CLAUDE.md#detail-panel-primitives). Compose existing primitives — don't fork them.
- **Agent native tools** — anything stateful in the running app (port-forwards, terminals, local fetches). Recipe and rules in [`CLAUDE.md` § Agent tools](./CLAUDE.md#agent-tools-native--mcp).
- **Packaging** — auditing the `.deb` / `.rpm` / `.AppImage` / `.dmg` / `.exe` recipes is on the v1.0 to-do list.
- **Documentation** — clearer install instructions, screenshots, troubleshooting recipes for cluster setups we don't currently cover.

If you're not sure where a change belongs, open an issue first and we'll point you at the right crate or component.

---

## Development setup

### Prerequisites

- **Rust ≥ 1.94** (stable toolchain, see `rust-version` in [`Cargo.toml`](./Cargo.toml))
- **Node ≥ 22 LTS** (for the Vite + React frontend and the Tauri CLI)
- **Linux only:** `webkit2gtk-4.1` development headers (`apt install libwebkit2gtk-4.1-dev` / `dnf install webkit2gtk4.1-devel`)
- **Optional:** `helm` binary on PATH, for Helm install / upgrade / uninstall flows
- **Optional:** Docker + [`kind`](https://kind.sigs.k8s.io/) for the integration test suite

### Bootstrap

```bash
git clone https://github.com/dzcorp/FerrisScope.git
cd FerrisScope
make install        # one-time: npm install in ui/
make dev            # vite + tauri dev loop (auto-detects Linux render path)
```

`make help` lists every target. The most common ones during day-to-day work:

| Command            | What it does |
|--------------------|--------------|
| `make dev`         | Hot-reload dev loop (Vite + Tauri). Default Linux render path. |
| `make dev-x11`     | Force XWayland — use if native Wayland flickers. |
| `make dev-safe`    | Conservative WebKitGTK config — use if `make dev` blank-screens. |
| `make check`       | `cargo check --workspace` + `tsc --noEmit`. Fast type-checking. |
| `make clippy`      | Workspace clippy with `-D warnings`. CI fails on warnings. |
| `make test`        | Backend unit tests. |
| `make test-frontend` | Frontend unit tests (Vitest). |
| `make test-all`    | Backend + frontend. |
| `make build-release` | Release build, frontend bundled. |
| `make bundle`      | Produce installable bundles via `tauri build`. |

Integration tests against a real `kind` cluster are gated behind a feature flag so local dev without Docker still works:

```bash
cargo test --workspace --features integration -- --test-threads=1
```

---

## Architectural rules

These are enforced — reviewers will ask for changes that violate them. See [`CLAUDE.md`](./CLAUDE.md) for the full set; the highlights:

- **One reflector per `(cluster, resource_kind)`.** Never start a second watch for data already cached.
- **Reflectors are lazy.** Started on first subscribe, torn down a few seconds after the last unsubscribe.
- **A "cluster" owns a task supervisor.** Disconnecting aborts the supervisor — no orphaned tasks, no leaked sockets.
- **`crates/core` has no Tauri dep.** It must stay reusable so a future TUI / CLI can share the engine.
- **No `unwrap()` outside tests.** `thiserror` in libraries, `anyhow` in the binary, `tracing` everywhere.
- **TS `strict: true`, no `any`.** All Tauri command bindings flow through the typed wrapper in `ui/src/api.ts`.
- **All edits are SSA with the stable `"ferrisscope"` field manager.** No per-kind apply functions.
- **Auth-plugin failures (gke / aws / oidc) surface as diagnostics, never silent.**
- **Frontend business logic budget is near zero.** View state in Zustand; everything else over Tauri commands.

If you find a divergence between code and these rules, fix it in the same change rather than papering over it.

---

## Coding conventions

### Rust

- `rustfmt` defaults — no custom config beyond the workspace `rustfmt.toml`.
- `clippy::pedantic` opt-in per crate; CI runs `cargo clippy --workspace -- -D warnings`.
- Errors via `thiserror` in libraries, `anyhow` in the binary.
- Tracing via `tracing` + `tracing-subscriber` — never `println!`.
- `unsafe_code = "forbid"` workspace-wide.

### TypeScript

- `strict: true`. No `any`.
- Tauri command bindings live in `ui/src/api.ts` — never call `invoke()` with stringly-typed names from components.
- View state in Zustand (`ui/src/store.ts`); component-local state for ephemeral UI.
- Theme tokens from `ui/src/theme.ts` — no hardcoded hex values. If you need a new token, add it there first.
- Detail panels compose the kind-agnostic primitives in `ui/src/components/detail/primitives.tsx`. Don't inline equivalents.

### Commits

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: add Argo Application override`
- `fix: drop port-forward listener when last subscriber disconnects`
- `refactor: split fetch.rs into apply.rs + delete.rs`
- `chore: bump kube to 3.2`
- `docs: clarify SSA conflict semantics in README`

Keep commits small and reviewable; one logical change per commit.

### Task-completion check

After completing any task that touches Rust code, run before opening a PR:

```bash
cargo fmt --all -- --check
make clippy
make test
```

CI fails on formatting drift, clippy warnings, and test failures — running these locally first saves a round-trip.

---

## Pull request checklist

When you open a PR, the [`PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md) walks you through the checklist. The short version:

- [ ] Conventional commit subject in the PR title.
- [ ] `cargo fmt --all -- --check` clean.
- [ ] `make clippy` clean (`-D warnings`).
- [ ] `make test` passes; `make test-frontend` passes if you touched `ui/`.
- [ ] No `unwrap()` outside `#[cfg(test)]`.
- [ ] No `any` in TypeScript; no hardcoded hex values; no `invoke()` with string names.
- [ ] Architectural rules above are satisfied.
- [ ] If you added a Tauri command, it's typed in `ui/src/api.ts`.
- [ ] If you added a kind detail panel, you composed existing primitives (no fork).
- [ ] If you added an agent tool, it's named `fs_<area>_<verb>`, classifies its `category()` correctly, and cleans up via `on_chat_close` if it allocates external state.
- [ ] If you changed user-visible behaviour, updated `README.md` and/or `CHANGELOG.md`'s `[Unreleased]` section.

Reviewers will look for these explicitly. Self-review before submitting.

---

## Code of Conduct

This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md). By participating, you agree to abide by its terms. Report unacceptable behaviour to **yzhelezko@gmail.com**.

---

## Reporting security issues

Please **do not** open a public issue for security vulnerabilities. See [`SECURITY.md`](./SECURITY.md) for the responsible-disclosure process.

---

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](./LICENSE) — the same license as the rest of the project. There is no separate CLA; the Apache-2.0 grant in [§5](./LICENSE) (Submission of Contributions) covers your contribution.

---

Thanks for helping make FerrisScope better. If anything in this guide is unclear, that itself is a documentation bug — please open an issue.
