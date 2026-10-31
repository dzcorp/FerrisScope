// RBAC mirror of `access_check_cmd` — see CLAUDE.md "RBAC awareness".

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { api } from "../api";
import type { AccessAction, AccessDecision, AccessRequest } from "../types";
import { logErr } from "./log";

export type ScopedAccessRequest = AccessRequest & { clusterId: string };

/// `allowed` is false only on an explicit denial. `error` says why a check
/// couldn't answer (the gate stays open).
export type Gate = { allowed: boolean; reason: string | null; pending: boolean; error: string | null };

export const OPEN_GATE: Gate = { allowed: true, reason: null, pending: false, error: null };
const PENDING_GATE: Gate = { allowed: true, reason: null, pending: true, error: null };

const TTL_MS = 120_000;
const UNKNOWN_TTL_MS = 10_000;

type Entry = { decision: AccessDecision | null; at: number; inflight: boolean };
type Batch = { clusterId: string; keys: string[]; requests: AccessRequest[] };

type Listener = { keys: readonly string[]; checks: readonly ScopedAccessRequest[]; changed: () => void };

const entries = new Map<string, Entry>();
const listeners = new Set<Listener>();
/// Who to tell when a key's decision changes, so an answer costs only its
/// own hooks' snapshots.
const byKey = new Map<string, Set<Listener>>();
let sweep: ReturnType<typeof setInterval> | null = null;
/// One batch per `requestAccess` call and cluster, so one hook's answers
/// never wait behind another's.
let batches: Batch[] = [];
let scheduled = false;
/// Bumped by `invalidateAccess`; answers from an older epoch are dropped.
const epochs = new Map<string, number>();
/// Bumped by `revalidateAccess`; answers asked before it land already stale.
const rounds = new Map<string, number>();
/// Bumped by `resetAccessCache`, which forgets the per-cluster counters.
let resets = 0;
/// A cluster's pending backend invalidate — its checks wait for it.
const invalidating = new Map<string, Promise<void>>();

export function accessKey(r: ScopedAccessRequest): string {
  return [r.clusterId, r.kindId, r.action, r.namespace ?? "", r.name ?? ""].join("\u0000");
}

function stale(e: Entry | undefined, now: number): boolean {
  return !e || (!e.inflight && now - e.at >= ttlOf(e.decision));
}

/// Re-ask every mounted hook's stale checks in one request per cluster.
function revalidateStale() {
  const now = Date.now();
  const checks: ScopedAccessRequest[] = [];
  const keys: string[] = [];
  for (const l of listeners) {
    l.keys.forEach((k, i) => {
      const c = l.checks[i];
      if (c && stale(entries.get(k), now)) {
        checks.push(c);
        keys.push(k);
      }
    });
  }
  ask(checks, keys);
}

function notify(keys?: readonly string[]) {
  if (!keys) {
    for (const l of listeners) l.changed();
    return;
  }
  const hit = new Set<Listener>();
  for (const k of keys) for (const l of byKey.get(k) ?? []) hit.add(l);
  for (const l of hit) l.changed();
}

function listen(l: Listener): () => void {
  listeners.add(l);
  for (const k of l.keys) {
    let set = byKey.get(k);
    if (!set) byKey.set(k, (set = new Set()));
    set.add(l);
  }
  // Decisions expire even when nothing else asks.
  sweep ??= setInterval(revalidateStale, UNKNOWN_TTL_MS);
  return () => {
    listeners.delete(l);
    for (const k of l.keys) {
      const set = byKey.get(k);
      set?.delete(l);
      if (set?.size === 0) byKey.delete(k);
    }
    if (listeners.size === 0 && sweep != null) {
      clearInterval(sweep);
      sweep = null;
    }
  };
}

function ttlOf(d: AccessDecision | null): number {
  return d?.state === "unknown" ? UNKNOWN_TTL_MS : TTL_MS;
}

function flush() {
  scheduled = false;
  const pending = batches;
  batches = [];
  for (const b of pending) {
    const asked = { reset: resets, epoch: epochs.get(b.clusterId) ?? 0, round: rounds.get(b.clusterId) ?? 0 };
    const settle = (decisions: AccessDecision[] | null | undefined) => {
      if (asked.reset !== resets || asked.epoch !== (epochs.get(b.clusterId) ?? 0)) return;
      const outdated = asked.round !== (rounds.get(b.clusterId) ?? 0);
      const at = outdated ? 0 : Date.now();
      b.keys.forEach((k, i) => {
        entries.set(k, {
          decision: decisions?.[i] ?? { state: "unknown", error: "no answer" },
          at,
          inflight: false,
        });
      });
      notify(b.keys);
      if (outdated) ask(b.requests.map((r) => ({ ...r, clusterId: b.clusterId })), b.keys);
    };
    (invalidating.get(b.clusterId) ?? Promise.resolve())
      .then(() => api.accessCheck(b.clusterId, b.requests))
      .then(settle, (e: unknown) =>
        settle(b.keys.map(() => ({ state: "unknown", error: String(e) }))),
      );
  }
}

