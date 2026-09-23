import { useEffect, useRef, useState } from "react";
import { api } from "../../../api";
import { confirm, toast } from "../../../lib/dialog";
import { isPendingStatus, valuesToYaml } from "../../../lib/helm";
import { selectClusterDegraded, useAppStore } from "../../../store";
import type { HelmReleaseDetail } from "../../../types";
import { useDetail, type LoadState } from "../useDetail";

export type HelmTarget = {
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
};

export type HelmOp = "upgrade" | "rollback" | "repo_update" | "values";

export type HelmFailure = { title: string; message: string; stderr: string };

/** Values-editor draft; `revision` is the release revision the edit started from. */
export type HelmDraft = { text: string; revision: number };

export type HelmController = {
  state: LoadState<HelmReleaseDetail>;
  /** Last refetch failed; `state` still holds the last good detail. */
  refreshError: string | null;
  busy: HelmOp | null;
  failure: HelmFailure | null;
  clearFailure: () => void;
  rollbackDialog: number | null;
  openRollback: (revision: number) => void;
  closeRollback: () => void;
  draft: HelmDraft | null;
  setDraft: (d: HelmDraft | null) => void;
  reload: () => void;
  /** Why a cluster write can't run right now, or null. */
  blocked: () => string | null;
  upgradeToLatest: () => Promise<void>;
  rollback: (revision: number) => Promise<boolean>;
  repoUpdate: () => Promise<void>;
  saveValues: (text: string) => Promise<boolean>;
};

export const HELM_MISSING = "helm CLI not found";
export const HELM_PENDING = "Release has an operation in progress";
export const VALUES_CONFIRM =
  "Upgrades the release with exactly these values (chart defaults for anything omitted).";

type Outcome =
  | { kind: "ok"; text: string }
  | { kind: "failed"; message: string; stderr: string }
  | { kind: "helm_missing" };

const identity = (t: HelmTarget) => JSON.stringify([t.clusterId, t.namespace, t.name]);

