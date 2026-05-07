import { useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { api, onResourceDelta } from "../api";
import {
  diffPartial,
  parseYaml,
  stripYaml,
  type Json,
} from "../lib/yamlEdit";
import { installClipboardShortcuts } from "../lib/monacoClipboard";
import { useAppStore } from "../store";
import type {
  ContainerDetail,
  ContainerLastState,
  ContainerProbe,
  ContainerSecurity,
  PodDetail,
  PodScheduling,
  PodSecurity,
  ResourceKind,
  ResourceRow,
} from "../types";
import { tokens, FONT_MONO, type ThemeMode, type Tokens } from "../theme";
import {
  Chip,
  ContainerDots,
  Eyebrow,
  IconBtn,
  Icons,
  LoadingLine,
  Section,
  StatusPill,
} from "./ui";
import type { ContainerLite } from "./ui";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { confirm, toast } from "../lib/dialog";
import {
  ChipStrip,
  ChipWrap,
  ConditionChip,
  Copyable,
  DetailRow,
  KeyValueChips,
  LinkValue,
  Mute,
  SubGrid,
  ageFromIso,
  type DetailNavigate,
  type SubEntry,
} from "./detail";
import {
  CronJobSummary,
  DaemonSetSummary,
  DeploymentSummary,
  JobSummary,
  ReplicaSetSummary,
  StatefulSetSummary,
} from "./detail/workload";
import {
  EnvEditor,
  MetaPairsRow,
  PortsEditor,
  VolumesEditor,
} from "./detail/workload/shared";
import {
  EventSummary,
  NamespaceSummary,
  NodeSummary,
} from "./detail/cluster";
import { ConflictBanner, EditModeChrome } from "./detail/edit";
import { InlineLogTab } from "./detail/InlineLogTab";
import { MetricsTab } from "./detail/MetricsTab";
import {
  EndpointSliceSummary,
  EndpointsSummary,
  IngressClassSummary,
  IngressSummary,
  NetworkPolicySummary,
  ServiceSummary,
} from "./detail/network";
import {
  ConfigMapSummary,
  LimitRangeSummary,
  ResourceQuotaSummary,
  SecretSummary,
} from "./detail/config";
import {
  PersistentVolumeClaimSummary,
  PersistentVolumeSummary,
  StorageClassSummary,
} from "./detail/storage";
import {
  ClusterRoleBindingSummary,
  ClusterRoleSummary,
  RoleBindingSummary,
  RoleSummary,
  ServiceAccountSummary,
} from "./detail/rbac";
import { CustomResourceDefinitionSummary } from "./detail/customresources";
import { CustomResourceSummary } from "./detail/customresources/generic";
import {
  HorizontalPodAutoscalerSummary,
  LeaseSummary,
  MutatingWebhookConfigurationSummary,
  PodDisruptionBudgetSummary,
  PriorityClassSummary,
  ReplicationControllerSummary,
  ValidatingWebhookConfigurationSummary,
} from "./detail/extended";
import {
  GatewayClassSummary,
  GatewaySummary,
  ReferenceGrantSummary,
  RouteSummary,
} from "./detail/gateway";
import { HelmReleaseSummary } from "./detail/helm";
import { HelmChartSummary } from "./detail/helm/chart";

// Set of kind ids that have a structured Summary tab. Used to gate the tab
// label + the default tab + the dispatch in the body.
const SUMMARY_KINDS = new Set([
  "pods",
  "deployments",
  "replicasets",
  "statefulsets",
  "daemonsets",
  "jobs",
  "cronjobs",
  "nodes",
  "namespaces",
  "events",
  "services",
  "endpoints",
  "endpointslices",
  "ingresses",
  "ingressclasses",
  "networkpolicies",
  "configmaps",
  "secrets",
  "resourcequotas",
  "limitranges",
  "persistentvolumeclaims",
  "persistentvolumes",
  "storageclasses",
  "serviceaccounts",
  "roles",
  "rolebindings",
  "clusterroles",
  "clusterrolebindings",
  "customresourcedefinitions",
  "horizontalpodautoscalers",
  "poddisruptionbudgets",
  "priorityclasses",
  "replicationcontrollers",
  "leases",
  "mutatingwebhookconfigurations",
  "validatingwebhookconfigurations",
  "helm_releases",
  "helm_charts",
]);

// Well-known CRD ids look like `wkcrd:<short>|...`. Extract the short id —
// detail dispatch + summary-tab gating both key off it.
function wellKnownShort(id: string): string | null {
  if (!id.startsWith("wkcrd:")) return null;
  const rest = id.slice("wkcrd:".length);
  const sep = rest.indexOf("|");
  return sep === -1 ? rest : rest.slice(0, sep);
}

const WELL_KNOWN_SUMMARY_SHORTS = new Set([
  "gatewayclasses",
  "gateways",
  "httproutes",
  "grpcroutes",
  "referencegrants",
]);

function hasSummaryFor(kindId: string): boolean {
  if (SUMMARY_KINDS.has(kindId)) return true;
  const short = wellKnownShort(kindId);
  if (short != null) return WELL_KNOWN_SUMMARY_SHORTS.has(short);
  // Any catch-all CRD-backed kind gets the schema-driven generic summary.
  if (kindId.startsWith("crd:")) return true;
  return false;
}

type LoadState =
  | { kind: "loading" }
  | {
      kind: "ready";
      // Stripped, source-like YAML shown to the operator. Server-managed
      // fields (status, managedFields, resourceVersion, …) are removed so
      // the document round-trips through SSA cleanly.
      yaml: string;
      // Parsed JSON form of the same stripped doc — kept around so Save
      // can diff against it without re-parsing on every keystroke.
      original: Json;
      refreshedAt: number;
    }
  | { kind: "error"; message: string };

type Tab = "summary" | "yaml" | "events" | "related" | "logs" | "metrics";

// Kinds that surface a Related tab. Today: Pod (owner chain, node, SA,
// image-pull-secrets, mounted ConfigMaps/Secrets/PVCs) and the workload
// kinds (owner chain only — child-pod resolution lives in their Summary).
// Other kinds get nothing useful from this view yet, so we hide the tab
// rather than showing an empty pane.
const RELATED_KINDS = new Set([
  "pods",
  "deployments",
  "replicasets",
  "statefulsets",
  "daemonsets",
  "jobs",
  "cronjobs",
]);

export type DetailTarget = {
  uid: string;
  namespace: string | null;
  name: string;
};

// `DetailNavigate` lives in ./detail/primitives — re-exported from there for
// any caller that needs the type.
export type { DetailNavigate } from "./detail";

type Props = {
  mode: ThemeMode;
  clusterId: string;
  kind: ResourceKind;
  target: DetailTarget;
  // Optional: full row from the table, used for the pod summary tab so we
  // don't have to round-trip the API just to render stats.
  row?: ResourceRow | null;
  onClose: () => void;
  onNavigate?: DetailNavigate;
  // Open `kubectl exec -it` against this pod in a Dock terminal tab.
  // null/undefined = let the caller default-pick the container; a specific
  // name forces that container.
  onOpenExec?: (container?: string | null) => void;
};

// Detail side panel — slides in from the right, replaces the previous modal
// pattern. Per R-09, modals are reserved for namespace pickers and destructive
// confirmations only.
export function DetailPanel({
  mode,
  clusterId,
  kind,
  target,
  row,
  onClose,
  onNavigate,
  onOpenExec,
}: Props) {
  const t = tokens(mode);
  const isPod = kind.id === "pods";
  const isNode = kind.id === "nodes";
  const isPvc = kind.id === "persistentvolumeclaims";
  const isNamespace = kind.id === "namespaces";
  // Workload kinds share a single Prom-scoped MetricsTab via owner-ref join
  // through kube-state-metrics. Each kind maps to a `controllerKind` string
  // that selects the right kube_pod_owner / kube_<kind>_status_* names on
  // the frontend.
  const workloadKindByKindId: Record<string, string> = {
    deployments: "Deployment",
    statefulsets: "StatefulSet",
    daemonsets: "DaemonSet",
    replicasets: "ReplicaSet",
    jobs: "Job",
  };
  const workloadControllerKind = workloadKindByKindId[kind.id] as
    | "Deployment"
    | "StatefulSet"
    | "DaemonSet"
    | "ReplicaSet"
    | "Job"
    | undefined;
  const isWorkload = workloadControllerKind != null;
  // Kinds that surface a Metrics tab.
  const hasMetrics =
    isPod || isPvc || isNode || isNamespace || isWorkload;
  const hasSummary = hasSummaryFor(kind.id);
  // YAML tab fetches the underlying single object via the dynamic API.
  // Helm releases / charts are synthetic — backed by N revision Secrets
  // (or *no* single object at all in the chart case) — so YAML is
  // meaningless here. The Summary already shows the rendered manifest +
  // values in a Monaco viewer, so nothing is lost.
  const hasYaml = kind.id !== "helm_releases" && kind.id !== "helm_charts";
  // Events tab lists Events whose involvedObject == this target. An Event
  // detail itself can't be the involvedObject of other Events — hide the tab.
  const hasEvents = kind.id !== "events";
  const hasRelated = RELATED_KINDS.has(kind.id);
  const [tab, setTab] = useState<Tab>(
    hasSummary ? "summary" : hasYaml ? "yaml" : "summary",
  );
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  // YAML-tab edit state. `buffer` is the operator's in-flight edit; null
  // when not editing. `saving` blocks the controls during the SSA round
  // trip; `conflict` populates the ConflictBanner; `error` shows other
  // failures (parse, network) above the editor.
  const [yamlBuffer, setYamlBuffer] = useState<string | null>(null);
  const [yamlSaving, setYamlSaving] = useState(false);
  const [yamlConflict, setYamlConflict] = useState<{
    managers: string[];
    fields: string[];
    message: string;
  } | null>(null);
  const [yamlError, setYamlError] = useState<string | null>(null);
  // Bumped on every Upsert for this uid; the pod summary subtree refetches
  // its detail in response. The YAML tab still triggers via `refetch` below.
  const [detailVersion, setDetailVersion] = useState(0);
  const reqId = useRef(0);

  const detailHistory = useAppStore((s) => s.detailHistory);
  const detailIndex = useAppStore((s) => s.detailIndex);
  const detailBack = useAppStore((s) => s.detailBack);
  const detailForward = useAppStore((s) => s.detailForward);
  const confirmDestructive = useAppStore((s) => s.settings.confirmDestructive);
  const canBack = detailIndex > 0;
  const canForward = detailIndex >= 0 && detailIndex < detailHistory.length - 1;
  const prevEntry = canBack ? detailHistory[detailIndex - 1] : null;
  const nextEntry = canForward ? detailHistory[detailIndex + 1] : null;

  // Title-bar action group (pod only for now). Each button anchors a
  // ContextMenu below itself; the menu's `rowName` header re-states the
  // target so destructive picks always show what they'll act on.
  const shellBtnRef = useRef<HTMLButtonElement | null>(null);
  const restartBtnRef = useRef<HTMLButtonElement | null>(null);
  const deleteBtnRef = useRef<HTMLButtonElement | null>(null);
  const cordonBtnRef = useRef<HTMLButtonElement | null>(null);
  const drainBtnRef = useRef<HTMLButtonElement | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [actionMenu, setActionMenu] = useState<{
    kind: "shell" | "delete";
    pos: MenuPosition;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [cordoning, setCordoning] = useState(false);
  const [draining, setDraining] = useState(false);

  // Live cordon state for the title-bar Cordon/Uncordon toggle. Sourced from
  // the row payload (`phase === "SchedulingDisabled"`) — matches the table
  // and the header pill so the operator never sees one button claim "Cordon"
  // while another surface shows the node as already cordoned.
  const nodeCordoned =
    isNode && row != null && row.phase === "SchedulingDisabled";

  const podContainers: string[] =
    isPod && row && Array.isArray(row.containers)
      ? (row.containers as unknown[]).filter(
          (c): c is string => typeof c === "string",
        )
      : [];

  const openActionMenu = (
    kind: "shell" | "delete",
    btn: HTMLButtonElement | null,
  ) => {
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    // Anchor below the button, right-aligned to it (so the menu grows left).
    setActionMenu({
      kind,
      pos: { x: r.right - 210, y: r.bottom + 4 },
    });
  };

  const runRestart = async () => {
    if (!target.namespace) {
      toast.bad("Pod has no namespace");
      return;
    }
    if (confirmDestructive) {
      const ok = await confirm({
        title: `Rollout-restart owner of ${target.name}?`,
        body: "This restarts the entire workload — every pod owned by the Deployment / StatefulSet / DaemonSet is recreated, not just this one. Rollout is graceful (respects maxSurge / maxUnavailable / PDBs).",
        confirmLabel: "Restart",
        tone: "danger",
      });
      if (!ok) return;
    }
    setRestarting(true);
    try {
      const [ownerKind, ownerName] = await api.restartPod(
        clusterId,
        target.namespace,
        target.name,
      );
      toast.ok(`Rollout restart triggered on ${ownerKind} ${ownerName}.`);
    } catch (e) {
      toast.bad(String(e));
    } finally {
      setRestarting(false);
    }
  };

  const runDelete = async (force: boolean) => {
    // Helm releases route through `helm uninstall` on the backend (see
    // delete_resource_cmd) — surface that in the UX so the operator
    // knows hooks fire and rendered workloads come down. Force has no
    // meaning for helm uninstall, so we ignore it for that path.
    const isHelmRelease = kind.id === "helm_releases";
    if (confirmDestructive) {
      const ok = await confirm({
        title: isHelmRelease
          ? `Uninstall release ${target.name}?`
          : force
            ? `Force delete ${kind.kind} ${target.name}?`
            : `Delete ${kind.kind} ${target.name}?`,
        body: isHelmRelease
          ? "Runs `helm uninstall`: deletes the release secret AND every Kubernetes object the release rendered. Pre-/post-delete hooks fire. Irreversible."
          : force
            ? "No grace period — the resource is removed immediately."
            : undefined,
        confirmLabel: isHelmRelease ? "Uninstall" : force ? "Force delete" : "Delete",
        tone: "danger",
      });
      if (!ok) return;
    }
    setDeleting(true);
    try {
      await api.deleteResource(
        clusterId,
        kind.id,
        target.namespace,
        target.name,
        force ? 0 : null,
      );
      toast.ok(
        isHelmRelease
          ? `Uninstalled release ${target.name}.`
          : `Deleted ${kind.kind} ${target.name}.`,
      );
      onClose();
    } catch (e) {
      toast.bad(String(e));
    } finally {
      setDeleting(false);
    }
  };

  // Workload kinds that support `kubectl rollout restart` semantics. The
  // backend uses a JSON merge-patch to bump
  // `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]`
  // — *not* SSA, because a partial SSA payload makes the apiserver null
  // `selector` / `containers` and reject the Deployment with 422.
  const restartableWorkloadKinds = new Set([
    "deployments",
    "statefulsets",
    "daemonsets",
  ]);
  const isRestartableWorkload = restartableWorkloadKinds.has(kind.id);

  const runRestartWorkload = async () => {
    if (!target.namespace) {
      toast.bad(`${kind.kind} has no namespace`);
      return;
    }
    if (confirmDestructive) {
      const ok = await confirm({
        title: `Rollout-restart ${kind.kind} ${target.name}?`,
        body: "Patches the workload's pod-template annotation. Every pod owned by it is recreated; rollout respects maxSurge / maxUnavailable / PDBs.",
        confirmLabel: "Restart",
        tone: "danger",
      });
      if (!ok) return;
    }
    setRestarting(true);
    try {
      await api.restartWorkload(
        clusterId,
        kind.kind,
        target.namespace,
        target.name,
      );
      toast.ok(`Rollout restart triggered on ${kind.kind} ${target.name}.`);
      setDetailVersion((v) => v + 1);
    } catch (e) {
      toast.bad(String(e));
    } finally {
      setRestarting(false);
    }
  };

  const runCordon = async () => {
    const targetState = !nodeCordoned;
    if (confirmDestructive && targetState) {
      const ok = await confirm({
        title: `Cordon node ${target.name}?`,
        body: "New pods won't be scheduled here until the node is uncordoned. Existing pods stay running.",
        confirmLabel: "Cordon",
      });
      if (!ok) return;
    }
    setCordoning(true);
    try {
      await api.cordonNode(clusterId, target.name, targetState);
      toast.ok(
        targetState
          ? `Cordoned ${target.name}.`
          : `Uncordoned ${target.name}.`,
      );
      setDetailVersion((v) => v + 1);
    } catch (e) {
      toast.bad(String(e));
    } finally {
      setCordoning(false);
    }
  };

  const runDrain = async () => {
    const ok = await confirm({
      title: `Drain node ${target.name}?`,
      body: "Cordons the node and evicts every pod on it. DaemonSet-managed and mirror pods are skipped. PDB-protected pods may be blocked — failures are reported per pod but the drain continues.",
      confirmLabel: "Drain",
      tone: "danger",
    });
    if (!ok) return;
    setDraining(true);
    try {
      const report = await api.drainNode(clusterId, target.name, false);
      const ev = report.evicted.length;
      const sk = report.skipped.length;
      const fl = report.failures.length;
      const headline = `Drain ${target.name}: ${ev} evicted, ${sk} skipped${fl > 0 ? `, ${fl} failed` : ""}.`;
      if (fl > 0) {
        const lines = report.failures
          .slice(0, 8)
          .map((f) => `${f.namespace}/${f.pod}: ${f.error}`)
          .join("\n");
        const more =
          report.failures.length > 8
            ? `\n…and ${report.failures.length - 8} more`
            : "";
        toast.bad(`${headline}\n${lines}${more}`);
      } else {
        toast.ok(headline);
      }
      setDetailVersion((v) => v + 1);
    } catch (e) {
      toast.bad(String(e));
    } finally {
      setDraining(false);
    }
  };

  const refetch = () => {
    const id = ++reqId.current;
    // Synthetic kinds without a single backing object (helm_releases) skip
    // the YAML fetch entirely — the YAML tab is hidden for them and the
    // dynamic API would resolve to the wrong resource (a Secret) anyway.
    if (!hasYaml) {
      setLoad({ kind: "ready", yaml: "", original: null, refreshedAt: Date.now() });
      return;
    }
    setLoad((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    api
      .getResourceYaml(clusterId, kind.id, target.namespace, target.name)
      .then((yaml) => {
        if (reqId.current !== id) return;
        try {
          const stripped = stripYaml(yaml);
          const original = parseYaml(stripped);
          setLoad({
            kind: "ready",
            yaml: stripped,
            original,
            refreshedAt: Date.now(),
          });
        } catch (e) {
          // Parse failure → fall back to the raw text so the operator can
          // still see what's there. Edit mode will be disabled in this state
          // because `original` is null.
          setLoad({
            kind: "ready",
            yaml,
            original: null,
            refreshedAt: Date.now(),
          });
          console.warn("YAML strip failed", e);
        }
      })
      .catch((e: unknown) => {
        if (reqId.current === id)
          setLoad({ kind: "error", message: String(e) });
      });
  };

  useEffect(() => {
    refetch();
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    // Coalesce rapid watcher updates (a Pod with chatty status fields can
    // fire 10+ Apply events per second during restarts). Without the
    // debounce each delta triggers a fresh YAML fetch + a re-fetch of
    // every child summary tab.
    let pending: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefetch = () => {
      if (pending != null) return;
      pending = setTimeout(() => {
        pending = null;
        if (cancelled) return;
        refetch();
        setDetailVersion((v) => v + 1);
      }, 250);
    };
    onResourceDelta(clusterId, kind.id, (delta) => {
      if (cancelled) return;
      if (delta.kind === "upsert" && delta.row.uid === target.uid) {
        scheduleRefetch();
      }
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    // Switching to a different target drops any in-flight edit — the
    // buffer is keyed to the prior resource and would otherwise corrupt
    // the new one's apply payload.
    setYamlBuffer(null);
    setYamlConflict(null);
    setYamlError(null);
    setYamlSaving(false);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // Alt+← / Alt+→ — IDE-style navigation history. We don't bind plain
      // arrows because the YAML / summary scroll regions need them.
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          detailBack();
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          detailForward();
        }
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      cancelled = true;
      if (pending != null) clearTimeout(pending);
      if (unlisten) unlisten();
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, kind.id, target.uid]);

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          left: 0,
          background: t.scrim,
          zIndex: 30,
          animation: "fs-fade-in .18s ease",
        }}
      />
      <div
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          width: 760,
          maxWidth: "95vw",
          background: t.surface,
          borderLeft: `1px solid ${t.border}`,
          boxShadow:
            mode === "dark"
              ? "-12px 0 32px rgba(0,0,0,0.4)"
              : "-12px 0 32px rgba(15,20,30,0.12)",
          display: "flex",
          flexDirection: "column",
          zIndex: 31,
          animation: "fs-slide-from-right .22s cubic-bezier(.2,.7,.2,1)",
        }}
      >
        <header
          style={{
            padding: "16px 22px 12px",
            borderBottom: `1px solid ${t.borderSoft}`,
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
              }}
            >
              <Eyebrow t={t}>{kind.kind}</Eyebrow>
              <span style={{ color: t.textMuted, fontSize: 11 }}>·</span>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  color: t.textDim,
                }}
              >
                {kind.group ? `${kind.group}/${kind.version}` : kind.version}
              </span>
              {target.namespace && (
                <>
                  <span style={{ color: t.textMuted, fontSize: 11 }}>·</span>
                  <span
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11,
                      color: t.textDim,
                    }}
                  >
                    {target.namespace}
                  </span>
                </>
              )}
            </div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                fontFamily: FONT_MONO,
                wordBreak: "break-all",
                lineHeight: 1.3,
                color: t.text,
              }}
            >
              {target.name}
            </div>
          </div>
          {canBack && (
            <IconBtn
              t={t}
              size="lg"
              title={`Back to ${prevEntry!.kindId} · ${prevEntry!.name} (Alt+←)`}
              onClick={detailBack}
            >
              {Icons.chevL}
            </IconBtn>
          )}
          {canForward && (
            <IconBtn
              t={t}
              size="lg"
              title={`Forward to ${nextEntry!.kindId} · ${nextEntry!.name} (Alt+→)`}
              onClick={detailForward}
            >
              {Icons.chevR}
            </IconBtn>
          )}
          {isPod && (
            <>
              {(canBack || canForward) && (
                <span
                  aria-hidden
                  style={{
                    width: 1,
                    height: 22,
                    background: t.borderSoft,
                    margin: "0 6px",
                  }}
                />
              )}
              <IconBtn
                ref={shellBtnRef}
                t={t}
                size="lg"
                title={
                  podContainers.length === 0
                    ? "No containers"
                    : podContainers.length === 1
                      ? `Open shell (${podContainers[0]})`
                      : "Open shell…"
                }
                disabled={podContainers.length === 0 || !onOpenExec}
                active={actionMenu?.kind === "shell"}
                onClick={() => {
                  if (!onOpenExec) return;
                  if (podContainers.length <= 1) {
                    onOpenExec(podContainers[0] ?? null);
                  } else {
                    openActionMenu("shell", shellBtnRef.current);
                  }
                }}
              >
                {Icons.shell}
              </IconBtn>
              <IconBtn
                ref={restartBtnRef}
                t={t}
                size="lg"
                title="Rollout restart owner workload"
                disabled={restarting || !target.namespace}
                onClick={runRestart}
              >
                {Icons.refresh}
              </IconBtn>
              <IconBtn
                ref={deleteBtnRef}
                t={t}
                size="lg"
                title="Delete…"
                danger
                disabled={deleting}
                active={actionMenu?.kind === "delete"}
                onClick={() =>
                  openActionMenu("delete", deleteBtnRef.current)
                }
              >
                {Icons.trash}
              </IconBtn>
              <span
                aria-hidden
                style={{
                  width: 1,
                  height: 22,
                  background: t.borderSoft,
                  margin: "0 6px",
                }}
              />
            </>
          )}
          {isNode && (
            <>
              {(canBack || canForward) && (
                <span
                  aria-hidden
                  style={{
                    width: 1,
                    height: 22,
                    background: t.borderSoft,
                    margin: "0 6px",
                  }}
                />
              )}
              <IconBtn
                ref={shellBtnRef}
                t={t}
                size="lg"
                title={`Open shell on node (kubectl debug node/${target.name})`}
                disabled={!onOpenExec}
                onClick={() => onOpenExec?.(null)}
              >
                {Icons.shell}
              </IconBtn>
              <IconBtn
                ref={cordonBtnRef}
                t={t}
                size="lg"
                title={
                  nodeCordoned
                    ? "Uncordon node — re-enable scheduling"
                    : "Cordon node — block new scheduling"
                }
                disabled={cordoning}
                onClick={runCordon}
              >
                {nodeCordoned ? Icons.nodeUncordon : Icons.nodeCordon}
              </IconBtn>
              <IconBtn
                ref={drainBtnRef}
                t={t}
                size="lg"
                title="Drain node — cordon and evict pods"
                disabled={draining}
                onClick={runDrain}
              >
                {Icons.nodeDrain}
              </IconBtn>
              <IconBtn
                ref={deleteBtnRef}
                t={t}
                size="lg"
                title="Delete…"
                danger
                disabled={deleting}
                active={actionMenu?.kind === "delete"}
                onClick={() =>
                  openActionMenu("delete", deleteBtnRef.current)
                }
              >
                {Icons.trash}
              </IconBtn>
              <span
                aria-hidden
                style={{
                  width: 1,
                  height: 22,
                  background: t.borderSoft,
                  margin: "0 6px",
                }}
              />
            </>
          )}
          {!isPod && !isNode && (
            // Generic action block for every other kind. Restart is gated to
            // the workload set that actually has a `spec.template`; Delete is
            // universal and rides the dynamic API in `runDelete`.
            <>
              {(canBack || canForward) && (
                <span
                  aria-hidden
                  style={{
                    width: 1,
                    height: 22,
                    background: t.borderSoft,
                    margin: "0 6px",
                  }}
                />
              )}
              {isRestartableWorkload && (
                <IconBtn
                  ref={restartBtnRef}
                  t={t}
                  size="lg"
                  title={`Rollout restart ${kind.kind.toLowerCase()}`}
                  disabled={restarting || !target.namespace}
                  onClick={runRestartWorkload}
                >
                  {Icons.refresh}
                </IconBtn>
              )}
              <IconBtn
                ref={deleteBtnRef}
                t={t}
                size="lg"
                title="Delete…"
                danger
                disabled={deleting}
                active={actionMenu?.kind === "delete"}
                onClick={() =>
                  openActionMenu("delete", deleteBtnRef.current)
                }
              >
                {Icons.trash}
              </IconBtn>
              <span
                aria-hidden
                style={{
                  width: 1,
                  height: 22,
                  background: t.borderSoft,
                  margin: "0 6px",
                }}
              />
            </>
          )}
          {tab === "yaml" && hasYaml && (
            <IconBtn t={t} size="lg" title="Refresh" onClick={refetch}>
              {Icons.refresh}
            </IconBtn>
          )}
          <IconBtn t={t} size="lg" title="Close (Esc)" onClick={onClose}>
            {Icons.close}
          </IconBtn>
        </header>
        {actionMenu && (
          <ContextMenu
            mode={mode}
            position={actionMenu.pos}
            onClose={() => setActionMenu(null)}
            rowName={
              target.namespace
                ? `${kind.kind} · ${target.namespace}/${target.name}`
                : `${kind.kind} · ${target.name}`
            }
            items={buildActionMenuItems(
              actionMenu.kind,
              kind.kind,
              kind.id,
              target.name,
              podContainers,
              onOpenExec,
              runDelete,
            )}
          />
        )}

        <div
          style={{
            display: "flex",
            gap: 0,
            padding: "0 14px",
            borderBottom: `1px solid ${t.borderSoft}`,
            background: t.headerAlt,
            flexShrink: 0,
          }}
        >
          {hasSummary && (
            <TabButton
              t={t}
              active={tab === "summary"}
              onClick={() => setTab("summary")}
            >
              Summary
            </TabButton>
          )}
          {hasYaml && (
            <TabButton t={t} active={tab === "yaml"} onClick={() => setTab("yaml")}>
              YAML
            </TabButton>
          )}
          {hasEvents && (
            <TabButton
              t={t}
              active={tab === "events"}
              onClick={() => setTab("events")}
            >
              Events
            </TabButton>
          )}
          {hasRelated && (
            <TabButton
              t={t}
              active={tab === "related"}
              onClick={() => setTab("related")}
            >
              Related
            </TabButton>
          )}
          {isPod && podContainers.length > 0 && (
            <TabButton
              t={t}
              active={tab === "logs"}
              onClick={() => setTab("logs")}
            >
              Logs
            </TabButton>
          )}
          {hasMetrics && (
            <TabButton
              t={t}
              active={tab === "metrics"}
              onClick={() => setTab("metrics")}
            >
              Metrics
            </TabButton>
          )}
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            background: mode === "dark" ? "#1e1e1e" : "#fafbfc",
          }}
        >
          {tab === "summary" && hasSummary ? (
            isPod ? (
              <PodSummary
                mode={mode}
                clusterId={clusterId}
                target={target}
                row={row ?? null}
                kindLabel={kind.kind}
                onNavigate={onNavigate}
                detailVersion={detailVersion}
              />
            ) : (
              <WorkloadSummaryDispatch
                mode={mode}
                clusterId={clusterId}
                kindId={kind.id}
                namespace={target.namespace}
                name={target.name}
                uid={target.uid}
                detailVersion={detailVersion}
                onNavigate={onNavigate}
              />
            )
          ) : tab === "yaml" ? (
            load.kind === "error" ? (
              <pre
                style={{
                  padding: 18,
                  fontFamily: FONT_MONO,
                  fontSize: 11.5,
                  color: t.bad,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  margin: 0,
                }}
              >
                {load.message}
              </pre>
            ) : load.kind === "loading" ? (
              <LoadingLine t={t} label="Fetching YAML…" />
            ) : (
              <YamlPane
                mode={mode}
                t={t}
                yaml={load.kind === "ready" ? load.yaml : ""}
                original={load.kind === "ready" ? load.original : null}
                refreshedAt={load.kind === "ready" ? load.refreshedAt : null}
                clusterId={clusterId}
                kindId={kind.id}
                namespace={target.namespace}
                name={target.name}
                buffer={yamlBuffer}
                setBuffer={setYamlBuffer}
                saving={yamlSaving}
                setSaving={setYamlSaving}
                conflict={yamlConflict}
                setConflict={setYamlConflict}
                error={yamlError}
                setError={setYamlError}
                onSaved={() => {
                  setYamlBuffer(null);
                  setYamlConflict(null);
                  setYamlError(null);
                  refetch();
                  setDetailVersion((v) => v + 1);
                }}
              />
            )
          ) : null}
          {tab === "events" ? (
            <ObjectEvents
              mode={mode}
              clusterId={clusterId}
              targetUid={target.uid}
            />
          ) : null}
          {tab === "related" && hasRelated ? (
            <RelatedPane
              mode={mode}
              clusterId={clusterId}
              kindId={kind.id}
              kindLabel={kind.kind}
              target={target}
              onNavigate={onNavigate}
              detailVersion={detailVersion}
            />
          ) : null}
          {tab === "logs" && isPod && target.namespace ? (
            <InlineLogTab
              mode={mode}
              clusterId={clusterId}
              namespace={target.namespace}
              name={target.name}
              containers={podContainers}
            />
          ) : null}
          {tab === "metrics" &&
          hasMetrics &&
          (isNode || isNamespace || target.namespace) ? (
            <MetricsTab
              mode={mode}
              clusterId={clusterId}
              namespace={target.namespace ?? undefined}
              name={target.name}
              kind={
                isNode
                  ? "node"
                  : isNamespace
                    ? "namespace"
                    : isWorkload
                      ? "workload"
                      : isPvc
                        ? "pvc"
                        : "pod"
              }
              controllerKind={workloadControllerKind}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

// Manifest editor — the YAML tab body. Read-only by default; the operator
// flips into edit mode via the pencil chip in the chrome bar. Save sends
// only the touched paths through `apply_resource_cmd` so SSA tracks
// ownership at field-level granularity, not document-level.
function YamlPane({
  mode,
  t,
  yaml,
  original,
  refreshedAt,
  clusterId,
  kindId,
  namespace,
  name,
  buffer,
  setBuffer,
  saving,
  setSaving,
  conflict,
  setConflict,
  error,
  setError,
  onSaved,
}: {
  mode: ThemeMode;
  t: Tokens;
  yaml: string;
  original: Json | null;
  refreshedAt: number | null;
  clusterId: string;
  kindId: string;
  namespace: string | null;
  name: string;
  buffer: string | null;
  setBuffer: (v: string | null) => void;
  saving: boolean;
  setSaving: (v: boolean) => void;
  conflict: { managers: string[]; fields: string[]; message: string } | null;
  setConflict: (
    v: { managers: string[]; fields: string[]; message: string } | null,
  ) => void;
  error: string | null;
  setError: (v: string | null) => void;
  onSaved: () => void;
}) {
  const editing = buffer !== null;
  // The editor's live text. When editing we render the operator's buffer;
  // otherwise we mirror the freshly-fetched stripped YAML.
  const value = editing ? buffer! : yaml;

  // 1s tick so the "fetched X ago" indicator in the toolbar refreshes.
  const [, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (refreshedAt == null || editing) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [refreshedAt, editing]);

  // Diff metrics — only meaningful while editing. `count` drives the Save
  // chip; `onlyDeletions` flips the warning so the operator isn't confused
  // when key-removal edits don't take effect under our partial-tree apply.
  const diff = useMemo(() => {
    if (!editing || original == null) {
      return { count: 0, partial: {}, empty: true, onlyDeletions: false };
    }
    try {
      const edited = parseYaml(buffer!);
      return diffPartial(original, edited);
    } catch {
      return { count: -1, partial: {}, empty: true, onlyDeletions: false };
    }
  }, [editing, buffer, original]);

  const enter = () => {
    setError(null);
    setConflict(null);
    setBuffer(yaml);
  };
  const cancel = () => {
    setBuffer(null);
    setConflict(null);
    setError(null);
  };

  const apply = async (force: boolean) => {
    if (original == null) {
      setError("Cannot edit: original document failed to parse.");
      return;
    }
    let edited: Json;
    try {
      edited = parseYaml(buffer ?? "");
    } catch (e) {
      setError(`YAML parse error: ${String(e)}`);
      return;
    }
    const d = diffPartial(original, edited);
    if (d.empty && !d.onlyDeletions) {
      setError("Nothing changed.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await api.applyResource(
        clusterId,
        kindId,
        namespace,
        name,
        d.partial,
        force,
      );
      if (result.kind === "applied") {
        setSaving(false);
        onSaved();
      } else {
        setSaving(false);
        setConflict({
          managers: result.managers,
          fields: result.fields,
          message: result.message,
        });
      }
    } catch (e) {
      setSaving(false);
      setError(String(e));
    }
  };

  // The chrome bar above the editor — pencil → Save (N) / Cancel chips.
  // Disabled when the original couldn't be parsed (e.g. malformed YAML
  // returned from the apiserver, which shouldn't happen but isn't fatal).
  const editable = original != null;
  const dirtyForChrome = diff.count > 0 ? diff.count : 0;

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 14px",
          borderBottom: `1px solid ${t.borderSoft}`,
          background: t.headerAlt,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            fontFamily: FONT_MONO,
            color: t.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}
        >
          {editing
            ? diff.count === -1
              ? "YAML parse error"
              : diff.onlyDeletions && diff.count === 0
                ? "removals only — not applied"
                : `editing · ${dirtyForChrome} change${dirtyForChrome === 1 ? "" : "s"}`
            : refreshedAt != null
              ? `read-only · status & managed fields hidden · fetched ${timeAgo(refreshedAt)}`
              : "read-only · status & managed fields hidden"}
        </span>
        {editable && (
          <EditModeChrome
            t={t}
            editing={editing}
            dirty={dirtyForChrome}
            saving={saving}
            onEnter={enter}
            onCancel={cancel}
            onSave={() => apply(false)}
          />
        )}
      </div>
      {error && (
        <div
          style={{
            padding: "8px 14px",
            background: "rgba(244,63,94,0.1)",
            color: t.bad,
            fontSize: 11.5,
            fontFamily: FONT_MONO,
            borderBottom: `1px solid ${t.borderSoft}`,
            flexShrink: 0,
          }}
        >
          {error}
        </div>
      )}
      {conflict && (
        <div style={{ padding: "10px 14px 0", flexShrink: 0 }}>
          <ConflictBanner
            t={t}
            conflict={conflict}
            saving={saving}
            onForce={() => apply(true)}
            onDismiss={() => setConflict(null)}
          />
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          language="yaml"
          theme={mode === "dark" ? "vs-dark" : "light"}
          value={value}
          onChange={(next) => {
            if (!editing) return;
            setBuffer(next ?? "");
          }}
          onMount={installClipboardShortcuts}
          options={{
            readOnly: !editing || saving,
            minimap: { enabled: false },
            fontSize: 12,
            fontFamily:
              '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
            wordWrap: "on",
            scrollBeyondLastLine: false,
            renderLineHighlight: "none",
            folding: true,
          }}
        />
      </div>
    </div>
  );
}

// Related-resources tab. Pure-frontend projection of fields the kind's
// existing detail API already returns:
//
//   • Pod: ownerReferences chain, node, ServiceAccount, image-pull-secrets,
//     and any mounted volume that points at a browseable object
//     (ConfigMap / Secret / PVC).
//   • Workload kinds (Deployment / RS / STS / DS / Job / CronJob): owner
//     chain. Child-pod resolution would need a new backend command and
//     lives elsewhere — flagged inline so the operator knows where to look.
function RelatedPane({
  mode,
  clusterId,
  kindId,
  kindLabel,
  target,
  onNavigate,
  detailVersion,
}: {
  mode: ThemeMode;
  clusterId: string;
  kindId: string;
  kindLabel: string;
  target: DetailTarget;
  onNavigate?: DetailNavigate;
  detailVersion: number;
}) {
  const t = tokens(mode);
  type State =
    | { kind: "loading" }
    | { kind: "ready"; items: RelatedItem[] }
    | { kind: "error"; message: string };
  const [state, setState] = useState<State>({ kind: "loading" });
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    fetchRelated(clusterId, kindId, target)
      .then((items) => {
        if (reqId.current === id) setState({ kind: "ready", items });
      })
      .catch((e: unknown) => {
        if (reqId.current === id)
          setState({ kind: "error", message: String(e) });
      });
    // detailVersion is intentionally part of the dep array — bumped on
    // every Upsert so the related projection refreshes alongside Summary.
  }, [clusterId, kindId, target.namespace, target.name, detailVersion]);

  if (state.kind === "loading") {
    return (
      <div style={{ height: "100%", background: t.bg }}>
        <LoadingLine t={t} label="Loading related…" />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div style={{ height: "100%", background: t.bg }}>
        <pre
          style={{
            padding: 18,
            fontFamily: FONT_MONO,
            fontSize: 11.5,
            color: t.bad,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: 0,
          }}
        >
          {state.message}
        </pre>
      </div>
    );
  }

  // Group items by section heading so the operator scans related objects
  // by category rather than as one flat list.
  const groups = new Map<string, RelatedItem[]>();
  for (const it of state.items) {
    const arr = groups.get(it.section) ?? [];
    arr.push(it);
    groups.set(it.section, arr);
  }

  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        padding: "18px 22px 22px",
        background: t.bg,
        color: t.text,
      }}
    >
      {state.items.length === 0 ? (
        <Mute t={t}>
          No related objects surfaced for this {kindLabel}.
        </Mute>
      ) : (
        Array.from(groups.entries()).map(([title, items]) => (
          <div key={title} style={{ marginBottom: 22 }}>
            <Section
              t={t}
              title={title}
              right={
                <span
                  style={{
                    fontSize: 10.5,
                    fontFamily: FONT_MONO,
                    color: t.textMuted,
                  }}
                >
                  {items.length} total
                </span>
              }
            />
            {items.map((it, i) => (
              <DetailRow t={t} key={`${title}-${i}`} label={it.label}>
                {it.targetKind ? (
                  <LinkValue
                    t={t}
                    onClick={() =>
                      onNavigate?.(
                        it.targetKind!,
                        it.targetNamespace ?? null,
                        it.targetName,
                      )
                    }
                    copyText={it.targetName}
                    enabled={!!onNavigate}
                  >
                    <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                      {it.targetKind} · {it.targetName}
                    </span>
                  </LinkValue>
                ) : (
                  <Copyable text={it.targetName}>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                      {it.targetName}
                    </span>
                  </Copyable>
                )}
              </DetailRow>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

type RelatedItem = {
  // Section heading the item appears under (e.g. "Owners", "Mounts").
  section: string;
  // Left-side label of the row (e.g. "Controller", "ConfigMap").
  label: string;
  // The Kubernetes Kind name to navigate to. Null when there's no
  // browseable target (raw fact, not a clickable object).
  targetKind: string | null;
  targetNamespace: string | null;
  targetName: string;
};

async function fetchRelated(
  clusterId: string,
  kindId: string,
  target: DetailTarget,
): Promise<RelatedItem[]> {
  const ns = target.namespace;
  if (kindId === "pods" && ns) {
    const d = await api.getPodDetail(clusterId, ns, target.name);
    const out: RelatedItem[] = [];
    for (const o of d.owners) {
      out.push({
        section: "Owners",
        label: o.controller ? "Controller" : "Owner",
        targetKind: o.kind,
        targetNamespace: ns,
        targetName: o.name,
      });
    }
    if (d.node) {
      out.push({
        section: "Scheduling",
        label: "Node",
        targetKind: "Node",
        targetNamespace: null,
        targetName: d.node,
      });
    }
    if (d.service_account) {
      out.push({
        section: "Identity",
        label: "ServiceAccount",
        targetKind: "ServiceAccount",
        targetNamespace: ns,
        targetName: d.service_account,
      });
    }
    for (const s of d.image_pull_secrets) {
      out.push({
        section: "Identity",
        label: "ImagePullSecret",
        targetKind: "Secret",
        targetNamespace: ns,
        targetName: s,
      });
    }
    for (const v of d.volumes) {
      if (!v.target_kind || !v.source_name) continue;
      out.push({
        section: "Mounts",
        label: v.target_kind,
        targetKind: v.target_kind,
        targetNamespace: ns,
        targetName: v.source_name,
      });
    }
    return out;
  }
  if (kindId === "deployments" && ns) {
    const d = await api.getDeploymentDetail(clusterId, ns, target.name);
    return ownerChain(d.meta.controlled_by, ns);
  }
  if (kindId === "replicasets" && ns) {
    const d = await api.getReplicaSetDetail(clusterId, ns, target.name);
    return ownerChain(d.meta.controlled_by, ns);
  }
  if (kindId === "statefulsets" && ns) {
    const d = await api.getStatefulSetDetail(clusterId, ns, target.name);
    return ownerChain(d.meta.controlled_by, ns);
  }
  if (kindId === "daemonsets" && ns) {
    const d = await api.getDaemonSetDetail(clusterId, ns, target.name);
    return ownerChain(d.meta.controlled_by, ns);
  }
  if (kindId === "jobs" && ns) {
    const d = await api.getJobDetail(clusterId, ns, target.name);
    return ownerChain(d.meta.controlled_by, ns);
  }
  if (kindId === "cronjobs" && ns) {
    const d = await api.getCronJobDetail(clusterId, ns, target.name);
    return ownerChain(d.meta.controlled_by, ns);
  }
  return [];
}

function ownerChain(
  ref: { kind: string; name: string } | null,
  namespace: string,
): RelatedItem[] {
  if (!ref) return [];
  return [
    {
      section: "Owners",
      label: "Controller",
      targetKind: ref.kind,
      targetNamespace: namespace,
      targetName: ref.name,
    },
  ];
}

function TabButton({
  t,
  active,
  onClick,
  children,
}: {
  t: ReturnType<typeof tokens>;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 11,
        fontWeight: 600,
        fontFamily: FONT_MONO,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        padding: "10px 14px",
        marginBottom: -1,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        color: active ? t.accent : t.textMuted,
        borderBottom: `2px solid ${active ? t.accent : "transparent"}`,
        transition: "color .12s, border-color .12s",
      }}
    >
      {children}
    </button>
  );
}

type EventState =
  | { kind: "loading" }
  | { kind: "ready"; rows: ResourceRow[] }
  | { kind: "error"; message: string };

function ObjectEvents({
  mode,
  clusterId,
  targetUid,
}: {
  mode: ThemeMode;
  clusterId: string;
  targetUid: string;
}) {
  const t = tokens(mode);
  const [state, setState] = useState<EventState>({ kind: "loading" });
  const rowsRef = useRef<Map<string, ResourceRow>>(new Map());
  const initialDoneRef = useRef(false);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    rowsRef.current = new Map();
    initialDoneRef.current = false;
    setState({ kind: "loading" });

    (async () => {
      try {
        unlisten = await onResourceDelta(clusterId, "events", (delta) => {
          if (cancelled) return;
          if (delta.kind === "init_done") return;
          const next = new Map(rowsRef.current);
          if (delta.kind === "upsert") {
            if (delta.row.involved_uid === targetUid) {
              next.set(delta.row.uid, delta.row);
            }
          } else {
            next.delete(delta.uid);
          }
          rowsRef.current = next;
          // Hold the loading state until the initial snapshot has merged —
          // otherwise an unrelated cluster-wide event delta flips us to
          // "ready" with an empty map and the spinner never shows.
          if (initialDoneRef.current) {
            setState({ kind: "ready", rows: Array.from(next.values()) });
          }
        });

        const result = await api.subscribeResource(clusterId, "events", null);
        if (cancelled) return;
        const merged = new Map<string, ResourceRow>(rowsRef.current);
        for (const row of result.rows) {
          if (row.involved_uid === targetUid) merged.set(row.uid, row);
        }
        rowsRef.current = merged;
        initialDoneRef.current = true;
        setState({ kind: "ready", rows: Array.from(merged.values()) });
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: String(e) });
      }
    })();

    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(tick);
      if (unlisten) unlisten();
      api.unsubscribeResource(clusterId, "events").catch(() => {});
    };
  }, [clusterId, targetUid]);

  const sorted = useMemo(() => {
    if (state.kind !== "ready") return [];
    return [...state.rows].sort((a, b) => {
      const at = parseTs(a.last_seen);
      const bt = parseTs(b.last_seen);
      return bt - at;
    });
  }, [state]);

  if (state.kind === "loading") {
    return (
      <div style={{ height: "100%", background: t.bg }}>
        <LoadingLine t={t} label="Loading events…" />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div style={{ height: "100%", background: t.bg }}>
        <pre
          style={{
            padding: 18,
            fontFamily: FONT_MONO,
            fontSize: 11.5,
            color: t.bad,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: 0,
          }}
        >
          {state.message}
        </pre>
      </div>
    );
  }
  if (sorted.length === 0) {
    return (
      <div style={{ padding: 18, height: "100%", background: t.bg }}>
        <Eyebrow t={t}>No events for this object</Eyebrow>
        <div
          style={{
            marginTop: 6,
            fontSize: 12,
            color: t.textMuted,
          }}
        >
          Events appear here as the API server records them. They expire after
          ~1h by cluster default.
        </div>
      </div>
    );
  }

  return (
    <div style={{ overflow: "auto", height: "100%", background: t.bg }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12,
          color: t.text,
        }}
      >
        <thead
          style={{
            position: "sticky",
            top: 0,
            background: t.headerAlt,
            borderBottom: `1px solid ${t.border}`,
          }}
        >
          <tr>
            {[
              ["Type", 90],
              ["Reason", 170],
              ["Message", null],
              ["Count", 70],
              ["Age", 80],
            ].map(([h, w]) => (
              <th
                key={String(h)}
                style={{
                  textAlign: "left",
                  padding: "10px 14px",
                  fontSize: 10.5,
                  fontWeight: 700,
                  color: t.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  fontFamily: FONT_MONO,
                  width: typeof w === "number" ? w : undefined,
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={r.uid}
              style={{
                borderBottom: `1px solid ${t.borderSoft}`,
                verticalAlign: "top",
              }}
            >
              <td style={{ padding: "8px 14px" }}>
                <StatusPill
                  status={
                    String(r.type ?? "") === "Warning" ? "Warning" : "Running"
                  }
                  t={t}
                  mode={mode}
                  dense
                />
              </td>
              <td
                style={{
                  padding: "8px 14px",
                  color: t.textDim,
                  fontFamily: FONT_MONO,
                  fontSize: 11.5,
                }}
              >
                {String(r.reason ?? "")}
              </td>
              <td
                style={{
                  padding: "8px 14px",
                  color: t.text,
                  wordBreak: "break-word",
                }}
              >
                {String(r.message ?? "")}
              </td>
              <td
                style={{
                  padding: "8px 14px",
                  fontVariantNumeric: "tabular-nums",
                  fontFamily: FONT_MONO,
                  color: t.textDim,
                }}
              >
                {String(r.count ?? 0)}
              </td>
              <td
                style={{
                  padding: "8px 14px",
                  fontVariantNumeric: "tabular-nums",
                  fontFamily: FONT_MONO,
                  color: t.textMuted,
                }}
              >
                {formatAge(r.last_seen, now)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Pod summary tab ────────────────────────────────────────────────────────
// Lens-style label/value layout: pod-level rows, then per-container cards.
// Pulls the rich projection from `get_pod_detail_cmd` once on open and
// refetches when the watcher emits an Upsert for this uid.
type DetailState =
  | { kind: "loading" }
  | { kind: "ready"; detail: PodDetail }
  | { kind: "error"; message: string };

function PodSummary({
  mode,
  clusterId,
  target,
  row,
  kindLabel,
  onNavigate,
  detailVersion,
}: {
  mode: ThemeMode;
  clusterId: string;
  target: DetailTarget;
  row: ResourceRow | null;
  kindLabel: string;
  onNavigate?: DetailNavigate;
  // Bumped by the parent each time the watcher upserts this uid, so we
  // refetch without re-mounting.
  detailVersion: number;
}) {
  const t = tokens(mode);
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [refetch, setRefetch] = useState(0);
  const reqId = useRef(0);
  const ns = target.namespace;
  const name = target.name;

  useEffect(() => {
    if (!ns) {
      setState({
        kind: "error",
        message: `${kindLabel} requires a namespace.`,
      });
      return;
    }
    const id = ++reqId.current;
    api
      .getPodDetail(clusterId, ns, name)
      .then((detail) => {
        if (reqId.current === id) setState({ kind: "ready", detail });
      })
      .catch((e: unknown) => {
        if (reqId.current === id)
          setState({ kind: "error", message: String(e) });
      });
  }, [clusterId, ns, name, kindLabel, detailVersion, refetch]);

  if (state.kind === "loading") {
    // Fall back to the row payload for an instant skeleton — phase + container
    // dots — while the typed fetch lands.
    return (
      <div
        style={{
          height: "100%",
          overflow: "auto",
          padding: "18px 22px 22px",
          background: t.bg,
          color: t.text,
        }}
      >
        {row ? <SkeletonFromRow t={t} row={row} mode={mode} /> : null}
        <div style={{ marginTop: 16 }}>
          <LoadingLine t={t} label="Loading pod detail…" inline />
        </div>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <pre
        style={{
          padding: 18,
          fontFamily: FONT_MONO,
          fontSize: 11.5,
          color: t.bad,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          margin: 0,
        }}
      >
        {state.message}
      </pre>
    );
  }

  const d = state.detail;
  const containerLites: ContainerLite[] = d.containers.map((c) => ({
    name: c.name,
    status: c.state,
    kind: c.kind,
  }));
  const initContainers = d.containers.filter((c) => c.kind === "init");
  const mainContainers = d.containers.filter((c) => c.kind !== "init");

  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        padding: "18px 22px 22px",
        background: t.bg,
        color: t.text,
      }}
    >
      {/* Pod-level overview row — phase + dots + summary counts, like the
          design overlay header */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 10,
          marginBottom: 18,
        }}
      >
        <StatusPill
          status={d.status_phase ?? "Unknown"}
          t={t}
          mode={mode}
        />
        {containerLites.length > 0 && (
          <ContainerDots containers={containerLites} t={t} size={9} />
        )}
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          {readyCount(d)} ready · {totalRestarts(d)} restarts
          {d.created_at ? ` · ${ageFromIso(d.created_at)} old` : ""}
        </span>
      </div>

      {/* Pod-level details — one row per field, label on the left, value on
          the right. Mirrors Lens. */}
      <Section t={t} title="Details" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Created">
          {d.created_at ? (
            <Copyable text={d.created_at}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {ageFromIso(d.created_at)} ago
                <span style={{ color: t.textMuted, marginLeft: 8 }}>
                  ({d.created_at})
                </span>
              </span>
            </Copyable>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
        <DetailRow t={t} label="Name">
          <Copyable text={d.name}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>{d.name}</span>
          </Copyable>
        </DetailRow>
        <DetailRow t={t} label="Namespace">
          {d.namespace ? (
            <LinkValue
              t={t}
              onClick={() => onNavigate?.("Namespace", null, d.namespace!)}
              copyText={d.namespace}
              enabled={!!onNavigate}
            >
              {d.namespace}
            </LinkValue>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
        {d.uid && (
          <DetailRow t={t} label="UID">
            <Copyable text={d.uid}>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11.5,
                  color: t.textDim,
                  wordBreak: "break-all",
                }}
              >
                {d.uid}
              </span>
            </Copyable>
          </DetailRow>
        )}
        <MetaPairsRow
          t={t}
          label="Labels"
          pairs={d.labels}
          editTarget={
            ns
              ? {
                  clusterId,
                  kindId: "pods",
                  namespace: ns,
                  name,
                }
              : undefined
          }
          metadataKey="labels"
          onSaved={() => setRefetch((r) => r + 1)}
          keyValidate={(k) => /^([a-z0-9.-]+\/)?[A-Za-z0-9._-]+$/.test(k)}
        />
        <MetaPairsRow
          t={t}
          label="Annotations"
          pairs={d.annotations}
          editTarget={
            ns
              ? {
                  clusterId,
                  kindId: "pods",
                  namespace: ns,
                  name,
                }
              : undefined
          }
          metadataKey="annotations"
          onSaved={() => setRefetch((r) => r + 1)}
          keyValidate={(k) => /^([a-z0-9.-]+\/)?[A-Za-z0-9._-]+$/.test(k)}
          collapsedAsCount
        />
        {d.controlled_by && (
          <DetailRow t={t} label="Controlled By">
            <span style={{ fontSize: 12 }}>{d.controlled_by.kind}</span>{" "}
            <LinkValue
              t={t}
              onClick={() =>
                onNavigate?.(
                  d.controlled_by!.kind,
                  d.namespace,
                  d.controlled_by!.name,
                )
              }
              copyText={d.controlled_by.name}
              enabled={!!onNavigate}
            >
              {d.controlled_by.name}
            </LinkValue>
          </DetailRow>
        )}
        <DetailRow t={t} label="Status">
          <StatusPill
            status={d.status_phase ?? "Unknown"}
            t={t}
            mode={mode}
            dense
          />
          {d.status_reason && (
            <span
              style={{
                fontSize: 11.5,
                color: t.textDim,
                marginLeft: 8,
              }}
            >
              {d.status_reason}
            </span>
          )}
        </DetailRow>
        {d.node && (
          <DetailRow t={t} label="Node">
            <LinkValue
              t={t}
              onClick={() => onNavigate?.("Node", null, d.node!)}
              copyText={d.node}
              enabled={!!onNavigate}
            >
              {d.node}
            </LinkValue>
          </DetailRow>
        )}
        {d.host_ips.length > 0 && (
          <DetailRow t={t} label="Host IPs">
            <ChipWrap>
              {d.host_ips.map((ip) => (
                <Copyable key={ip} text={ip}>
                  <Chip t={t} mono>
                    {ip}
                  </Chip>
                </Copyable>
              ))}
            </ChipWrap>
          </DetailRow>
        )}
        {d.pod_ips.length > 0 && (
          <DetailRow t={t} label="Pod IPs">
            <ChipWrap>
              {d.pod_ips.map((ip) => (
                <Copyable key={ip} text={ip}>
                  <Chip t={t} mono>
                    {ip}
                  </Chip>
                </Copyable>
              ))}
            </ChipWrap>
          </DetailRow>
        )}
        {d.service_account && (
          <DetailRow t={t} label="Service Account">
            <LinkValue
              t={t}
              onClick={() =>
                onNavigate?.("ServiceAccount", d.namespace, d.service_account!)
              }
              copyText={d.service_account}
              enabled={!!onNavigate}
            >
              {d.service_account}
            </LinkValue>
          </DetailRow>
        )}
        {d.qos_class && (
          <DetailRow t={t} label="QoS Class">
            <Copyable text={d.qos_class}>
              <span style={{ fontSize: 12 }}>{d.qos_class}</span>
            </Copyable>
          </DetailRow>
        )}
        {d.termination_grace_period_s != null && (
          <DetailRow t={t} label="Termination Grace Period">
            <Copyable text={`${d.termination_grace_period_s}s`}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {d.termination_grace_period_s}s
              </span>
            </Copyable>
          </DetailRow>
        )}
        {d.priority_class && (
          <DetailRow t={t} label="Priority Class">
            <Copyable text={d.priority_class}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {d.priority_class}
              </span>
            </Copyable>
          </DetailRow>
        )}
        {d.tolerations.length > 0 && (
          <DetailRow t={t} label="Tolerations">
            <span style={{ fontSize: 12, color: t.textDim }}>
              {d.tolerations.length} total
            </span>
          </DetailRow>
        )}
        {d.conditions.length > 0 && (
          <DetailRow t={t} label="Conditions">
            <ChipWrap>
              {d.conditions.map((c) => (
                <ConditionChip key={c.type} t={t} cond={c} />
              ))}
            </ChipWrap>
          </DetailRow>
        )}
      </div>

      {hasResourceTotals(d) && (
        <>
          <Section t={t} title="Resources" />
          <div style={{ marginBottom: 22 }}>
            <DetailRow t={t} label="Sum of containers">
              <SubGrid
                t={t}
                groups={[
                  ...(Object.keys(d.totals.requests).length > 0
                    ? [
                        {
                          label: "Requests",
                          entries: Object.entries(d.totals.requests).map(
                            ([k, v]) => ({ key: k, value: v }),
                          ),
                        },
                      ]
                    : []),
                  ...(Object.keys(d.totals.limits).length > 0
                    ? [
                        {
                          label: "Limits",
                          entries: Object.entries(d.totals.limits).map(
                            ([k, v]) => ({ key: k, value: v }),
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            </DetailRow>
          </div>
        </>
      )}

      {d.scheduling && hasScheduling(d.scheduling) && (
        <>
          <Section t={t} title="Scheduling" />
          <div style={{ marginBottom: 22 }}>
            {d.scheduling.node_selector.length > 0 && (
              <DetailRow t={t} label="Node Selector">
                <KeyValueChips t={t} pairs={d.scheduling.node_selector} />
              </DetailRow>
            )}
            {d.scheduling.topology_spread.length > 0 && (
              <DetailRow t={t} label="Topology Spread">
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                    fontSize: 11.5,
                    fontFamily: FONT_MONO,
                  }}
                >
                  {d.scheduling.topology_spread.map((c, i) => (
                    <div key={i}>
                      <span style={{ color: t.textDim }}>
                        {c.topology_key}
                      </span>
                      <span style={{ color: t.textMuted }}>
                        {" "}
                        · maxSkew={c.max_skew} · {c.when_unsatisfiable}
                      </span>
                    </div>
                  ))}
                </div>
              </DetailRow>
            )}
            {d.scheduling.affinity && (
              <DetailRow t={t} label="Affinity">
                <ChipWrap>
                  {d.scheduling.affinity.node_affinity && (
                    <Chip t={t} mono>
                      node ·{" "}
                      {d.scheduling.affinity.node_affinity.required_terms}{" "}
                      required ·{" "}
                      {d.scheduling.affinity.node_affinity.preferred_terms}{" "}
                      preferred
                    </Chip>
                  )}
                  {d.scheduling.affinity.pod_affinity && (
                    <Chip t={t} mono>
                      pod ·{" "}
                      {d.scheduling.affinity.pod_affinity.required_terms}{" "}
                      required ·{" "}
                      {d.scheduling.affinity.pod_affinity.preferred_terms}{" "}
                      preferred
                    </Chip>
                  )}
                  {d.scheduling.affinity.pod_anti_affinity && (
                    <Chip t={t} mono>
                      anti-pod ·{" "}
                      {
                        d.scheduling.affinity.pod_anti_affinity
                          .required_terms
                      }{" "}
                      required ·{" "}
                      {
                        d.scheduling.affinity.pod_anti_affinity
                          .preferred_terms
                      }{" "}
                      preferred
                    </Chip>
                  )}
                </ChipWrap>
              </DetailRow>
            )}
            {d.scheduling.scheduler_name &&
              d.scheduling.scheduler_name !== "default-scheduler" && (
                <DetailRow t={t} label="Scheduler">
                  <Copyable text={d.scheduling.scheduler_name}>
                    <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                      {d.scheduling.scheduler_name}
                    </span>
                  </Copyable>
                </DetailRow>
              )}
            {d.scheduling.priority != null && (
              <DetailRow t={t} label="Priority">
                <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                  {d.scheduling.priority}
                </span>
              </DetailRow>
            )}
            {d.scheduling.runtime_class && (
              <DetailRow t={t} label="Runtime Class">
                <Copyable text={d.scheduling.runtime_class}>
                  <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                    {d.scheduling.runtime_class}
                  </span>
                </Copyable>
              </DetailRow>
            )}
            {d.restart_policy && d.restart_policy !== "Always" && (
              <DetailRow t={t} label="Restart Policy">
                <span style={{ fontSize: 12 }}>{d.restart_policy}</span>
              </DetailRow>
            )}
          </div>
        </>
      )}

      {d.security && hasPodSecurity(d.security) && (
        <>
          <Section t={t} title="Security" />
          <div style={{ marginBottom: 22 }}>
            <PodSecuritySection
              t={t}
              s={d.security}
              imagePullSecrets={d.image_pull_secrets}
              namespace={d.namespace}
              onNavigate={onNavigate}
            />
          </div>
        </>
      )}

      {initContainers.length > 0 && (
        <>
          <Section
            t={t}
            title="Init Containers"
            right={
              <span
                style={{
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                }}
              >
                {initContainers.length} total
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {initContainers.map((c) => (
              <ContainerCard
                key={c.name}
                t={t}
                mode={mode}
                c={c}
                clusterId={clusterId}
                namespace={ns}
                podName={name}
                onSaved={() => setRefetch((r) => r + 1)}
              />
            ))}
          </div>
        </>
      )}

      {mainContainers.length > 0 && (
        <>
          <Section
            t={t}
            title="Containers"
            right={
              <span
                style={{
                  fontSize: 10.5,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                }}
              >
                {mainContainers.length} total
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {mainContainers.map((c) => (
              <ContainerCard
                key={c.name}
                t={t}
                mode={mode}
                c={c}
                clusterId={clusterId}
                namespace={ns}
                podName={name}
                onSaved={() => setRefetch((r) => r + 1)}
              />
            ))}
          </div>
        </>
      )}

      {ns && (
        <VolumesEditor
          t={t}
          volumes={d.volumes}
          podNamespace={d.namespace}
          onNavigate={onNavigate}
          editTarget={{
            clusterId,
            kindId: "pods",
            namespace: ns,
            name,
          }}
          serializeFor={(vols) => ({ spec: { volumes: vols } })}
          onSaved={() => setRefetch((r) => r + 1)}
        />
      )}

    </div>
  );
}


// Show the previous run's exit code + reason. This is the single most useful
// field when diagnosing CrashLoopBackOff: the *current* state is "Waiting,
// CrashLoopBackOff" but the *last* state carries the actual exit signal and
// finish time. Coloured red for non-zero exits so it pops in the panel.
function LastStatePill({ t, ls }: { t: Tokens; ls: ContainerLastState }) {
  if (ls.kind === "terminated") {
    const bad = ls.exit_code !== 0;
    const entries: SubEntry[] = [
      { key: "kind", value: "terminated", tone: bad ? "bad" : "default" },
      {
        key: "exit",
        value: String(ls.exit_code),
        tone: bad ? "bad" : "default",
      },
      ...(ls.signal != null
        ? [{ key: "signal", value: String(ls.signal) }]
        : []),
      ...(ls.reason ? [{ key: "reason", value: ls.reason }] : []),
      ...(ls.finished_at
        ? [
            {
              key: "finished",
              value: ls.finished_at,
              hint: `${ageFromIso(ls.finished_at)} ago`,
            },
          ]
        : []),
      ...(ls.message ? [{ key: "message", value: ls.message }] : []),
    ];
    return <SubGrid t={t} entries={entries} copyKeyJoin=":" />;
  }
  return (
    <SubGrid
      t={t}
      copyKeyJoin=":"
      entries={[
        { key: "kind", value: "waiting" },
        ...(ls.reason ? [{ key: "reason", value: ls.reason }] : []),
        ...(ls.message ? [{ key: "message", value: ls.message }] : []),
      ]}
    />
  );
}

// Pod-level securityContext + image pull secrets + host* namespace flags.
// Operators reading this section are usually answering "is anything escaping
// the pod sandbox" — so we emphasise the host-namespace toggles when they're
// on (red), and the run-as identity.
function PodSecuritySection({
  t,
  s,
  imagePullSecrets,
  namespace,
  onNavigate,
}: {
  t: Tokens;
  s: PodSecurity;
  imagePullSecrets: string[];
  namespace: string | null;
  onNavigate?: DetailNavigate;
}) {
  const hostFlags = [
    ["hostNetwork", s.host_network],
    ["hostPID", s.host_pid],
    ["hostIPC", s.host_ipc],
    ["shareProcessNamespace", s.share_process_namespace],
  ].filter(([, v]) => v === true) as [string, boolean][];
  return (
    <>
      {(s.run_as_user != null ||
        s.run_as_group != null ||
        s.run_as_non_root != null) && (
        <DetailRow t={t} label="Run As">
          <SubGrid
            t={t}
            entries={[
              ...(s.run_as_user != null
                ? [{ key: "uid", value: String(s.run_as_user) }]
                : []),
              ...(s.run_as_group != null
                ? [{ key: "gid", value: String(s.run_as_group) }]
                : []),
              ...(s.run_as_non_root === true
                ? [{ key: "nonRoot", value: "true" }]
                : []),
            ]}
          />
        </DetailRow>
      )}
      {s.fs_group != null && (
        <DetailRow t={t} label="FS Group">
          <SubGrid
            t={t}
            entries={[
              { key: "gid", value: String(s.fs_group) },
              ...(s.fs_group_change_policy
                ? [{ key: "policy", value: s.fs_group_change_policy }]
                : []),
            ]}
          />
        </DetailRow>
      )}
      {s.supplemental_groups && s.supplemental_groups.length > 0 && (
        <DetailRow t={t} label="Supplemental Groups">
          <ChipWrap>
            {s.supplemental_groups.map((g) => (
              <Chip key={g} t={t} mono>
                {g}
              </Chip>
            ))}
          </ChipWrap>
        </DetailRow>
      )}
      {s.seccomp_profile_type && (
        <DetailRow t={t} label="Seccomp Profile">
          <span style={{ fontSize: 12 }}>{s.seccomp_profile_type}</span>
        </DetailRow>
      )}
      {s.se_linux_type && (
        <DetailRow t={t} label="SELinux">
          <span style={{ fontSize: 12 }}>{s.se_linux_type}</span>
        </DetailRow>
      )}
      {hostFlags.length > 0 && (
        <DetailRow t={t} label="Host Namespaces">
          <ChipStrip
            t={t}
            items={hostFlags.map(([k]) => ({ label: k, tone: "bad" }))}
          />
        </DetailRow>
      )}
      {imagePullSecrets.length > 0 && (
        <DetailRow t={t} label="Image Pull Secrets">
          <ChipWrap>
            {imagePullSecrets.map((name) => (
              <LinkValue
                key={name}
                t={t}
                onClick={() => onNavigate?.("Secret", namespace, name)}
                copyText={name}
                enabled={!!onNavigate}
              >
                {name}
              </LinkValue>
            ))}
          </ChipWrap>
        </DetailRow>
      )}
    </>
  );
}

// Per-container securityContext as a chip strip. Matches the design's
// chipping for probes — same shape, different content.
function ContainerSecurityRow({ t, s }: { t: Tokens; s: ContainerSecurity }) {
  const items: import("./detail").ChipStripItem[] = [];
  if (s.privileged) items.push({ label: "privileged", tone: "bad" });
  if (s.allow_privilege_escalation === true)
    items.push({ label: "allowPrivilegeEscalation", tone: "bad" });
  if (s.allow_privilege_escalation === false)
    items.push({ label: "no privilege escalation" });
  if (s.read_only_root_filesystem === true)
    items.push({ label: "readOnlyRootFS" });
  if (s.run_as_non_root === true) items.push({ label: "nonRoot" });
  if (s.run_as_user != null)
    items.push({ label: `uid=${s.run_as_user}` });
  if (s.run_as_group != null)
    items.push({ label: `gid=${s.run_as_group}` });
  for (const c of s.capabilities_add) {
    items.push({ label: `+${c}`, tone: "bad" });
  }
  for (const c of s.capabilities_drop) {
    items.push({ label: `-${c}` });
  }
  return <ChipStrip t={t} items={items} />;
}

function hasResourceTotals(d: PodDetail): boolean {
  return (
    Object.keys(d.totals.requests).length > 0 ||
    Object.keys(d.totals.limits).length > 0
  );
}

function hasScheduling(s: PodScheduling): boolean {
  return (
    s.node_selector.length > 0 ||
    s.topology_spread.length > 0 ||
    s.affinity != null ||
    !!s.runtime_class ||
    s.priority != null ||
    (s.scheduler_name !== null &&
      s.scheduler_name !== "" &&
      s.scheduler_name !== "default-scheduler")
  );
}

function hasPodSecurity(s: PodSecurity): boolean {
  return (
    s.run_as_user != null ||
    s.run_as_group != null ||
    s.run_as_non_root != null ||
    s.fs_group != null ||
    !!s.seccomp_profile_type ||
    !!s.se_linux_type ||
    s.host_network === true ||
    s.host_pid === true ||
    s.host_ipc === true ||
    s.share_process_namespace === true ||
    (s.supplemental_groups != null && s.supplemental_groups.length > 0)
  );
}

function hasContainerSecurity(s: ContainerSecurity): boolean {
  return (
    s.privileged != null ||
    s.allow_privilege_escalation != null ||
    s.read_only_root_filesystem != null ||
    s.run_as_user != null ||
    s.run_as_group != null ||
    s.run_as_non_root != null ||
    s.capabilities_add.length > 0 ||
    s.capabilities_drop.length > 0
  );
}

// ── Container card ─────────────────────────────────────────────────────────

function ContainerCard({
  t,
  mode,
  c,
  clusterId,
  namespace,
  podName,
  onSaved,
}: {
  t: Tokens;
  mode: ThemeMode;
  c: ContainerDetail;
  clusterId: string;
  namespace: string | null;
  podName: string;
  onSaved: () => void;
}) {
  return (
    <div
      style={{
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 8,
        marginBottom: 10,
        background: t.surface,
        overflow: "hidden",
      }}
    >
      {/* Header — name + status + kind tag */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          background: t.surfaceAlt,
          borderBottom: `1px solid ${t.borderSoft}`,
        }}
      >
        <ContainerDots
          containers={[{ name: c.name, status: c.state, kind: c.kind }]}
          t={t}
          showSeparator={false}
        />
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 12.5,
            fontWeight: 600,
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {c.name}
        </span>
        <span
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            color: t.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            fontFamily: FONT_MONO,
          }}
        >
          {c.kind}
        </span>
        <StatusPill status={c.state} t={t} mode={mode} dense />
      </div>

      <div style={{ padding: "4px 12px" }}>
        <DetailRow t={t} label="Status">
          <span style={{ fontSize: 12, color: c.ready ? t.good : t.textDim }}>
            {c.state.toLowerCase()}
            {c.ready ? ", ready" : ""}
          </span>
          {c.reason && (
            <Chip t={t} tone="accent">
              {c.reason}
            </Chip>
          )}
          {c.restart_count > 0 && (
            <span
              style={{
                fontSize: 11,
                color: c.restart_count > 5 ? t.bad : t.warn,
                fontFamily: FONT_MONO,
              }}
            >
              · {c.restart_count} restart{c.restart_count === 1 ? "" : "s"}
            </span>
          )}
        </DetailRow>
        {c.started_at && (
          <DetailRow t={t} label="Started">
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {ageFromIso(c.started_at)} ago
              <span style={{ color: t.textMuted, marginLeft: 8 }}>
                ({c.started_at})
              </span>
            </span>
          </DetailRow>
        )}
        {c.last_state && (
          <DetailRow t={t} label="Last State">
            <LastStatePill t={t} ls={c.last_state} />
          </DetailRow>
        )}
        {c.image && (
          <DetailRow t={t} label="Image">
            <Copyable text={c.image}>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11.5,
                  wordBreak: "break-all",
                }}
              >
                {c.image}
              </span>
            </Copyable>
          </DetailRow>
        )}
        {c.image_id && (
          <DetailRow t={t} label="Image ID">
            <Copyable text={c.image_id}>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11.5,
                  color: t.textDim,
                  wordBreak: "break-all",
                }}
              >
                {c.image_id}
              </span>
            </Copyable>
          </DetailRow>
        )}
        {c.container_id && (
          <DetailRow t={t} label="Container ID">
            <Copyable text={c.container_id}>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11.5,
                  color: t.textDim,
                  wordBreak: "break-all",
                }}
              >
                {c.container_id}
              </span>
            </Copyable>
          </DetailRow>
        )}
        {c.image_pull_policy && (
          <DetailRow t={t} label="ImagePullPolicy">
            <span style={{ fontSize: 12 }}>{c.image_pull_policy}</span>
          </DetailRow>
        )}
        {namespace && (
          <PortsEditor
            t={t}
            containerName={c.name}
            ports={c.ports}
            editTarget={{
              clusterId,
              kindId: "pods",
              namespace,
              name: podName,
            }}
            serializeFor={(co) =>
              c.kind === "init" || c.kind === "sidecar"
                ? {
                    spec: {
                      initContainers: [
                        { name: co.name, ports: co.ports },
                      ],
                    },
                  }
                : {
                    spec: {
                      containers: [{ name: co.name, ports: co.ports }],
                    },
                  }
            }
            onSaved={onSaved}
            forwardTarget={{ kind: "Pod", namespace, name: podName }}
          />
        )}
        {namespace && (
          <EnvEditor
            t={t}
            containerName={c.name}
            env={c.env}
            editTarget={{
              clusterId,
              kindId: "pods",
              namespace,
              name: podName,
            }}
            serializeFor={(co) =>
              c.kind === "init" || c.kind === "sidecar"
                ? {
                    spec: {
                      initContainers: [{ name: co.name, env: co.env }],
                    },
                  }
                : {
                    spec: { containers: [{ name: co.name, env: co.env }] },
                  }
            }
            onSaved={onSaved}
          />
        )}
        {c.mounts.length > 0 && (
          <DetailRow t={t} label="Mounts">
            <SubGrid
              t={t}
              copyKeyJoin=":"
              entries={c.mounts.map((m) => ({
                key: m.mount_path,
                hint: (
                  <>
                    from{" "}
                    <span style={{ fontFamily: FONT_MONO, color: t.textDim }}>
                      {m.name}
                    </span>{" "}
                    ({m.read_only ? "ro" : "rw"})
                    {m.sub_path ? (
                      <>
                        {" · sub "}
                        <span style={{ fontFamily: FONT_MONO }}>
                          {m.sub_path}
                        </span>
                      </>
                    ) : null}
                  </>
                ),
              }))}
            />
          </DetailRow>
        )}
        {c.liveness && (
          <DetailRow t={t} label="Liveness">
            <ProbeChips t={t} probe={c.liveness} />
          </DetailRow>
        )}
        {c.readiness && (
          <DetailRow t={t} label="Readiness">
            <ProbeChips t={t} probe={c.readiness} />
          </DetailRow>
        )}
        {c.startup && (
          <DetailRow t={t} label="Startup">
            <ProbeChips t={t} probe={c.startup} />
          </DetailRow>
        )}
        {c.command && c.command.length > 0 && (
          <DetailRow t={t} label="Command">
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11.5,
                wordBreak: "break-all",
              }}
            >
              {c.command.join(" ")}
            </span>
          </DetailRow>
        )}
        {c.args && c.args.length > 0 && (
          <DetailRow t={t} label="Args">
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11.5,
                wordBreak: "break-all",
              }}
            >
              {c.args.join(" ")}
            </span>
          </DetailRow>
        )}
        {c.resources &&
          (c.resources.requests || c.resources.limits) && (
            <DetailRow t={t} label="Resources">
              <SubGrid
                t={t}
                groups={[
                  ...(c.resources.requests &&
                  Object.keys(c.resources.requests).length > 0
                    ? [
                        {
                          label: "Requests",
                          entries: Object.entries(c.resources.requests).map(
                            ([k, v]) => ({ key: k, value: v }),
                          ),
                        },
                      ]
                    : []),
                  ...(c.resources.limits &&
                  Object.keys(c.resources.limits).length > 0
                    ? [
                        {
                          label: "Limits",
                          entries: Object.entries(c.resources.limits).map(
                            ([k, v]) => ({ key: k, value: v }),
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            </DetailRow>
          )}
        {c.security && hasContainerSecurity(c.security) && (
          <DetailRow t={t} label="Security">
            <ContainerSecurityRow t={t} s={c.security} />
          </DetailRow>
        )}
      </div>
    </div>
  );
}

function ProbeChips({ t, probe }: { t: Tokens; probe: ContainerProbe }) {
  const items: string[] = [probe.type];
  if (probe.target) items.push(probe.target);
  if (probe.delay != null) items.push(`delay=${probe.delay}s`);
  if (probe.timeout != null) items.push(`timeout=${probe.timeout}s`);
  if (probe.period != null) items.push(`period=${probe.period}s`);
  if (probe.success != null) items.push(`#success=${probe.success}`);
  if (probe.failure != null) items.push(`#failure=${probe.failure}`);
  return (
    <ChipWrap>
      {items.map((s, i) => (
        <Chip key={i} t={t} mono>
          {s}
        </Chip>
      ))}
    </ChipWrap>
  );
}

// ── Skeleton from row payload (instant first paint) ────────────────────────

function SkeletonFromRow({
  t,
  row,
  mode,
}: {
  t: Tokens;
  row: ResourceRow;
  mode: ThemeMode;
}) {
  const phase = String(row.phase ?? row.status ?? "Unknown");
  const states = Array.isArray(row.container_states)
    ? (row.container_states as Array<Record<string, unknown>>)
    : [];
  const containers: ContainerLite[] = states.map((s) => ({
    name: typeof s.name === "string" ? s.name : "",
    status: typeof s.state === "string" ? s.state : phase,
    kind:
      s.kind === "init" || s.kind === "sidecar" || s.kind === "main"
        ? (s.kind as "init" | "main" | "sidecar")
        : "main",
  }));
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      <StatusPill status={phase} t={t} mode={mode} />
      {containers.length > 0 && (
        <ContainerDots containers={containers} t={t} size={9} />
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function readyCount(d: PodDetail): string {
  const total = d.containers.filter((c) => c.kind !== "init").length;
  const ready = d.containers.filter((c) => c.kind !== "init" && c.ready).length;
  return `${ready}/${total}`;
}

function totalRestarts(d: PodDetail): number {
  return d.containers.reduce((acc, c) => acc + (c.restart_count || 0), 0);
}

function parseTs(v: unknown): number {
  if (typeof v !== "string") return 0;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

function formatAge(value: unknown, nowMs: number): string {
  if (typeof value !== "string") return "—";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return "—";
  let s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function timeAgo(then: number): string {
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

// Routes the structured Summary tab to the right per-kind component for
// every workload kind except Pod (Pod stays inline above because it has
// extra coupling to the row payload + log button).
function WorkloadSummaryDispatch({
  mode,
  clusterId,
  kindId,
  namespace,
  name,
  uid,
  detailVersion,
  onNavigate,
}: {
  mode: ThemeMode;
  clusterId: string;
  kindId: string;
  namespace: string | null;
  name: string;
  // Carried through so synthetic kinds (helm_charts) can recover the
  // chart version embedded in their composite uid. Other summaries
  // ignore it.
  uid: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const props = {
    mode,
    clusterId,
    namespace,
    name,
    detailVersion,
    onNavigate,
  };
  // Well-known dynamic CRDs (Gateway API, …) carry a `wkcrd:<short>|…` id.
  // Dispatch off the short prefix so version drift in the rest doesn't
  // affect the UI.
  const wkShort = wellKnownShort(kindId);
  if (wkShort) {
    switch (wkShort) {
      case "gatewayclasses":
        return (
          <GatewayClassSummary
            mode={mode}
            clusterId={clusterId}
            kindId={kindId}
            name={name}
            detailVersion={detailVersion}
            onNavigate={onNavigate}
          />
        );
      case "gateways":
        return (
          <GatewaySummary
            mode={mode}
            clusterId={clusterId}
            kindId={kindId}
            namespace={namespace}
            name={name}
            detailVersion={detailVersion}
            onNavigate={onNavigate}
          />
        );
      case "httproutes":
        return (
          <RouteSummary
            mode={mode}
            clusterId={clusterId}
            kindId={kindId}
            namespace={namespace}
            name={name}
            detailVersion={detailVersion}
            onNavigate={onNavigate}
            label="HTTPRoute"
          />
        );
      case "grpcroutes":
        return (
          <RouteSummary
            mode={mode}
            clusterId={clusterId}
            kindId={kindId}
            namespace={namespace}
            name={name}
            detailVersion={detailVersion}
            onNavigate={onNavigate}
            label="GRPCRoute"
          />
        );
      case "referencegrants":
        return (
          <ReferenceGrantSummary
            mode={mode}
            clusterId={clusterId}
            kindId={kindId}
            namespace={namespace}
            name={name}
            detailVersion={detailVersion}
            onNavigate={onNavigate}
          />
        );
      default:
        return null;
    }
  }
  switch (kindId) {
    case "deployments":
      return <DeploymentSummary {...props} />;
    case "replicasets":
      return <ReplicaSetSummary {...props} />;
    case "statefulsets":
      return <StatefulSetSummary {...props} />;
    case "daemonsets":
      return <DaemonSetSummary {...props} />;
    case "jobs":
      return <JobSummary {...props} />;
    case "cronjobs":
      return <CronJobSummary {...props} />;
    case "nodes":
      return (
        <NodeSummary
          mode={mode}
          clusterId={clusterId}
          name={name}
          detailVersion={detailVersion}
          onNavigate={onNavigate}
        />
      );
    case "namespaces":
      return (
        <NamespaceSummary
          mode={mode}
          clusterId={clusterId}
          name={name}
          detailVersion={detailVersion}
          onNavigate={onNavigate}
        />
      );
    case "events":
      return <EventSummary {...props} />;
    case "services":
      return <ServiceSummary {...props} />;
    case "endpoints":
      return <EndpointsSummary {...props} />;
    case "endpointslices":
      return <EndpointSliceSummary {...props} />;
    case "ingresses":
      return <IngressSummary {...props} />;
    case "ingressclasses":
      return (
        <IngressClassSummary
          mode={mode}
          clusterId={clusterId}
          name={name}
          detailVersion={detailVersion}
          onNavigate={onNavigate}
        />
      );
    case "networkpolicies":
      return <NetworkPolicySummary {...props} />;
    case "configmaps":
      return <ConfigMapSummary {...props} />;
    case "secrets":
      return <SecretSummary {...props} />;
    case "resourcequotas":
      return <ResourceQuotaSummary {...props} />;
    case "limitranges":
      return <LimitRangeSummary {...props} />;
    case "persistentvolumeclaims":
      return <PersistentVolumeClaimSummary {...props} />;
    case "persistentvolumes":
      return (
        <PersistentVolumeSummary
          mode={mode}
          clusterId={clusterId}
          name={name}
          detailVersion={detailVersion}
          onNavigate={onNavigate}
        />
      );
    case "storageclasses":
      return (
        <StorageClassSummary
          mode={mode}
          clusterId={clusterId}
          name={name}
          detailVersion={detailVersion}
          onNavigate={onNavigate}
        />
      );
    case "serviceaccounts":
      return <ServiceAccountSummary {...props} />;
    case "roles":
      return <RoleSummary {...props} />;
    case "rolebindings":
      return <RoleBindingSummary {...props} />;
    case "clusterroles":
      return (
        <ClusterRoleSummary
          mode={mode}
          clusterId={clusterId}
          name={name}
          detailVersion={detailVersion}
          onNavigate={onNavigate}
        />
      );
    case "clusterrolebindings":
      return (
        <ClusterRoleBindingSummary
          mode={mode}
          clusterId={clusterId}
          name={name}
          detailVersion={detailVersion}
          onNavigate={onNavigate}
        />
      );
    case "customresourcedefinitions":
      return (
        <CustomResourceDefinitionSummary
          mode={mode}
          clusterId={clusterId}
          name={name}
          detailVersion={detailVersion}
          onNavigate={onNavigate}
        />
      );
    case "horizontalpodautoscalers":
      return <HorizontalPodAutoscalerSummary {...props} />;
    case "poddisruptionbudgets":
      return <PodDisruptionBudgetSummary {...props} />;
    case "priorityclasses":
      return (
        <PriorityClassSummary
          mode={mode}
          clusterId={clusterId}
          name={name}
          detailVersion={detailVersion}
          onNavigate={onNavigate}
        />
      );
    case "replicationcontrollers":
      return <ReplicationControllerSummary {...props} />;
    case "leases":
      return <LeaseSummary {...props} />;
    case "mutatingwebhookconfigurations":
      return (
        <MutatingWebhookConfigurationSummary
          mode={mode}
          clusterId={clusterId}
          name={name}
          detailVersion={detailVersion}
          onNavigate={onNavigate}
        />
      );
    case "validatingwebhookconfigurations":
      return (
        <ValidatingWebhookConfigurationSummary
          mode={mode}
          clusterId={clusterId}
          name={name}
          detailVersion={detailVersion}
          onNavigate={onNavigate}
        />
      );
    case "helm_releases":
      return <HelmReleaseSummary {...props} />;
    case "helm_charts":
      return (
        <HelmChartSummary
          mode={mode}
          clusterId={clusterId}
          uid={uid}
          name={name}
          detailVersion={detailVersion}
          onNavigate={onNavigate}
        />
      );
    default:
      // Catch-all for CRD-backed kinds that don't have a hand-written
      // summary — the schema-driven generic renderer.
      if (kindId.startsWith("crd:")) {
        return (
          <CustomResourceSummary
            mode={mode}
            clusterId={clusterId}
            kindId={kindId}
            namespace={namespace}
            name={name}
            detailVersion={detailVersion}
            onNavigate={onNavigate}
          />
        );
      }
      return null;
  }
}

// Build the menu items for a given title-bar action button. Each picker is
// shaped the same way (header → choices) so the user learns the pattern once.
function buildActionMenuItems(
  menuKind: "shell" | "delete",
  kindLabel: string,
  kindId: string,
  name: string,
  containers: string[],
  onOpenExec: ((container?: string | null) => void) | undefined,
  runDelete: (force: boolean) => void,
): MenuItem[] {
  if (menuKind === "shell") {
    if (!onOpenExec || containers.length === 0) {
      return [{ kind: "item", label: "No containers", onClick: () => {}, disabled: true }];
    }
    return containers.map((c) => ({
      kind: "item" as const,
      label: c,
      onClick: () => onOpenExec(c),
    }));
  }
  // delete — for helm releases, the verb is `helm uninstall`; force has
  // no meaning there (helm has its own teardown semantics).
  if (kindId === "helm_releases") {
    return [
      {
        kind: "item",
        label: `Uninstall release ${name}`,
        onClick: () => runDelete(false),
        danger: true,
      },
    ];
  }
  return [
    {
      kind: "item",
      label: `Delete ${kindLabel.toLowerCase()} ${name}`,
      onClick: () => runDelete(false),
      danger: true,
    },
    {
      kind: "item",
      label: `Force delete (no grace period)`,
      onClick: () => runDelete(true),
      danger: true,
    },
  ];
}
