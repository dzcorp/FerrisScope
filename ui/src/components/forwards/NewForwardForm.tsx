// Manual "new forward" form for the Port-forwards panel. Two modes:
//  - Localhost (simple): bind a chosen kind/namespace/name port to
//    127.0.0.1:<port> via the existing `pf_start` (no privilege).
//  - Global (DNS): forward a single service, a whole namespace, all namespaces,
//    and/or a label selector via the privileged helper. The label selector
//    reuses the same key→value editor as ConfigMap/labels editing.
//
// Namespace and Service are populated live from the selected cluster (one-shot
// `list_namespaces` / `list_services_in_namespace`), so the operator picks from
// a dropdown instead of typing exact strings. Every dynamic field degrades to a
// plain text input — automatically when the list can't load (RBAC / a
// disconnected cluster), or on demand via a "type manually" toggle — so a user
// is never blocked from forwarding a value the list doesn't show.
//
// Composes existing atoms only — Select / TextInput / KvEditor / DetailRow /
// Btn — so it matches the rest of the app's chrome.

import { useEffect, useState } from "react";
import { api } from "../../api";
import { useAppStore } from "../../store";
import type { Tokens } from "../../theme";
import { FS_SM, FS_XS } from "../../theme";
import type { ServicePick } from "../../types";
import { Select, TextInput } from "../ui/atoms";
import { Btn } from "../ui/Btn";
import { DetailRow } from "../detail/primitives";
import {
  KvEditor,
  kvBufferFromPairs,
  kvBufferToMap,
  type KvBuffer,
} from "../detail/edit";

type Mode = "simple" | "global";

const KINDS = [
  "Pod",
  "Service",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "Job",
];

/** Join a key→value buffer into a Kubernetes label selector (`k=v,k2`). */
export function kvBufferToSelector(buffer: KvBuffer): string {
  return Object.entries(kvBufferToMap(buffer))
    .map(([k, v]) => (v ? `${k}=${v}` : k))
    .join(",");
}

function portValid(s: string): boolean {
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** Small caption (loading / hint) under a field. */
function Hint({ t, children }: { t: Tokens; children: React.ReactNode }) {
  return (
    <div style={{ color: t.textMuted, fontSize: FS_XS, marginTop: 4 }}>{children}</div>
  );
}

/**
 * Text link toggling a field between its live dropdown and free-text entry.
 * Renders nothing when there are no options to pick from (the field is already
 * a plain input, so there's nothing to toggle to).
 */
function ManualToggle({
  t,
  manual,
  hasOptions,
  onChange,
}: {
  t: Tokens;
  manual: boolean;
  hasOptions: boolean;
  onChange: (manual: boolean) => void;
}) {
  if (!hasOptions) return null;
  return (
    <button
      type="button"
      onClick={() => onChange(!manual)}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        marginTop: 4,
        color: t.accent,
        fontSize: FS_XS,
        cursor: "pointer",
      }}
    >
      {manual ? "Pick from list" : "Type manually"}
    </button>
  );
}

