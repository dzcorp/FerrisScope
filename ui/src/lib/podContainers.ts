/// Read a pod row's containers off the watcher projection.
///
/// The backend ships exactly one container list per pod row —
/// `container_states` (`kinds/pods.rs::build_containers`) — and every entry
/// carries `kind` (`init` / `sidecar` / `main`). There used to be a second,
/// names-only `containers` field riding the bus alongside it purely for the
/// logs panel; this module replaces it so the duplicate never comes back.
///
/// Everything here is total: rows arrive as loose JSON, and a pod whose spec
/// hasn't landed yet (or a projection that drifts) must degrade to an empty
/// list, never throw. No React.

import type { LogContainer, LogContainerKind } from "../types";

/// Display + default-selection order. `main` first because it's what an
/// operator opening logs almost always wants; then long-lived sidecars; then
/// init containers, which have already terminated by the time the pod is
/// interesting for anything except a failed start.
const KIND_RANK: Record<LogContainerKind, number> = {
  main: 0,
  sidecar: 1,
  init: 2,
};

function isKind(v: unknown): v is LogContainerKind {
  return v === "init" || v === "sidecar" || v === "main";
}

/// Every loggable container on a pod row, in the backend's manifest order
/// (init + sidecar first, then main). Entries without a usable `name` are
/// dropped; an unrecognised `kind` degrades to `main` so a future container
/// class still streams instead of vanishing.
export function rowLogContainers(
  // Deliberately an index signature rather than `{ container_states?: unknown }`:
  // the latter is a *weak type*, so TS rejects every concrete row type for
  // having "no properties in common" with it.
  row: { readonly [key: string]: unknown },
): LogContainer[] {
  const raw = row.container_states;
  if (!Array.isArray(raw)) return [];
  const out: LogContainer[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const name = rec.name;
    if (typeof name !== "string" || name === "") continue;
    out.push({ name, kind: isKind(rec.kind) ? rec.kind : "main" });
  }
  return out;
}

/// Stable sort into picker order (see `KIND_RANK`); manifest order is kept
/// within each rank. Returns a new array — never mutates the input, which is
/// usually a memoised row projection.
export function orderContainers(containers: LogContainer[]): LogContainer[] {
  return containers
    .map((c, i) => ({ c, i }))
    .sort((a, b) => KIND_RANK[a.c.kind] - KIND_RANK[b.c.kind] || a.i - b.i)
    .map((x) => x.c);
}

/// The container a logs surface should open on: the first main container, or
/// the first sidecar / init if the pod has no main container yet. `null` for a
/// pod with no containers at all.
export function defaultLogContainer(containers: LogContainer[]): string | null {
  return orderContainers(containers)[0]?.name ?? null;
}

/// Containers you can `exec` into. Init containers have terminated, so an
/// exec against one always fails with "container not running" — filter them
/// out rather than offering a shell that can't open. Native sidecars are
/// running, so they stay.
export function execContainers(containers: LogContainer[]): LogContainer[] {
  return orderContainers(containers).filter((c) => c.kind !== "init");
}

/// Short suffix appended to a container's label in pickers, so an operator can
/// tell a terminated init container from a live one without a second column.
/// Empty for `main` — the common case stays unadorned.
export function containerKindSuffix(kind: LogContainerKind): string {
  return kind === "main" ? "" : ` (${kind})`;
}

/// Picker label: name plus the kind suffix.
export function containerLabel(c: LogContainer): string {
  return `${c.name}${containerKindSuffix(c.kind)}`;
}
