# Screenshots

This directory holds the marketing screenshots referenced from the project README. The README's _Screenshots_ section is laid out so that adding files with the names below makes them appear automatically — no further README edits required.

## Capture checklist

When you sit down to capture screenshots, please cover the following surfaces. Each filename maps to one image; pick the dark or light theme based on what reads best for that surface.

| File                          | Surface                                                                 |
|-------------------------------|-------------------------------------------------------------------------|
| `01-fleet.png`                | Fleet landing — the per-cluster card grid with version, node count, CPU / Mem load. |
| `02-resource-table.png`       | A populated resource table — Workloads → Pods is a good default, ideally a namespace with 30+ pods so the virtualisation is visible. |
| `03-detail-panel.png`         | The right-side detail panel for a Pod — labels, conditions, container statuses, owner ref. |
| `04-edit-ssa.png`             | Inline SSA editing — ConfigMap data with the pencil engaged and a dirty count. Bonus if a row shows the strike-through for soft-delete. |
| `05-yaml-monaco.png`          | The Monaco YAML editor open on a resource. |
| `06-logs.png`                 | Live logs panel with ANSI colour visible. |
| `07-terminal.png`             | Embedded terminal (xterm.js) with a pod shell session running. |
| `08-port-forwards.png`        | The port-forwards dock panel with at least two active forwards, one pinned. |
| `09-agent-chat.png`           | The AI agent dock — a question, a tool-use card mid-stream, and a streamed answer. |
| `10-command-palette.png`      | ⌘K command palette open with results from at least two categories (kinds + cluster search). |

If you capture a surface that doesn't fit the list, name it `XX-<surface>.png` and add a row above so the next person knows what it is.

## Capture guidance

- **Resolution.** 1600×1000 or 2× retina. Keep the window close to its default size from `tauri.conf.json` (1400×900) so detail rows wrap the same way they do for users.
- **Theme.** Default to dark; use light for surfaces that are noticeably more readable in light mode (e.g. logs with mostly dark colours).
- **Cluster.** A small kind cluster with a couple of namespaces and 20–30 pods reads best. Avoid screenshots taken against production data — even pseudonymised, they invite accidental leaks.
- **PII.** Sanitise visible cluster names, node names, IPs, and user emails before publishing. The simpler the cluster looks, the more credible the screenshot.
- **Compression.** PNG, lossless. Run through `oxipng -o4` or similar before committing — full-size dashboards can be 1–2 MB unoptimised.

## Adding to the README

Add a row to the `Screenshots` section in `../README.md` if you introduce a new file. The standard markup is:

```markdown
<a href="screenshots/0X-name.png"><img src="screenshots/0X-name.png" alt="Short caption" width="640" /></a>
```

Use the explicit `width="640"` so the README renders a uniform size on GitHub.