/// Ask for every stale or missing decision; answers arrive via `notify`.
export function requestAccess(checks: readonly ScopedAccessRequest[]) {
  ask(checks, checks.map(accessKey));
}

function ask(checks: readonly ScopedAccessRequest[], keys: readonly string[]) {
  const now = Date.now();
  let mine: Map<string, Batch> | null = null;
  checks.forEach((c, i) => {
    const key = keys[i];
    if (key == null) return;
    const e = entries.get(key);
    if (!stale(e, now)) return;
    // Keep the stale answer visible while revalidating — no flicker.
    entries.set(key, { decision: e?.decision ?? null, at: e?.at ?? 0, inflight: true });
    mine ??= new Map();
    let b = mine.get(c.clusterId);
    if (!b) {
      b = { clusterId: c.clusterId, keys: [], requests: [] };
      mine.set(c.clusterId, b);
      batches.push(b);
    }
    b.keys.push(key);
    b.requests.push({
      kindId: c.kindId,
      action: c.action,
      namespace: c.namespace ?? null,
      name: c.name ?? null,
    });
  });
  if (batches.length > 0 && !scheduled) {
    scheduled = true;
    queueMicrotask(flush);
  }
}

export function readDecision(check: ScopedAccessRequest): AccessDecision | null {
  return entries.get(accessKey(check))?.decision ?? null;
}

export function gateOf(d: AccessDecision | null): Gate {
  if (d == null) return PENDING_GATE;
  if (d.state === "denied") {
    return { allowed: false, reason: `Not permitted: ${d.reason}`, pending: false, error: null };
  }
  if (d.state === "unknown") return { ...OPEN_GATE, error: d.error };
  return OPEN_GATE;
}

/// Allowed when any member is; the first denial explains an all-denied set.
export function anyGate(gates: readonly Gate[]): Gate {
  if (gates.length === 0) return OPEN_GATE;
  return (
    gates.find((g) => g.allowed && !g.pending && !g.error) ??
    gates.find((g) => g.allowed) ??
    gates[0] ??
    OPEN_GATE
  );
}

/// Like `anyGate`, but a denial outweighs members that couldn't answer — a
/// member that's down isn't in the merged table either.
export function decidedGate(gates: readonly Gate[]): Gate {
  return gates.find((g) => g.allowed && !g.pending && !g.error) ?? gates.find((g) => !g.allowed) ?? anyGate(gates);
}

/// Allowed only when every member is; the first denial explains.
export function allGates(gates: readonly Gate[]): Gate {
  return gates.find((g) => !g.allowed) ?? anyGate(gates);
}

function clusterKeys(clusterId: string): string[] {
  const prefix = `${clusterId}\u0000`;
  return Array.from(entries.keys()).filter((k) => k.startsWith(prefix));
}

/// Forget a cluster's decisions here and in Rust, when the operator asks
/// after their grants changed. Checks wait for the backend to forget first.
export function invalidateAccess(clusterId: string) {
  for (const k of clusterKeys(clusterId)) entries.delete(k);
  epochs.set(clusterId, (epochs.get(clusterId) ?? 0) + 1);
  batches = batches.filter((b) => b.clusterId !== clusterId);
  const done: Promise<void> = api
    .accessInvalidate(clusterId)
    .catch(logErr("access"))
    .finally(() => {
      if (invalidating.get(clusterId) === done) invalidating.delete(clusterId);
    });
  invalidating.set(clusterId, done);
  notify();
  revalidateStale();
}

/// Re-ask a cluster's decisions, keeping the old answers visible meanwhile.
/// After a connect: a reused backend entry answers from its cache, a new one
/// (possibly a new identity) reviews afresh.
export function revalidateAccess(clusterId: string) {
  rounds.set(clusterId, (rounds.get(clusterId) ?? 0) + 1);
  for (const k of clusterKeys(clusterId)) {
    const e = entries.get(k);
    if (e && !e.inflight) entries.set(k, { ...e, at: 0 });
  }
  revalidateStale();
}

/// Test seam.
export function resetAccessCache() {
  entries.clear();
  if (sweep != null) clearInterval(sweep);
  sweep = null;
  epochs.clear();
  rounds.clear();
  resets += 1;
  invalidating.clear();
  batches = [];
  scheduled = false;
  notify();
}

