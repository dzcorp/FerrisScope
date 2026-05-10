// Helm chart catalog detail. Reads from `get_helm_chart_detail_cmd`,
// which walks every helm release secret in the cluster, finds one whose
// chart matches `(chart_name, chart_version)`, and projects the chart
// metadata + default values + the list of releases using this chart.
//
// Install path: chart files are extracted from one of the existing
// release secrets (we already do this for helm upgrade), so the install
// works without any helm-repo configuration. The chart catalog is "what's
// already deployed somewhere in this cluster" — a repo-side browser is a
// separate, future feature.
//
// `(chart_name, chart_version)` come out of the row's synthetic uid
// (`helm:chart:<name>:<version>`). DetailPanel threads `uid` through the
// dispatch so we can recover both halves here.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Editor from "@monaco-editor/react";
import { api } from "../../../api";
import { FONT_MONO, type ThemeMode, type Tokens } from "../../../theme";
import { tokens } from "../../../theme";
import { ErrorBlock, LoadingLine, Section, StatusPill } from "../../ui";
import {
  ChipWrap,
  Copyable,
  DetailRow,
  LinkValue,
  Mute,
  ageFromIso,
  type DetailNavigate,
} from "..";
import { installClipboardShortcuts } from "../../../lib/monacoClipboard";
import type { HelmChartDetail, HelmChartUsedBy } from "../../../types";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; detail: HelmChartDetail }
  | { kind: "error"; message: string };

