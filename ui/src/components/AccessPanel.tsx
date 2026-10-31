import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAppStore, useResolvedTheme } from "../store";
import { FF_MONO, FS_SM, FS_XS, R_SM, FW_MEDIUM } from "../theme";
import type { AccessAction, AccessIdentity, AccessRulesReview } from "../types";
import { invalidateAccess, useAccessChecks, type Gate } from "../lib/access";
import { Btn, Chip, Dialog, ErrorBlock, LoadingLine, Section } from "./ui";
import { Copyable } from "./detail/primitives";

const VERBS: AccessAction[] = ["list", "get", "create", "patch", "delete"];

const NAMESPACED_KINDS: [string, string][] = [
  ["pods", "Pods"],
  ["deployments", "Deployments"],
  ["statefulsets", "StatefulSets"],
  ["daemonsets", "DaemonSets"],
  ["jobs", "Jobs"],
  ["cronjobs", "CronJobs"],
  ["services", "Services"],
  ["ingresses", "Ingresses"],
  ["configmaps", "ConfigMaps"],
  ["secrets", "Secrets"],
  ["persistentvolumeclaims", "PVCs"],
  ["events", "Events"],
  ["serviceaccounts", "ServiceAccounts"],
  ["roles", "Roles"],
  ["rolebindings", "RoleBindings"],
];

const CLUSTER_KINDS: [string, string][] = [
  ["namespaces", "Namespaces"],
  ["nodes", "Nodes"],
  ["persistentvolumes", "PersistentVolumes"],
  ["clusterroles", "ClusterRoles"],
  ["customresourcedefinitions", "CRDs"],
];

const POD_VERBS: [AccessAction, string][] = [
  ["logs", "Logs"],
  ["exec", "Exec"],
  ["portForward", "Port-forward"],
  ["evict", "Evict"],
];

/// "Who am I, and what may I do here" — `kubectl auth whoami` plus a can-i
/// matrix (authoritative SelfSubjectAccessReviews) and the RBAC rules the
/// apiserver can enumerate for a namespace.
export function AccessPanel({ clusterId, onClose }: { clusterId: string; onClose: () => void }) {
  const t = useResolvedTheme().tokens;
  const context = useAppStore((s) => s.contexts.find((c) => c.id === clusterId) ?? null);
  const selected = useAppStore((s) => s.selectedNamespaces);
  const [namespace, setNamespace] = useState(
    () => Array.from(selected)[0] ?? context?.namespace ?? "default",
  );
  const [draftNs, setDraftNs] = useState(namespace);
  const [epoch, setEpoch] = useState(0);
  const [identity, setIdentity] = useState<AccessIdentity | string | null>(null);
  const [rules, setRules] = useState<AccessRulesReview | string | null>(null);

  useEffect(() => {
    let live = true;
    setIdentity(null);
    api
      .accessWhoami(clusterId)
      .then((i) => live && setIdentity(i))
      .catch((e: unknown) => live && setIdentity(String(e)));
    return () => {
      live = false;
    };
  }, [clusterId, epoch]);

  useEffect(() => {
    let live = true;
    setRules(null);
    api
      .accessRules(clusterId, namespace)
      .then((r) => live && setRules(r))
      .catch((e: unknown) => live && setRules(String(e)));
    return () => {
      live = false;
    };
  }, [clusterId, namespace, epoch]);

  const refresh = () => {
    invalidateAccess(clusterId);
    setEpoch((n) => n + 1);
  };

  return (
    <Dialog
      t={t}
      title="My permissions"
      subtitle={context?.name ?? clusterId}
      width={720}
      onClose={onClose}
      footer={
        <>
          <Btn t={t} variant="ghost" onClick={refresh} title="Re-check after your grants changed">
            Refresh
          </Btn>
          <Btn t={t} variant="primary" onClick={onClose}>
            Close
          </Btn>
        </>
      }
    >
      <Section t={t} title="Identity" />
      {identity == null ? (
        <LoadingLine t={t} inline label="Asking the apiserver who you are…" />
      ) : typeof identity === "string" ? (
        <div style={{ color: t.textMuted, fontSize: FS_SM }}>
          Identity unavailable
          {/\b404\b|not found/i.test(identity) ? " (needs Kubernetes 1.28+)" : ""}: {identity}
        </div>
      ) : (
        <IdentityBlock identity={identity} />
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "14px 0 6px" }}>
        <Section t={t} title="Can I…" style={{ flex: 1 }} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const ns = draftNs.trim();
            if (ns) setNamespace(ns);
          }}
          style={{ display: "flex", gap: 6, alignItems: "center" }}
        >
          <label style={{ fontSize: FS_XS, color: t.textMuted }} htmlFor="access-ns">
            Namespace
          </label>
          <input
            id="access-ns"
            value={draftNs}
            onChange={(e) => setDraftNs(e.target.value)}
            onBlur={() => draftNs.trim() && setNamespace(draftNs.trim())}
            spellCheck={false}
            style={{
              width: 160,
              padding: "3px 6px",
              fontFamily: FF_MONO,
              fontSize: FS_SM,
              color: t.text,
              background: t.surfaceAlt,
              border: `1px solid ${t.border}`,
              borderRadius: R_SM,
            }}
          />
        </form>
      </div>
      <Matrix clusterId={clusterId} namespace={namespace} />

      <Section t={t} title={`RBAC rules in ${namespace}`} style={{ marginTop: 14 }} />
      {rules == null ? (
        <LoadingLine t={t} inline label="Loading rules…" />
      ) : typeof rules === "string" ? (
        <ErrorBlock t={t} message={rules} />
      ) : (
        <RulesTable rules={rules} />
      )}
    </Dialog>
  );
}