// Lives in DetailPanel so the header actions and the Summary share one fetch.
export function useHelmRelease(target: HelmTarget, enabled: boolean): HelmController | null {
  const degraded = useAppStore((s) => selectClusterDegraded(s, target.clusterId));
  const confirmDestructive = useAppStore((s) => s.settings.confirmDestructive);
  const [refetch, setRefetch] = useState(0);
  const [busy, setBusy] = useState<HelmOp | null>(null);
  const [failure, setFailure] = useState<HelmFailure | null>(null);
  const [rollbackDialog, setRollbackDialog] = useState<number | null>(null);
  const [draft, setDraft] = useState<HelmDraft | null>(null);
  const key = identity(target);
  const keyRef = useRef(key);
  keyRef.current = key;
  const locked = useRef(false);
  const lastGood = useRef<{ key: string; detail: HelmReleaseDetail } | null>(null);

  useEffect(() => {
    setBusy(null);
    setFailure(null);
    setRollbackDialog(null);
    setDraft(null);
    locked.current = false;
  }, [key]);

  const ns = target.namespace;
  const fetchable = enabled && ns !== null;
  const raw = useDetail<HelmReleaseDetail | null>(
    () => (fetchable ? api.getHelmReleaseDetail(target.clusterId, ns, target.name) : Promise.resolve(null)),
    [fetchable, key, target.detailVersion, refetch],
  );
  if (!enabled) return null;

  let state: LoadState<HelmReleaseDetail>;
  let refreshError: string | null = null;
  if (ns === null) {
    state = { kind: "error", message: "Helm release requires a namespace." };
  } else if (raw.kind === "ready") {
    // useDetail keeps the previous object's detail until the new fetch lands.
    if (raw.detail && raw.detail.name === target.name && raw.detail.namespace === ns) {
      lastGood.current = { key, detail: raw.detail };
      state = { kind: "ready", detail: raw.detail };
    } else state = { kind: "loading" };
  } else if (raw.kind === "error" && lastGood.current?.key === key) {
    state = { kind: "ready", detail: lastGood.current.detail };
    refreshError = raw.message;
  } else {
    state = raw;
  }
  const detail = state.kind === "ready" ? state.detail : null;

  const blocked = (): string | null => {
    if (!detail) return "Release not loaded";
    if (degraded) return "Cluster unavailable";
    if (!detail.helm_available) return HELM_MISSING;
    if (isPendingStatus(detail.status)) return HELM_PENDING;
    if (busy !== null) return "Another request is in flight";
    return null;
  };

  const execute = async (
    op: HelmOp,
    label: string,
    confirmation: { title: string; body: string } | null,
    send: () => Promise<Outcome>,
    local = false,
  ): Promise<boolean> => {
    if (locked.current || !detail) return false;
    if (!local && blocked()) return false;
    const startKey = key;
    locked.current = true;
    setBusy(op);
    try {
      if (
        confirmDestructive &&
        confirmation &&
        !(await confirm({ title: confirmation.title, body: confirmation.body, confirmLabel: label }))
      )
        return false;
      if (keyRef.current !== startKey) return false;
      if (!local && selectClusterDegraded(useAppStore.getState(), target.clusterId)) return false;
      setFailure(null);
      const out = await send();
      if (keyRef.current !== startKey) return false;
      setRefetch((n) => n + 1);
      if (out.kind === "ok") {
        toast.ok(out.text);
        return true;
      }
      if (out.kind === "helm_missing") {
        toast.bad(`${label} failed: ${HELM_MISSING}.`, { route: { section: "tools", anchor: "helm" } });
        return false;
      }
      setFailure({ title: `${label} failed`, message: out.message, stderr: out.stderr });
      toast.bad(`${label} of ${target.name} failed.\n${out.message}`);
      return false;
    } catch (e) {
      if (keyRef.current === startKey) toast.bad(`${label} failed: ${String(e)}`);
      return false;
    } finally {
      if (keyRef.current === startKey) {
        locked.current = false;
        setBusy(null);
      }
    }
  };

  const upgrade = async (values: string, chart?: { source: string; version: string }): Promise<Outcome> => {
    if (!detail) return { kind: "failed", message: "Release not loaded", stderr: "" };
    const r = await api.upgradeHelmRelease(
      target.clusterId,
      detail.namespace,
      detail.name,
      values,
      chart?.source,
      chart?.version,
    );
    if (r.kind === "upgraded")
      return {
        kind: "ok",
        text: `Upgraded ${detail.name} to revision ${r.revision}${r.status ? ` · ${r.status}` : ""}.`,
      };
    if (r.kind === "failed") return { kind: "failed", message: r.message, stderr: r.helm_stderr };
    return r;
  };

  const upgradeToLatest = async () => {
    const u = detail?.update_available;
    if (!detail || !u) return;
    const chart = detail.chart_name ?? "chart";
    await execute(
      "upgrade",
      "Upgrade",
      {
        title: `Upgrade ${detail.name} to ${u.version}?`,
        body: `Runs helm upgrade with ${u.source}/${chart} ${u.version}. The release keeps its current user values; everything else comes from the new chart's defaults. Upgrade hooks run.`,
      },
      () => upgrade(valuesToYaml(detail.values_user), { source: u.source, version: u.version }),
    );
  };

  const saveValues = (text: string) =>
    execute("values", "Upgrade", { title: `Upgrade ${target.name} with edited values?`, body: VALUES_CONFIRM }, async () => {
      const out = await upgrade(text);
      if (out.kind === "ok") setDraft(null);
      return out;
    });

  const rollback = (revision: number) =>
    execute("rollback", "Rollback", null, async () => {
      if (!detail) return { kind: "failed", message: "Release not loaded", stderr: "" };
      const r = await api.helmRollback(target.clusterId, detail.namespace, detail.name, revision);
      if (r.kind === "rolled_back")
        return {
          kind: "ok",
          text: `Rolled back ${detail.name} to revision ${revision}${r.revision !== null ? ` (now revision ${r.revision})` : ""}.`,
        };
      if (r.kind === "failed") return { kind: "failed", message: r.message, stderr: r.helm_stderr };
      return r;
    });

  const repoUpdate = async () => {
    if (!detail?.helm_available) return;
    await execute(
      "repo_update",
      "Repo update",
      null,
      async () => ({ kind: "ok", text: `Helm repos updated in ${await api.helmRepoUpdate()} ms.` }),
      true,
    );
  };

  return {
    state,
    refreshError,
    busy,
    failure,
    clearFailure: () => setFailure(null),
    rollbackDialog,
    openRollback: setRollbackDialog,
    closeRollback: () => setRollbackDialog(null),
    draft,
    setDraft,
    reload: () => setRefetch((n) => n + 1),
    blocked,
    upgradeToLatest,
    rollback,
    repoUpdate,
    saveValues,
  };
}