export function NewForwardForm({ t, onDone }: { t: Tokens; onDone: () => void }) {
  const contexts = useAppStore((s) => s.contexts);
  const selectedContext = useAppStore((s) => s.selectedContext);
  const upsertForward = useAppStore((s) => s.upsertForward);
  const upsertGlobalForward = useAppStore((s) => s.upsertGlobalForward);
  const openForwardsPanel = useAppStore((s) => s.openForwardsPanel);

  const [mode, setMode] = useState<Mode>("simple");
  const [clusterId, setClusterId] = useState<string>(
    selectedContext ?? contexts[0]?.id ?? "",
  );
  const [kind, setKind] = useState<string>("Service");
  const [namespace, setNamespace] = useState("");
  const [name, setName] = useState("");
  const [remotePort, setRemotePort] = useState("");
  const [localPort, setLocalPort] = useState("");
  const [selector, setSelector] = useState<KvBuffer>(() => kvBufferFromPairs([]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live pickers. `null` = not loaded yet; `[]` = loaded-but-empty or the list
  // call failed (→ fall back to a text input). The `*Manual` flags let the user
  // force free-text even when options exist.
  const [namespaces, setNamespaces] = useState<string[] | null>(null);
  const [nsLoading, setNsLoading] = useState(false);
  const [nsManual, setNsManual] = useState(false);
  const [services, setServices] = useState<ServicePick[] | null>(null);
  const [svcLoading, setSvcLoading] = useState(false);
  const [nameManual, setNameManual] = useState(false);
  const [portManual, setPortManual] = useState(false);

  // Namespaces for the selected cluster (one-shot, refreshed on cluster change).
  useEffect(() => {
    if (!clusterId) {
      setNamespaces(null);
      return;
    }
    let cancelled = false;
    setNsLoading(true);
    setNamespaces(null);
    api
      .listNamespaces(clusterId)
      .then((ns) => {
        if (!cancelled) setNamespaces(ns);
      })
      .catch((e) => {
        if (!cancelled) {
          setNamespaces([]);
          console.warn("list namespaces failed", e);
        }
      })
      .finally(() => {
        if (!cancelled) setNsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clusterId]);

  // Services for the chosen (cluster, namespace). Skipped for all-namespaces
  // (blank), where a single service has no unambiguous home.
  useEffect(() => {
    const ns = namespace.trim();
    if (!clusterId || !ns) {
      setServices(null);
      return;
    }
    let cancelled = false;
    setSvcLoading(true);
    setServices(null);
    api
      .listServicesInNamespace(clusterId, ns)
      .then((s) => {
        if (!cancelled) setServices(s);
      })
      .catch((e) => {
        if (!cancelled) {
          setServices([]);
          console.warn("list services failed", e);
        }
      })
      .finally(() => {
        if (!cancelled) setSvcLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clusterId, namespace]);

  const reset = () => {
    setName("");
    setRemotePort("");
    setLocalPort("");
    setSelector(kvBufferFromPairs([]));
    setNameManual(false);
    setPortManual(false);
    setError(null);
  };

  // Switching mode/kind/namespace can invalidate the chosen name + port.
  const onModeChange = (m: Mode) => {
    setMode(m);
    setName("");
    setRemotePort("");
    setNameManual(false);
    setPortManual(false);
  };
  const onKindChange = (k: string) => {
    setKind(k);
    setName("");
    setRemotePort("");
    setNameManual(false);
    setPortManual(false);
  };
  const onNamespaceChange = (ns: string) => {
    setNamespace(ns);
    setName("");
    setRemotePort("");
    setNameManual(false);
    setPortManual(false);
  };
  const onServiceChange = (svc: string) => {
    setName(svc);
    // Auto-fill the remote port when a picked service exposes exactly one.
    const picked = services?.find((s) => s.name === svc);
    const onlyPort =
      picked && picked.ports.length === 1 ? picked.ports[0] : undefined;
    if (mode === "simple" && onlyPort) {
      setRemotePort(String(onlyPort.port));
    } else {
      setRemotePort("");
    }
    setPortManual(false);
  };

  const submit = async () => {
    setError(null);
    if (!clusterId) {
      setError("Pick a cluster.");
      return;
    }
    if (mode === "simple") {
      if (!name.trim()) return setError("Name is required.");
      if (!namespace.trim()) return setError("Namespace is required.");
      if (!portValid(remotePort)) return setError("Remote port must be 1–65535.");
      if (localPort.trim() && !portValid(localPort))
        return setError("Local port must be 1–65535.");
      setBusy(true);
      try {
        const entry = await api.pfStart(
          clusterId,
          { kind, namespace: namespace.trim(), name: name.trim() },
          Number(remotePort),
          localPort.trim() ? Number(localPort) : null,
          false,
        );
        upsertForward(entry);
        reset();
        onDone();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
      return;
    }
    // Global (DNS)
    setBusy(true);
    try {
      let session;
      if (name.trim()) {
        if (!namespace.trim()) {
          setError("Namespace is required for a single service.");
          setBusy(false);
          return;
        }
        session = await api.gfEnableService(clusterId, namespace.trim(), name.trim());
      } else {
        const sel = kvBufferToSelector(selector);
        session = await api.gfEnableQuery(
          clusterId,
          namespace.trim() || null,
          sel || null,
        );
      }
      upsertGlobalForward(session);
      openForwardsPanel();
      reset();
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const clusterOptions = contexts.map((c) => ({ value: c.id, label: c.name }));

  // --- Dynamic-field derivations ---
  const wantsServicePicker =
    mode === "global" || (mode === "simple" && kind === "Service");
  const nsHasOptions = !!namespaces && namespaces.length > 0;
  const useNsSelect = nsHasOptions && !nsManual;
  const svcHasOptions =
    wantsServicePicker && !!services && services.length > 0 && !!namespace.trim();
  const useSvcSelect = svcHasOptions && !nameManual;
  const selectedSvc = services?.find((s) => s.name === name) ?? null;
  const portHasOptions =
    mode === "simple" &&
    kind === "Service" &&
    !!selectedSvc &&
    selectedSvc.ports.length > 0;
  const usePortSelect = portHasOptions && !portManual;

  // Each picker prepends a `value: ""` sentinel — it doubles as the placeholder
  // (Select renders the option whose value matches, and "" is the empty state)
  // and, in Global mode, as the meaningful "all namespaces / no service" choice.
  const nsOptions = [
    {
      value: "",
      label: mode === "global" ? "All namespaces" : "Select namespace…",
    },
    ...(namespaces ?? []).map((n) => ({ value: n, label: n })),
  ];
  const svcOptions = [
    {
      value: "",
      label: mode === "global" ? "(no service — use selector)" : "Select service…",
    },
    ...(services ?? []).map((s) => ({ value: s.name, label: s.name })),
  ];
  const portOptions = [
    { value: "", label: "Select port…" },
    ...(selectedSvc?.ports ?? []).map((p) => ({
      value: String(p.port),
      label: `${p.port}${p.name ? ` (${p.name})` : ""}/${p.protocol}`,
    })),
  ];

  return (
    <div
      data-testid="new-forward-form"
      style={{
        padding: "12px 18px",
        borderBottom: `1px solid ${t.borderSoft}`,
        background: t.surfaceAlt,
      }}
    >
      <DetailRow t={t} label="Mode">
        <Select<Mode>
          t={t}
          value={mode}
          onChange={onModeChange}
          options={[
            { value: "simple", label: "Localhost (simple)" },
            { value: "global", label: "Global (DNS)" },
          ]}
        />
      </DetailRow>

      <DetailRow t={t} label="Cluster">
        <Select<string>
          t={t}
          value={clusterId}
          onChange={setClusterId}
          options={clusterOptions}
          searchable
        />
      </DetailRow>

      {mode === "simple" && (
        <DetailRow t={t} label="Kind">
          <Select<string>
            t={t}
            value={kind}
            onChange={onKindChange}
            options={KINDS.map((k) => ({ value: k, label: k }))}
          />
        </DetailRow>
      )}

      <DetailRow
        t={t}
        label={mode === "global" ? "Namespace (blank = all)" : "Namespace"}
      >
        <div style={{ width: "100%" }}>
          {useNsSelect ? (
            <Select<string>
              t={t}
              value={namespace}
              onChange={onNamespaceChange}
              options={nsOptions}
              searchable
            />
          ) : (
            <TextInput
              t={t}
              value={namespace}
              onChange={onNamespaceChange}
              placeholder={mode === "global" ? "all namespaces" : "default"}
              mono
              fullWidth
            />
          )}
          {nsLoading && <Hint t={t}>loading namespaces…</Hint>}
          <ManualToggle
            t={t}
            manual={nsManual}
            hasOptions={nsHasOptions}
            onChange={setNsManual}
          />
        </div>
      </DetailRow>

      <DetailRow t={t} label={mode === "global" ? "Service (optional)" : "Name"}>
        <div style={{ width: "100%" }}>
          {useSvcSelect ? (
            <Select<string>
              t={t}
              value={name}
              onChange={onServiceChange}
              options={svcOptions}
              searchable
            />
          ) : (
            <TextInput
              t={t}
              value={name}
              onChange={setName}
              placeholder={
                mode === "global" ? "(or use a selector below)" : "my-service"
              }
              mono
              fullWidth
            />
          )}
          {wantsServicePicker && svcLoading && <Hint t={t}>loading services…</Hint>}
          {wantsServicePicker && (
            <ManualToggle
              t={t}
              manual={nameManual}
              hasOptions={svcHasOptions}
              onChange={setNameManual}
            />
          )}
        </div>
      </DetailRow>

      {mode === "simple" && (
        <>
          <DetailRow t={t} label="Remote port">
            <div style={{ width: "100%" }}>
              {usePortSelect ? (
                <Select<string>
                  t={t}
                  value={remotePort}
                  onChange={setRemotePort}
                  options={portOptions}
                  fullWidth={false}
                />
              ) : (
                <TextInput
                  t={t}
                  value={remotePort}
                  onChange={setRemotePort}
                  placeholder="80"
                  mono
                />
              )}
              <ManualToggle
                t={t}
                manual={portManual}
                hasOptions={portHasOptions}
                onChange={setPortManual}
              />
            </div>
          </DetailRow>
          <DetailRow t={t} label="Local port (opt)">
            <TextInput
              t={t}
              value={localPort}
              onChange={setLocalPort}
              placeholder="auto"
              mono
            />
          </DetailRow>
        </>
      )}

      {mode === "global" && (
        <DetailRow t={t} label="Label selector">
          <div style={{ width: "100%" }}>
            <KvEditor
              t={t}
              buffer={selector}
              onChange={setSelector}
              keyPlaceholder="app"
              valuePlaceholder="value (blank = exists)"
              addLabel="Add selector term"
            />
          </div>
        </DetailRow>
      )}

      {error && (
        <div style={{ color: t.bad, fontSize: FS_XS, margin: "6px 0 2px" }}>{error}</div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 10, fontSize: FS_SM }}>
        <Btn t={t} variant="primary" size="sm" disabled={busy} onClick={submit}>
          {busy ? "Forwarding…" : "Forward"}
        </Btn>
        <Btn t={t} variant="ghost" size="sm" disabled={busy} onClick={onDone}>
          Cancel
        </Btn>
      </div>
    </div>
  );
}
