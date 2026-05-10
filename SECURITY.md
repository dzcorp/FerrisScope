# Security Policy

## Supported versions

FerrisScope is in its v1.0 polish phase. While we work toward the first tagged release, security fixes will land on `main` and ship in the next available release.

| Version       | Supported |
|---------------|-----------|
| `main` branch | ✅        |
| Pre-`v1.0` tagged releases | ✅ — patched in the next release |
| Pre-release dev builds | ❌ — please re-test against `main` |

Once v1.0 ships, this table will be updated with a clear "latest minor version is supported" rule.

---

## Reporting a vulnerability

**Please do not open a public GitHub issue, pull request, or discussion for security-relevant findings.** Public reports give attackers a head start on users who haven't updated yet.

We accept reports through two channels — pick whichever you're more comfortable with:

### 1. GitHub Security Advisories (preferred)

Open a private advisory at <https://github.com/dzcorp/FerrisScope/security/advisories/new>. This keeps the entire conversation, fix, and CVE coordination in one place and only the reporter, the maintainers, and (later) any embargoed downstream are involved.

### 2. Email

Send a report to **yzhelezko@gmail.com** with:

- A descriptive subject — e.g. `[FerrisScope security] kubeconfig path traversal`.
- A clear description of the issue and the impact (what an attacker can do).
- Steps to reproduce — ideally a minimal proof-of-concept against `make dev` or a tagged build.
- The version, OS, and (where relevant) cluster setup you tested against.
- Whether you'd like to be credited in the eventual advisory, and under what name.

If you're a security researcher and want to encrypt the report, mention that in the first message and we'll coordinate a key exchange.

---

## What you can expect from us

- **Acknowledgement within 72 hours** of receipt of a report (sooner if at all possible).
- **An initial assessment** — severity, affected components, whether we can reproduce — within 7 days.
- **Regular status updates** at least weekly while a fix is in progress.
- **Coordinated disclosure** — we'll publish the advisory and the fix together. If the issue affects a downstream packager (Linux distros, Homebrew, AUR), we'll coordinate so they can ship the fix at the same time.
- **Public credit** in the advisory and the release notes, unless you'd rather stay anonymous.

We don't currently have a paid bug-bounty program, but every valid report gets credited prominently.

---

## Scope

In scope:

- The FerrisScope desktop binary (Tauri shell, Rust backend, React frontend).
- The `crates/core`, `crates/kube-ext`, `crates/agent`, `crates/app` workspace.
- The Linux universal installer at `packaging/linux/install.sh` and the GitHub Actions release pipeline.
- The in-app updater path (signature verification, asset selection, atomic replace).
- The agent's Server-Side Apply path, native tools, and MCP integration — anything that mutates cluster state.
- Credential handling (kubeconfig parsing, OS keychain integration, SSH passphrases, agent provider API keys).

Out of scope:

- Vulnerabilities in upstream Kubernetes itself, `kube-rs`, Tauri, WebKitGTK, or other dependencies — please report those upstream. We will coordinate version bumps once they ship.
- Issues that require an attacker who already has root on the user's machine, full filesystem access, or the ability to swap arbitrary binaries on `$PATH`.
- The contents of any cluster the user connects to. FerrisScope reads what kubeconfig + RBAC let it read; misconfigured cluster RBAC is not a FerrisScope vulnerability.
- Generic UX bugs, crashes without a security impact, or denial of self (the user can always close the app).

If you're unsure whether something is in scope, send the report anyway — we'd rather triage borderline cases than miss something real.

---

## Hardening posture

A few things to know if you're auditing FerrisScope:

- `unsafe_code = "forbid"` workspace-wide — there is no Rust `unsafe` in our code (only in dependencies).
- `panic = "abort"` in release — we don't catch panics, so a panic terminates the process; please don't rely on a recovery path.
- `rustls-only` with the `ring` provider, set process-wide in `main.rs`. We do not link against OpenSSL, BoringSSL, or aws-lc-rs.
- API keys and SSH passphrases live in the OS keychain by default. Plaintext fallback is opt-in (`allow_plaintext_api_key`) for headless environments.
- The agent's write tools are gated by an explicit per-call approval; `AllowAllWrites` is a per-chat opt-in, never a global default.
- The in-app updater currently downloads release artifacts from the GitHub Releases API over HTTPS and verifies them by URL — there is **no GPG / Tauri-updater signature verification yet**. macOS notarization and Windows code-signing are tracked on the v1.0 roadmap. Until those land, treat the updater as TLS-trust-only.

If you spot a hardening regression — e.g. a new dep that re-enables OpenSSL, or an `unwrap()` on attacker-controlled input — those are also in scope as security-quality reports.

Thanks for helping keep FerrisScope safe.