function IdentityBlock({ identity }: { identity: AccessIdentity }) {
  const t = useResolvedTheme().tokens;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "90px 1fr", gap: "4px 10px", fontSize: FS_SM }}>
      <span style={{ color: t.textMuted }}>User</span>
      <Copyable text={identity.username ?? ""}>
        <span style={{ fontFamily: FF_MONO }}>{identity.username ?? "—"}</span>
      </Copyable>
      <span style={{ color: t.textMuted }}>Groups</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {identity.groups.length === 0
          ? "—"
          : identity.groups.map((g) => (
              <Copyable key={g} text={g}>
                <Chip t={t} mono>
                  {g}
                </Chip>
              </Copyable>
            ))}
      </div>
    </div>
  );
}

function Matrix({ clusterId, namespace }: { clusterId: string; namespace: string }) {
  const t = useResolvedTheme().tokens;
  const rows = useMemo(
    () => [
      ...NAMESPACED_KINDS.map(([kindId, label]) => ({ kindId, label, ns: namespace })),
      ...CLUSTER_KINDS.map(([kindId, label]) => ({ kindId, label, ns: null })),
    ],
    [namespace],
  );
  const checks = useMemo(
    () => [
      ...rows.flatMap((r) =>
        VERBS.map((action) => ({ clusterId, kindId: r.kindId, action, namespace: r.ns })),
      ),
      ...POD_VERBS.map(([action]) => ({ clusterId, kindId: "pods", action, namespace })),
    ],
    [rows, clusterId, namespace],
  );
  const gates = useAccessChecks(checks);
  const podGates = gates.slice(rows.length * VERBS.length);
  // A check that couldn't answer is "?", never a green tick.
  const cellMark = (g: Gate | undefined) =>
    !g || g.pending ? "…" : g.error ? "?" : g.allowed ? "✓" : "✕";
  const cellTitle = (g: Gate | undefined) =>
    !g || g.pending
      ? "Checking…"
      : g.error
        ? `Couldn't check: ${g.error}`
        : (g.reason ?? "Allowed");
  const cellColor = (g: Gate | undefined) =>
    !g || g.pending || g.error ? t.textMuted : g.allowed ? t.good : t.bad;

  const cell = (g: Gate | undefined, key: string) => (
    <td
      key={key}
      title={cellTitle(g)}
      style={{ textAlign: "center", color: cellColor(g), fontFamily: FF_MONO }}
    >
      {cellMark(g)}
    </td>
  );

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: FS_SM }}>
      <thead>
        <tr style={{ color: t.textMuted, fontSize: FS_XS }}>
          <th style={{ textAlign: "left", fontWeight: FW_MEDIUM }}>Resource</th>
          {VERBS.map((v) => (
            <th key={v} style={{ fontWeight: FW_MEDIUM }}>
              {v}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.kindId} style={{ borderTop: `1px solid ${t.borderSoft}` }}>
            <td style={{ padding: "3px 0" }}>
              {r.label}
              {r.ns == null && <span style={{ color: t.textMuted }}> · cluster</span>}
            </td>
            {VERBS.map((v, j) => cell(gates[i * VERBS.length + j], v))}
          </tr>
        ))}
        <tr style={{ borderTop: `1px solid ${t.borderSoft}` }}>
          <td style={{ padding: "3px 0" }} colSpan={VERBS.length + 1}>
            <span style={{ color: t.textMuted, marginRight: 8 }}>Pods:</span>
            {POD_VERBS.map(([action, label], i) => {
              const g = podGates[i];
              return (
                <span
                  key={action}
                  title={cellTitle(g)}
                  style={{ marginRight: 12, color: cellColor(g) }}
                >
                  {cellMark(g)} {label}
                </span>
              );
            })}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function RulesTable({ rules }: { rules: AccessRulesReview }) {
  const t = useResolvedTheme().tokens;
  const list = (xs: string[], empty: string) => (xs.length === 0 ? empty : xs.join(", "));
  return (
    <>
      {rules.incomplete && (
        <div style={{ color: t.warn, fontSize: FS_SM, marginBottom: 6 }}>
          Incomplete: a webhook authorizer (cloud IAM) grants access the apiserver can't
          list. The matrix above is authoritative; this list may be missing entries.
        </div>
      )}
      {rules.evaluationError && (
        <div style={{ color: t.textMuted, fontSize: FS_XS, marginBottom: 6 }}>
          {rules.evaluationError}
        </div>
      )}
      <div style={{ maxHeight: 220, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: FS_XS, fontFamily: FF_MONO }}>
          <thead>
            <tr style={{ color: t.textMuted, textAlign: "left" }}>
              <th style={{ fontWeight: FW_MEDIUM }}>Verbs</th>
              <th style={{ fontWeight: FW_MEDIUM }}>API groups</th>
              <th style={{ fontWeight: FW_MEDIUM }}>Resources</th>
              <th style={{ fontWeight: FW_MEDIUM }}>Names</th>
            </tr>
          </thead>
          <tbody>
            {rules.rules.map((r, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${t.borderSoft}`, verticalAlign: "top" }}>
                <td>{list(r.verbs, "—")}</td>
                <td>{list(r.apiGroups.map((g) => g || "core"), "—")}</td>
                <td>{list(r.resources, "—")}</td>
                <td>{list(r.resourceNames, "any")}</td>
              </tr>
            ))}
            {rules.nonResourceRules.map((r, i) => (
              <tr key={`nr-${i}`} style={{ borderTop: `1px solid ${t.borderSoft}`, verticalAlign: "top" }}>
                <td>{list(r.verbs, "—")}</td>
                <td colSpan={3}>{list(r.urls, "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
