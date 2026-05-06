<!--
Thanks for opening a pull request! A short description plus the checklist below
makes review faster. See CONTRIBUTING.md for the full guidance.
-->

## Summary

<!-- What does this PR do, and why? One or two sentences is usually enough. -->

## Related issues

<!-- Closes #123, refs #456. Leave blank if unrelated. -->

## Type of change

<!-- Tick the one that fits. -->

- [ ] Bug fix (non-breaking change that resolves a defect)
- [ ] Feature (non-breaking change that adds capability)
- [ ] Refactor (no functional change)
- [ ] Documentation
- [ ] Build / CI / packaging
- [ ] Other (describe below)

## How was this tested?

<!--
Describe the tests you added or ran. For UI changes, mention the cluster shape
and steps you reproduced (`make dev`, `kind` cluster, etc.). For backend, list
the affected unit / integration tests.
-->

## Screenshots / recordings (UI changes only)

<!-- Drop them here if relevant. Otherwise, delete this section. -->

## Checklist

<!-- All boxes should be ticked before review. -->

- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:` …).
- [ ] `cargo fmt --all -- --check` is clean.
- [ ] `make clippy` is clean (`-D warnings`).
- [ ] `make test` passes; `make test-frontend` passes if I touched `ui/`.
- [ ] No `unwrap()` outside `#[cfg(test)]`.
- [ ] No `any` in TypeScript; no hardcoded hex values; no `invoke()` with stringly-typed names.
- [ ] Architectural rules from `README.md` / `CLAUDE.md` are satisfied (one reflector per `(cluster, kind)`, lazy lifecycle, `core` has no Tauri dep, SSA with `"ferrisscope"` field manager).
- [ ] If I added a Tauri command, it is registered in `main.rs` and typed in `ui/src/api.ts`.
- [ ] If I added a kind detail panel, I composed existing primitives — no fork.
- [ ] If I added an agent tool, the name follows `fs_<area>_<verb>`, `category()` is correct, and `on_chat_close` cleans up any external state.
- [ ] User-visible changes are reflected in `CHANGELOG.md`'s `[Unreleased]` section.
- [ ] I am the author of these changes (or have permission), and I agree to release them under Apache-2.0.

## Notes for reviewers

<!--
Anything that would help review: trade-offs you considered, follow-ups you
deliberately deferred, areas you'd like a second opinion on.
-->