function useDetail(
  fetcher: () => Promise<HelmChartDetail>,
  deps: ReadonlyArray<unknown>,
): LoadState {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const reqId = useRef(0);
  useEffect(() => {
    const id = ++reqId.current;
    fetcher()
      .then((detail) => {
        if (reqId.current === id) setState({ kind: "ready", detail });
      })
      .catch((e: unknown) => {
        if (reqId.current === id)
          setState({ kind: "error", message: String(e) });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function Frame({ t, children }: { t: Tokens; children: ReactNode }) {
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
      {children}
    </div>
  );
}

// Synthetic uid format from helm_charts::synthetic_uid:
//   `helm:chart:<source>:<chart_name>:<chart_version>`
// We split on the first two `:` after the prefix (source, name); the
// remainder is the version (which may contain dashes / dots / pre-release
// markers but no colons in practice).
function parseChartUid(
  uid: string,
): { source: string; name: string; version: string } | null {
  if (!uid.startsWith("helm:chart:")) return null;
  const rest = uid.slice("helm:chart:".length);
  const sourceEnd = rest.indexOf(":");
  if (sourceEnd === -1) return null;
  const source = rest.slice(0, sourceEnd);
  const after = rest.slice(sourceEnd + 1);
  const nameEnd = after.indexOf(":");
  if (nameEnd === -1) return null;
  const name = after.slice(0, nameEnd);
  const version = after.slice(nameEnd + 1);
  if (!source || !name || !version) return null;
  return { source, name, version };
}

type InstallStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | {
      kind: "success";
      revision: number;
      namespace: string;
      release_name: string;
      status: string | null;
      elapsed_ms: number;
    }
  | { kind: "error"; message: string; helm_stderr?: string };

export function HelmChartSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  uid: string;
  // `name` is the chart name (the row's `name` column); kept for API
  // consistency with the other summaries even though we recover both
  // name + version from the uid.
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const parsed = useMemo(() => parseChartUid(props.uid), [props.uid]);

  // Hooks must run unconditionally — ALL state hooks above the early
  // returns so the hook order stays stable across loading / error / ready.
  const [refetch, setRefetch] = useState(0);
  const state = useDetail(
    () =>
      api.getHelmChartDetail(
        props.clusterId,
        parsed?.source ?? "cluster",
        parsed?.name ?? props.name,
        parsed?.version ?? "",
      ),
    [
      props.clusterId,
      parsed?.source,
      props.name,
      parsed?.version,
      props.detailVersion,
      refetch,
    ],
  );

  // Install form state. Lives at the summary level so refetch (after a
  // successful install) doesn't reset the operator's draft if they then
  // tweak values for a second install.
  const [namespace, setNamespace] = useState("default");
  const [releaseName, setReleaseName] = useState("");
  const [valuesBuffer, setValuesBuffer] = useState("");
  const [seededValues, setSeededValues] = useState<string | null>(null);
  const [installStatus, setInstallStatus] = useState<InstallStatus>({
    kind: "idle",
  });

  // Seed defaults from the loaded chart on first ready (or when the
  // chart changes). Re-seed values only when the operator hasn't typed
  // anything custom — match by string equality with the prior seed.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const d = state.detail;
    if (!releaseName) setReleaseName(suggestReleaseName(d.chart_name));
    if (seededValues == null || valuesBuffer === seededValues) {
      setValuesBuffer(d.default_values_yaml);
      setSeededValues(d.default_values_yaml);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!parsed) {
    return (
      <ErrorBlock t={t} message={`Cannot parse chart uid: ${props.uid}`} />
    );
  }
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading chart…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="helm chart" />;

  const d = state.detail;
  const canInstall =
    d.helm_available &&
    namespace.trim().length > 0 &&
    releaseName.trim().length > 0 &&
    installStatus.kind !== "saving";

  const onInstall = async () => {
    setInstallStatus({ kind: "saving" });
    try {
      const result = await api.installHelmChart(
        props.clusterId,
        d.source,
        namespace.trim(),
        releaseName.trim(),
        d.chart_name,
        d.chart_version,
        valuesBuffer,
      );
      if (result.kind === "installed") {
        setInstallStatus({
          kind: "success",
          revision: result.revision,
          namespace: result.namespace,
          release_name: result.release_name,
          status: result.status,
          elapsed_ms: result.elapsed_ms,
        });
        // Bump our local refetch so used_by reflects the new release.
        setRefetch((n) => n + 1);
      } else if (result.kind === "failed") {
        setInstallStatus({
          kind: "error",
          message: result.message,
          helm_stderr: result.helm_stderr,
        });
      } else {
        setInstallStatus({
          kind: "error",
          message: "helm CLI not found on PATH",
        });
      }
    } catch (e) {
      setInstallStatus({ kind: "error", message: String(e) });
    }
  };

  return (
    <Frame t={t}>
      {/* Top status strip — chart name + version, and a hint about how
          many releases are using it. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 10,
          marginBottom: 18,
        }}
      >
        <strong style={{ fontFamily: FONT_MONO, fontSize: 13 }}>
          {d.chart_name}
        </strong>
        <span
          style={{
            fontSize: 10.5,
            fontFamily: FONT_MONO,
            padding: "2px 8px",
            borderRadius: 4,
            background: t.chip,
            color: t.textMuted,
          }}
          title={
            d.source === "cluster"
              ? "in-cluster · derived from existing helm release"
              : `repo · ${d.source}`
          }
        >
          {d.source === "cluster" ? "in-cluster" : d.source}
        </span>
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          v{d.chart_version}
          {d.app_version ? ` · app ${d.app_version}` : ""}
          {d.used_by.length > 0
            ? ` · used by ${d.used_by.length} release${d.used_by.length === 1 ? "" : "s"}`
            : ""}
        </span>
      </div>

      {/* Chart metadata. */}
      <Section t={t} title="Chart" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Name">
          <Copyable text={d.chart_name}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>{d.chart_name}</span>
          </Copyable>
        </DetailRow>
        <DetailRow t={t} label="Version">
          <Copyable text={d.chart_version}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>{d.chart_version}</span>
          </Copyable>
        </DetailRow>
        <DetailRow t={t} label="App version">
          {d.app_version ? (
            <Copyable text={d.app_version}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>{d.app_version}</span>
            </Copyable>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
        <DetailRow t={t} label="Description">
          {d.description ? (
            <Copyable text={d.description}>
              <span style={{ fontSize: 12 }}>{d.description}</span>
            </Copyable>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
        <DetailRow t={t} label="Home">
          {d.home ? (
            <Copyable text={d.home}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12, wordBreak: "break-all" }}>
                {d.home}
              </span>
            </Copyable>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
        {d.sources.length > 0 ? (
          <DetailRow t={t} label="Sources">
            <ChipWrap>
              {d.sources.map((s, i) => (
                <Copyable key={`${s}-${i}`} text={s}>
                  <span
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 11.5,
                      padding: "2px 8px",
                      borderRadius: 4,
                      background: t.chip,
                      color: t.text,
                      wordBreak: "break-all",
                    }}
                  >
                    {s}
                  </span>
                </Copyable>
              ))}
            </ChipWrap>
          </DetailRow>
        ) : null}
        {d.keywords.length > 0 ? (
          <DetailRow t={t} label="Keywords">
            <ChipWrap>
              {d.keywords.map((k, i) => (
                <span
                  key={`${k}-${i}`}
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 11.5,
                    padding: "2px 8px",
                    borderRadius: 4,
                    background: t.chip,
                    color: t.textMuted,
                  }}
                >
                  {k}
                </span>
              ))}
            </ChipWrap>
          </DetailRow>
        ) : null}
      </div>

      {/* Used by — releases currently running this chart. Operators
          looking for "what does this chart look like configured" can jump
          straight to one of these. */}
      <Section
        t={t}
        title="Used by"
        right={
          <span style={{ fontSize: 10.5, color: t.textMuted }}>
            {d.used_by.length} release{d.used_by.length === 1 ? "" : "s"}
          </span>
        }
      />
      {d.used_by.length === 0 ? (
        <div style={{ marginBottom: 22 }}>
          <Mute t={t}>— no releases (chart still appears here while present in cluster state)</Mute>
        </div>
      ) : (
        <div style={{ marginBottom: 22 }}>
          {d.used_by.map((r) => (
            <UsedByRow key={`${r.namespace}/${r.name}`} t={t} entry={r} onNavigate={props.onNavigate} />
          ))}
        </div>
      )}

      {/* Install — release name + namespace + values editor + Install. */}
      <Section
        t={t}
        title="Install"
        right={
          d.helm_available ? (
            <span style={{ fontSize: 10.5, color: t.textMuted }}>
              `helm install` against this chart
            </span>
          ) : (
            <span
              title="Install helm CLI to enable install"
              style={{ fontSize: 10.5, color: t.textMuted }}
            >
              read-only · helm CLI not found
            </span>
          )
        }
      />
      <div style={{ marginBottom: 14 }}>
        <DetailRow t={t} label="Release name">
          <input
            type="text"
            value={releaseName}
            onChange={(e) => setReleaseName(e.target.value)}
            disabled={!d.helm_available || installStatus.kind === "saving"}
            placeholder={d.chart_name}
            style={inputStyle(t)}
          />
        </DetailRow>
        <DetailRow t={t} label="Namespace">
          <input
            type="text"
            value={namespace}
            onChange={(e) => setNamespace(e.target.value)}
            disabled={!d.helm_available || installStatus.kind === "saving"}
            placeholder="default"
            style={inputStyle(t)}
          />
          <span style={{ fontSize: 10.5, color: t.textMuted, marginLeft: 8 }}>
            created if missing (`--create-namespace`)
          </span>
        </DetailRow>
      </div>

      {installStatus.kind === "success" ? (
        <SuccessBanner
          t={t}
          message={`Installed ${installStatus.release_name} in ${installStatus.namespace} · revision ${installStatus.revision}${
            installStatus.status ? ` · ${installStatus.status}` : ""
          } · ${installStatus.elapsed_ms}ms`}
          onDismiss={() => setInstallStatus({ kind: "idle" })}
        />
      ) : null}
      {installStatus.kind === "error" ? (
        <ErrorBanner
          t={t}
          message={installStatus.message}
          stderr={installStatus.helm_stderr}
          onDismiss={() => setInstallStatus({ kind: "idle" })}
        />
      ) : null}

      <div style={{ marginBottom: 14 }}>
        <ValuesEditor
          t={t}
          mode={props.mode}
          value={valuesBuffer}
          onChange={setValuesBuffer}
          height={360}
          disabled={!d.helm_available || installStatus.kind === "saving"}
        />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          onClick={() => {
            setValuesBuffer(d.default_values_yaml);
            setSeededValues(d.default_values_yaml);
          }}
          disabled={installStatus.kind === "saving"}
          style={{
            fontSize: 11.5,
            fontFamily: FONT_MONO,
            padding: "5px 12px",
            borderRadius: 4,
            border: `1px solid ${t.border}`,
            background: "transparent",
            color: t.textDim,
            cursor: "pointer",
          }}
        >
          Reset values
        </button>
        <button
          type="button"
          onClick={onInstall}
          disabled={!canInstall}
          style={{
            fontSize: 11.5,
            fontFamily: FONT_MONO,
            padding: "5px 14px",
            borderRadius: 4,
            border: `1px solid ${canInstall ? t.accent : t.border}`,
            background: canInstall ? t.accent : t.chip,
            color: canInstall ? "#fff" : t.textMuted,
            cursor: canInstall ? "pointer" : "not-allowed",
          }}
        >
          {installStatus.kind === "saving" ? "Installing…" : "Install"}
        </button>
      </div>
    </Frame>
  );
}

function inputStyle(t: Tokens): React.CSSProperties {
  return {
    fontFamily: FONT_MONO,
    fontSize: 12,
    padding: "4px 8px",
    borderRadius: 4,
    border: `1px solid ${t.border}`,
    background: t.surface,
    color: t.text,
    minWidth: 240,
  };
}

function UsedByRow({
  t,
  entry,
  onNavigate,
}: {
  t: Tokens;
  entry: HelmChartUsedBy;
  onNavigate?: DetailNavigate;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "180px 110px 110px 1fr",
        gap: 12,
        padding: "6px 0",
        fontSize: 12,
        fontFamily: FONT_MONO,
        borderTop: `1px solid ${t.borderSoft}`,
      }}
    >
      <LinkValue
        t={t}
        onClick={() => onNavigate?.("HelmRelease", entry.namespace, entry.name)}
        copyText={`${entry.namespace}/${entry.name}`}
        enabled={!!onNavigate}
      >
        {entry.name}
      </LinkValue>
      <Copyable text={entry.namespace}>
        <span>{entry.namespace}</span>
      </Copyable>
      <span>
        rev {entry.revision}
        {entry.status ? (
          <>
            {" · "}
            <StatusPill status={entry.status} t={t} mode="light" dense compact />
          </>
        ) : null}
      </span>
      <span style={{ color: t.textMuted }} title={entry.updated ?? undefined}>
        {entry.updated ? `${ageFromIso(entry.updated)} ago` : "—"}
      </span>
    </div>
  );
}

// Editable Monaco for values input. Same wiring as the EditableYaml in
// the helm release panel — accent border, clipboard shortcuts, scroll
// bubble-out — but always editable here (no view/edit toggle since the
// operator's primary action is "install with edits").
function ValuesEditor({
  t,
  mode,
  value,
  onChange,
  height,
  disabled,
}: {
  t: Tokens;
  mode: ThemeMode;
  value: string;
  onChange: (v: string) => void;
  height: number;
  disabled?: boolean;
}) {
  return (
    <div
      style={{
        border: `1px solid ${disabled ? t.border : t.accent}`,
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      <Editor
        height={height}
        language="yaml"
        theme={mode === "dark" ? "vs-dark" : "light"}
        value={value}
        onChange={(next) => onChange(next ?? "")}
        onMount={installClipboardShortcuts}
        options={{
          readOnly: !!disabled,
          minimap: { enabled: false },
          fontSize: 12,
          fontFamily:
            '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
          wordWrap: "on",
          scrollBeyondLastLine: false,
          renderLineHighlight: "line",
          folding: true,
          lineNumbers: "on",
          scrollbar: {
            alwaysConsumeMouseWheel: false,
          },
        }}
      />
    </div>
  );
}

function SuccessBanner({
  t,
  message,
  onDismiss,
}: {
  t: Tokens;
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        padding: "8px 12px",
        marginBottom: 12,
        background: "rgba(34,197,94,0.10)",
        border: `1px solid rgba(34,197,94,0.45)`,
        color: t.text,
        fontSize: 11.5,
        borderRadius: 6,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        style={{
          fontSize: 10.5,
          fontFamily: FONT_MONO,
          background: "transparent",
          border: "none",
          color: t.textMuted,
          cursor: "pointer",
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

function ErrorBanner({
  t,
  message,
  stderr,
  onDismiss,
}: {
  t: Tokens;
  message: string;
  stderr?: string;
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        padding: "8px 12px",
        marginBottom: 12,
        background: "rgba(244,63,94,0.10)",
        border: `1px solid rgba(244,63,94,0.45)`,
        color: t.text,
        fontSize: 11.5,
        borderRadius: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <ErrorBlock
          t={t}
          message={message}
          kindLabel="helm chart"
          verb="save"
          inline
        />
        <button
          type="button"
          onClick={onDismiss}
          style={{
            fontSize: 10.5,
            fontFamily: FONT_MONO,
            background: "transparent",
            border: "none",
            color: t.textMuted,
            cursor: "pointer",
          }}
        >
          Dismiss
        </button>
      </div>
      {stderr ? (
        <pre
          style={{
            margin: "6px 0 0",
            padding: "8px 10px",
            background: t.surface,
            border: `1px solid ${t.borderSoft}`,
            borderRadius: 4,
            fontFamily: FONT_MONO,
            fontSize: 11,
            color: t.text,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 200,
            overflow: "auto",
          }}
        >
          {stderr}
        </pre>
      ) : null}
    </div>
  );
}

// Suggest a sensible default release name from the chart name. Mirrors
// `helm install` UX where operators usually pass the chart short-name
// as the release name. Strip any leading `<repo>/` if the chart name
// happens to be qualified.
function suggestReleaseName(chartName: string): string {
  const slash = chartName.lastIndexOf("/");
  return slash >= 0 ? chartName.slice(slash + 1) : chartName;
}
