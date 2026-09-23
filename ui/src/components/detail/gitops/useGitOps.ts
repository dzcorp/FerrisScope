import { useEffect, useRef, useState } from "react";
import { api } from "../../../api";
import { confirm, toast } from "../../../lib/dialog";
import { selectClusterDegraded, useAppStore } from "../../../store";
import type {
  GitOpsAction,
  GitOpsDetail,
  GitOpsRequest,
  MergePatchResult,
} from "../../../types";
import { useDetail, type LoadState } from "../useDetail";

export type GitOpsTarget = {
  clusterId: string;
  kindId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
};

export type GitOpsDialog =
  | { kind: "sync"; preselect?: string[] }
  | { kind: "rollback"; id: number };

export type GitOpsController = {
  dialog: GitOpsDialog | null;
  openDialog: (d: GitOpsDialog) => void;
  closeDialog: () => void;
  state: LoadState<GitOpsDetail>;
  /** Action id or request type in flight. */
  busy: string | null;
  reload: () => void;
  /** Why `action` can't run right now, or null when it can. */
  blocked: (action?: GitOpsAction) => string | null;
  run: (action: GitOpsAction) => Promise<void>;
  /** Typed operation; the caller's dialog is the confirmation. Resolves true on success. */
  request: (label: string, req: GitOpsRequest, confirmation?: string) => Promise<boolean>;
};

const identity = (t: GitOpsTarget) =>
  JSON.stringify([t.clusterId, t.kindId, t.namespace, t.name]);

// Lives in DetailPanel so the header actions and the Summary tab share one
// fetch and one resourceVersion.
export function useGitOps(
  target: GitOpsTarget,
  enabled: boolean,
): GitOpsController | null {
  const degraded = useAppStore((s) =>
    selectClusterDegraded(s, target.clusterId),
  );
  const confirmDestructive = useAppStore(
    (s) => s.settings.confirmDestructive,
  );
  const [refetch, setRefetch] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  // After a write, block further actions until a newer object is loaded, so
  // a second click can't reuse the same resourceVersion or reconcile token.
  const [submitted, setSubmitted] = useState<string | null>(null);
  const key = identity(target);
  const keyRef = useRef(key);
  keyRef.current = key;
  const locked = useRef(false);
  const [dialog, setDialog] = useState<GitOpsDialog | null>(null);

  useEffect(() => {
    setBusy(null);
    setSubmitted(null);
    setDialog(null);
    locked.current = false;
  }, [key]);

  const state = useDetail<{ key: string; detail: GitOpsDetail } | null>(
    () =>
      enabled
        ? api
            .getWellKnownDetail<GitOpsDetail>(
              target.clusterId,
              target.kindId,
              target.namespace,
              target.name,
            )
            .then((detail) => ({ key, detail }))
        : Promise.resolve(null),
    [enabled, key, target.detailVersion, refetch],
  );
  if (!enabled) return null;
  // A previous object's detail stays in useDetail until the new fetch lands;
  // never show (or act on) it under the new target.
  const ready: LoadState<GitOpsDetail> =
    state.kind === "ready"
      ? state.detail && state.detail.key === key
        ? { kind: "ready", detail: state.detail.detail }
        : { kind: "loading" }
      : state;
  const detail = ready.kind === "ready" ? ready.detail : null;
  const rv = detail?.resource_version ?? null;

  const blocked = (action?: GitOpsAction): string | null => {
    if (degraded) return "Cluster unavailable";
    if (action?.disabled_reason) return action.disabled_reason;
    if (busy !== null) return "Another request is in flight";
    if (!rv) return "Object has no resourceVersion yet";
    if (submitted === `${key}@${rv}`) return "Waiting for the updated object";
    return null;
  };

  const execute = async (
    busyId: string,
    label: string,
    confirmation: string | null | undefined,
    send: () => Promise<MergePatchResult>,
  ): Promise<boolean> => {
    if (locked.current || !detail || !rv || blocked()) return false;
    const startKey = key;
    locked.current = true;
    setBusy(busyId);
    try {
      if (
        confirmDestructive &&
        confirmation &&
        !(await confirm({
          title: `${label} ${target.name}?`,
          body: confirmation,
          confirmLabel: label,
        }))
      )
        return false;
      if (
        keyRef.current !== startKey ||
        selectClusterDegraded(useAppStore.getState(), target.clusterId)
      )
        return false;
      const result = await send();
      if (keyRef.current !== startKey) return false;
      setSubmitted(`${startKey}@${rv}`);
      setRefetch((n) => n + 1);
      if (result.kind === "stale") {
        toast.warn(
          `${target.name} changed since it was loaded. Reloaded — review and try again.`,
        );
        return false;
      }
      toast.ok(`${label} requested for ${target.name}.`);
      return true;
    } catch (e) {
      if (keyRef.current === startKey) toast.bad(String(e));
      return false;
    } finally {
      if (keyRef.current === startKey) {
        locked.current = false;
        setBusy(null);
      }
    }
  };

  const request = (label: string, req: GitOpsRequest, confirmation?: string) =>
    execute(req.type === "action" ? req.id : req.type, label, confirmation, () =>
      api.gitopsRun(
        target.clusterId,
        target.kindId,
        target.namespace,
        target.name,
        req,
        detail?.meta.generation ?? null,
      ),
    );

  // The backend rebuilds the fixed action's patch from the live object.
  const run = async (action: GitOpsAction) => {
    if (blocked(action)) return;
    await request(action.label, { type: "action", id: action.id }, action.confirmation ?? undefined);
  };

  return {
    dialog,
    openDialog: setDialog,
    closeDialog: () => setDialog(null),
    state: ready,
    busy,
    reload: () => setRefetch((n) => n + 1),
    blocked,
    run,
    request,
  };
}