/// What a hook's gates are built from: its own decisions only, so an answer
/// elsewhere doesn't re-render it.
function snapshotOf(keys: readonly string[]): string {
  let out = "";
  for (const k of keys) {
    const d = entries.get(k)?.decision;
    out +=
      d == null ? "~" : d.state === "allowed" ? "a" : d.state === "denied" ? `d${d.reason}` : `u${d.error}`;
    out += "\u0001";
  }
  return out;
}

/// One gate per check, in order.
export function useAccessChecks(checks: readonly ScopedAccessRequest[]): Gate[] {
  const key = checks.map(accessKey).join("\n");
  const latest = useRef(checks);
  latest.current = checks;
  const keys = useMemo(() => (key ? key.split("\n") : []), [key]);
  const subscribe = useCallback(
    (changed: () => void) => listen({ keys, checks: latest.current, changed }),
    [keys],
  );
  const snap = useSyncExternalStore(subscribe, () => snapshotOf(keys));
  useEffect(() => {
    ask(latest.current, keys);
  }, [keys]);
  return useMemo(
    () => latest.current.map((c) => gateOf(readDecision(c))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, snap],
  );
}

/// Gates for `actions` on one kind at one scope. `clusterId` null → all open.
export function useKindAccess<A extends AccessAction>(
  clusterId: string | null | undefined,
  kindId: string | null | undefined,
  actions: readonly A[],
  scope?: { namespace?: string | null; name?: string | null },
): Record<A, Gate> {
  const namespace = scope?.namespace ?? null;
  const name = scope?.name ?? null;
  const checks = useMemo(
    () =>
      clusterId && kindId
        ? actions.map((action) => ({ clusterId, kindId, action, namespace, name }))
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clusterId, kindId, namespace, name, actions.join(",")],
  );
  const gates = useAccessChecks(checks);
  return useMemo(() => {
    const out = {} as Record<A, Gate>;
    actions.forEach((a, i) => {
      out[a] = gates[i] ?? OPEN_GATE;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gates, actions.join(",")]);
}

/// Append a gate's denial to a tooltip: "Delete — Not permitted: …".
export function gatedTitle(title: string, gate: Gate | undefined): string {
  return gate && !gate.allowed && gate.reason ? `${title} — ${gate.reason}` : title;
}

const MAX_SCOPES = 50;
const TOO_MANY_SCOPES: Gate = { ...OPEN_GATE, error: `more than ${MAX_SCOPES} namespaces — not checked` };

/// Gates for `actions` over a set of (cluster, namespace) scopes — a
/// multi-row selection. Open when any scope allows the action: the bulk
/// runner reports per-row failures, so a partial grant is still worth running.
type Scope = { clusterId: string; namespace: string | null };

/// Distinct scopes, capped. `scopes` should be memoized: a 10k-row selection
/// is walked once per change, not per render.
function distinctScopes(scopes: Iterable<Scope>): { list: Scope[]; key: string; truncated: boolean } {
  const distinct = new Map<string, Scope>();
  let truncated = false;
  for (const s of scopes) {
    const k = `${s.clusterId}\u0000${s.namespace ?? ""}`;
    if (distinct.has(k)) continue;
    if (distinct.size >= MAX_SCOPES) {
      truncated = true;
      break;
    }
    distinct.set(k, s);
  }
  return { list: Array.from(distinct.values()), key: Array.from(distinct.keys()).sort().join("\n"), truncated };
}

const NO_SCOPES = { list: [] as Scope[], key: "", truncated: false };

export function useScopesAccess<A extends AccessAction>(
  kindId: string | null | undefined,
  scopes: Iterable<Scope>,
  actions: readonly A[],
  combine: (gates: readonly Gate[]) => Gate = anyGate,
): Record<A, Gate> {
  const walked = useMemo(() => (kindId ? distinctScopes(scopes) : NO_SCOPES), [kindId, scopes]);
  const { truncated } = walked;
  const checks = useMemo(
    () =>
      kindId
        ? actions.flatMap((action) =>
            walked.list.map((s) => ({
              clusterId: s.clusterId,
              kindId,
              action,
              namespace: s.namespace,
            })),
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kindId, walked.key, actions.join(",")],
  );
  const gates = useAccessChecks(checks);
  return useMemo(() => {
    const out = {} as Record<A, Gate>;
    const per = checks.length / Math.max(actions.length, 1);
    actions.forEach((a, i) => {
      const g = combine(gates.slice(i * per, (i + 1) * per));
      // An unchecked scope might allow it.
      out[a] = truncated && !g.allowed ? TOO_MANY_SCOPES : g;
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gates, checks, truncated, combine]);
}
