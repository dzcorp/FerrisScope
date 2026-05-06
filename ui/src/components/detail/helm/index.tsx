// Helm release detail summary. Reads the same primitives every other kind
// uses (Section, DetailRow, SubGrid, Copyable, LinkValue, ChipStrip) — see
// CLAUDE.md §"Detail-panel primitives". Helm release "meta" doesn't map onto
// the WorkloadMeta that K8s objects share (no labels/uid/annotations on the
// logical release), so we render a bespoke Details block instead of
// composing MetaSection.
//
// Read-only: SSA against the release secret would corrupt Helm's storage
// driver state. Operators who want to modify a release run `helm upgrade` —
// out of scope for this app for now.

import { useEffect, useRef, useState, type ReactNode } from "react";
import Editor from "@monaco-editor/react";
import { api } from "../../../api";
import { FONT_MONO, type ThemeMode, type Tokens } from "../../../theme";
import { tokens } from "../../../theme";
import { Loading, Section, StatusPill } from "../../ui";
import {
  ChipWrap,
  Copyable,
  DetailRow,
  Mute,
  SubGrid,
  ageFromIso,
  type DetailNavigate,
} from "..";
import { EditModeChrome } from "../edit";
import { dumpYaml, type Json } from "../../../lib/yamlEdit";
import {
  installClipboardShortcuts,
  type MonacoEditor,
} from "../../../lib/monacoClipboard";
import type {
  HelmReleaseDetail,
  HelmReleaseHistoryEntry,
} from "../../../types";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; detail: HelmReleaseDetail }
  | { kind: "error"; message: string };

function useDetail(
  fetcher: () => Promise<HelmReleaseDetail>,
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

function ErrorBlock({ t, message }: { t: Tokens; message: string }) {
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
      {message}
    </pre>
  );
}

// Render a free-form Helm `values` payload as YAML — what operators paste
// straight into a `--values` file or `helm upgrade -f`. We piggyback on
// the same `js-yaml` dump used by the manifest editor (`lib/yamlEdit`),
// so the output style (2-space indent, no anchors, key order preserved)
// matches the Manifest tab. Falls back to JSON.stringify on dump failure
// — Helm values are arbitrary JSON, almost always YAML-safe in practice
// but we want to stay total.
function valuesToYaml(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return dumpYaml(v as Json);
  } catch {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
}

function MonoBlock({
  t,
  text,
  emptyLabel,
  maxHeight,
}: {
  t: Tokens;
  text: string;
  emptyLabel: string;
  maxHeight?: number;
}) {
  if (!text.trim()) {
    return <Mute t={t}>{emptyLabel}</Mute>;
  }
  return (
    <Copyable text={text}>
      <pre
        style={{
          margin: 0,
          padding: "10px 12px",
          fontFamily: FONT_MONO,
          fontSize: 11.5,
          lineHeight: 1.5,
          color: t.text,
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: 6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight,
          overflow: maxHeight ? "auto" : undefined,
        }}
      >
        {text}
      </pre>
    </Copyable>
  );
}

// Read-only Monaco viewer for long YAML blocks (values, manifest, hooks).
// Same look + clipboard shortcuts as the Manifest tab so operators get a
// consistent editor: syntax highlighting, line numbers, fold gutter,
// search (Ctrl+F), Ctrl+C / Ctrl+X / Ctrl+V — none of which the prior
// `<pre>` could offer. Empty payload still falls back to a Mute string.
//
// Scroll trapping: stacking several Monaco editors inside the panel's
// scroll container causes wheel events over an editor to drive *its*
// internal scroll, never the page — operators get stuck mid-pane. We
// guard with a transparent overlay that intercepts wheel + click while
// the editor is "inactive". Click activates (focuses the editor; wheel
// now drives the editor); blur deactivates. While inactive, wheel events
// pass through the overlay's default (no preventDefault) and bubble to
// the surrounding `<Frame>` scroll container as the user expects.
//
// We also set `scrollbar.alwaysConsumeMouseWheel: false` so when the
// editor IS active and the user scrolls past either end, the wheel
// event bubbles out to the page instead of dead-ending in the editor.
function YamlViewer({
  t,
  mode,
  text,
  language = "yaml",
  emptyLabel,
  height,
}: {
  t: Tokens;
  mode: ThemeMode;
  text: string;
  language?: "yaml" | "json";
  emptyLabel: string;
  height: number;
}) {
  const [active, setActive] = useState(false);
  const editorRef = useRef<MonacoEditor | null>(null);
  if (!text.trim()) {
    return <Mute t={t}>{emptyLabel}</Mute>;
  }
  const activate = () => {
    setActive(true);
    // Defer the focus call until React has unmounted the overlay so the
    // editor's textarea actually receives focus (focusing under a
    // pointer-events:auto sibling silently no-ops).
    setTimeout(() => editorRef.current?.focus(), 0);
  };
  return (
    <div
      style={{
        position: "relative",
        border: `1px solid ${active ? t.accent : t.border}`,
        borderRadius: 6,
        overflow: "hidden",
        transition: "border-color 120ms ease",
      }}
    >
      <Editor
        height={height}
        language={language}
        theme={mode === "dark" ? "vs-dark" : "light"}
        value={text}
        onMount={(editor, monaco) => {
          editorRef.current = editor;
          installClipboardShortcuts(editor, monaco);
          editor.onDidBlurEditorWidget(() => setActive(false));
        }}
        options={{
          readOnly: true,
          minimap: { enabled: false },
          fontSize: 12,
          fontFamily:
            '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
          wordWrap: "on",
          scrollBeyondLastLine: false,
          renderLineHighlight: "none",
          folding: true,
          lineNumbers: "on",
          domReadOnly: true,
          scrollbar: {
            alwaysConsumeMouseWheel: false,
          },
        }}
      />
      {!active && (
        <button
          type="button"
          onClick={activate}
          onMouseDown={(e) => {
            // Don't steal focus before our onClick runs; the editor's own
            // mousedown wiring won't fire while the overlay is in place.
            e.preventDefault();
          }}
          aria-label="Click to interact with editor"
          title="Click to interact · scroll outside to scroll the page"
          style={{
            position: "absolute",
            inset: 0,
            cursor: "pointer",
            background: "transparent",
            border: "none",
            padding: 0,
            // Above Monaco's chrome (line numbers ~ z-index 4, scrollbars
            // ~10) so wheel + click hit us first.
            zIndex: 20,
          }}
        />
      )}
    </div>
  );
}

// Writable variant — used while the operator is editing the User values.
// No click-to-activate overlay (editing implies engagement). Same
// clipboard wiring + scrollbar-bubble behaviour as the read-only viewer.
function EditableYaml({
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
        border: `1px solid ${t.accent}`,
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

export function HelmReleaseSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const ns = props.namespace;
  // Hooks must run unconditionally on every render — keep both the fetch
  // and the local UI state above the conditional returns so transitions
  // between loading / error / ready don't shift the hook order (which
  // would otherwise crash the panel to a white screen).
  // `refetch` is bumped after a successful upgrade so the panel reflects
  // the new revision without waiting for the watcher delta.
  const [refetch, setRefetch] = useState(0);
  const state = useDetail(
    () => api.getHelmReleaseDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );
  const [valuesTab, setValuesTab] = useState<"user" | "computed">("user");

  if (!ns) return <ErrorBlock t={t} message="Helm release requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <Loading t={t} label="Loading release…" inline />
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} />;

  return (
    <HelmReleaseView
      t={t}
      mode={props.mode}
      clusterId={props.clusterId}
      detail={state.detail}
      onNavigate={props.onNavigate}
      valuesTab={valuesTab}
      setValuesTab={setValuesTab}
      onSaved={() => setRefetch((n) => n + 1)}
    />
  );
}

type UpgradeStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | {
      kind: "success";
      revision: number;
      status: string | null;
      elapsed_ms: number;
    }
  | { kind: "error"; message: string; helm_stderr?: string };

function HelmReleaseView({
  t,
  mode,
  clusterId,
  detail: d,
  onNavigate,
  valuesTab,
  setValuesTab,
  onSaved,
}: {
  t: Tokens;
  mode: ThemeMode;
  clusterId: string;
  detail: HelmReleaseDetail;
  onNavigate?: DetailNavigate;
  valuesTab: "user" | "computed";
  setValuesTab: (v: "user" | "computed") => void;
  onSaved: () => void;
}) {
  // Edit-mode state for the User values block. Buffer is `null` while
  // not editing; the pencil chip seeds it from the rendered userText so
  // operators see exactly the same starting text Monaco was showing.
  const [buffer, setBuffer] = useState<string | null>(null);
  const [upgradeStatus, setUpgradeStatus] = useState<UpgradeStatus>({ kind: "idle" });
  const [repoUpdating, setRepoUpdating] = useState(false);
  const [repoUpdateMsg, setRepoUpdateMsg] = useState<string | null>(null);
  const editing = buffer !== null;
  const userText = valuesToYaml(d.values_user);
  const defaultsText = valuesToYaml(d.values_chart_defaults);
  // Cheap dirty signal — number of changed lines vs the rendered base
  // text. Operators don't need precise diffs here; non-zero is enough
  // for the Save chip's "(N)" badge.
  const dirty = editing ? approxLineDiff(userText, buffer!) : 0;
  const canEdit = d.helm_available;

  const onEnter = () => {
    setUpgradeStatus({ kind: "idle" });
    setBuffer(userText);
    setValuesTab("user");
  };
  const onCancel = () => {
    setBuffer(null);
    setUpgradeStatus({ kind: "idle" });
  };
  // Run the upgrade. When `override` is provided, helm pulls a different
  // chart version from a repo (used by the "Upgrade to X.Y.Z" banner);
  // otherwise the existing chart is preserved (Save edited values).
  const runUpgrade = async (
    valuesText: string,
    override?: { source: string; version: string },
  ) => {
    setUpgradeStatus({ kind: "saving" });
    try {
      const result = await api.upgradeHelmRelease(
        clusterId,
        d.namespace,
        d.name,
        valuesText,
        override?.source,
        override?.version,
      );
      if (result.kind === "upgraded") {
        setUpgradeStatus({
          kind: "success",
          revision: result.revision,
          status: result.status,
          elapsed_ms: result.elapsed_ms,
        });
        setBuffer(null);
        onSaved();
      } else if (result.kind === "failed") {
        setUpgradeStatus({
          kind: "error",
          message: result.message,
          helm_stderr: result.helm_stderr,
        });
      } else {
        setUpgradeStatus({
          kind: "error",
          message: "helm CLI not found on PATH",
        });
      }
    } catch (e) {
      setUpgradeStatus({ kind: "error", message: String(e) });
    }
  };
  const onSave = () => {
    if (buffer == null) return;
    void runUpgrade(buffer);
  };
  // Triggered by the "Upgrade to X.Y.Z" banner. Uses whatever values are
  // currently in the editor buffer (if editing) or the rendered userText
  // (if not), so operators don't lose pending value edits when they
  // upgrade — the new chart version applies on top of their values.
  const onUpgradeToVersion = (override: { source: string; version: string }) => {
    void runUpgrade(buffer ?? userText, override);
  };
  const onRepoUpdate = async () => {
    setRepoUpdating(true);
    setRepoUpdateMsg(null);
    try {
      const elapsed = await api.helmRepoUpdate();
      setRepoUpdateMsg(`Repos updated · ${elapsed}ms`);
      onSaved(); // bump refetch so update_available recomputes with fresh data
    } catch (e) {
      setRepoUpdateMsg(`Update failed: ${String(e)}`);
    } finally {
      setRepoUpdating(false);
    }
  };

  return (
    <Frame t={t}>
      {/* Top status strip — status pill, age, and Update-repos action. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 10,
          marginBottom: 18,
        }}
      >
        {d.status ? (
          <StatusPill status={statusLabel(d.status)} t={t} mode="light" dense />
        ) : null}
        <span style={{ fontSize: 11.5, color: t.textMuted }}>
          revision {d.revision}
          {d.last_deployed ? ` · updated ${ageFromIso(d.last_deployed)} ago` : ""}
          {d.history.length > 1 ? ` · ${d.history.length} revisions` : ""}
        </span>
        <span style={{ flex: 1 }} />
        {d.helm_available ? (
          <button
            type="button"
            onClick={onRepoUpdate}
            disabled={repoUpdating}
            title={
              repoUpdating
                ? "Running `helm repo update`…"
                : "Refresh local helm repo cache (`helm repo update`)"
            }
            style={{
              fontSize: 10.5,
              fontFamily: FONT_MONO,
              padding: "3px 10px",
              borderRadius: 4,
              border: `1px solid ${t.border}`,
              background: "transparent",
              color: t.textDim,
              cursor: repoUpdating ? "wait" : "pointer",
            }}
          >
            {repoUpdating ? "Updating…" : "↻ Update repos"}
          </button>
        ) : null}
        {repoUpdateMsg ? (
          <span style={{ fontSize: 10.5, color: t.textMuted }}>{repoUpdateMsg}</span>
        ) : null}
      </div>

      {/* Details — bespoke since Helm releases don't carry WorkloadMeta. */}
      <Section t={t} title="Details" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Name">
          <Copyable text={d.name}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>{d.name}</span>
          </Copyable>
        </DetailRow>
        <DetailRow t={t} label="Namespace">
          {d.namespace ? (
            <Copyable text={d.namespace}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {d.namespace}
              </span>
            </Copyable>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
        <DetailRow t={t} label="Revision">
          <Copyable text={String(d.revision)}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>{d.revision}</span>
          </Copyable>
        </DetailRow>
        <DetailRow t={t} label="Status">
          {d.status ? (
            <Copyable text={d.status}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>{d.status}</span>
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
        <DetailRow t={t} label="First deployed">
          {d.first_deployed ? (
            <Copyable text={d.first_deployed}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {ageFromIso(d.first_deployed)} ago
                <span style={{ color: t.textMuted, marginLeft: 8 }}>
                  ({d.first_deployed})
                </span>
              </span>
            </Copyable>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
        <DetailRow t={t} label="Last deployed">
          {d.last_deployed ? (
            <Copyable text={d.last_deployed}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {ageFromIso(d.last_deployed)} ago
                <span style={{ color: t.textMuted, marginLeft: 8 }}>
                  ({d.last_deployed})
                </span>
              </span>
            </Copyable>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
        {d.deleted ? (
          <DetailRow t={t} label="Deleted">
            <Copyable text={d.deleted}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                {ageFromIso(d.deleted)} ago
              </span>
            </Copyable>
          </DetailRow>
        ) : null}
      </div>

      {/* Chart — collapsed onto a single DetailRow with named sub-rows. */}
      <Section t={t} title="Chart" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Reference">
          {d.chart ? (
            <Copyable text={d.chart}>
              <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>{d.chart}</span>
            </Copyable>
          ) : (
            <Mute t={t}>—</Mute>
          )}
          <SubGrid
            t={t}
            entries={[
              { key: "name", value: d.chart_name },
              { key: "version", value: d.chart_version },
              { key: "app version", value: d.app_version },
              { key: "description", value: d.chart_description },
              { key: "home", value: d.chart_home },
            ]}
          />
        </DetailRow>
        {d.chart_sources.length > 0 ? (
          <DetailRow t={t} label="Sources">
            <ChipWrap>
              {d.chart_sources.map((s, i) => (
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
        {d.chart_keywords.length > 0 ? (
          <DetailRow t={t} label="Keywords">
            <ChipWrap>
              {d.chart_keywords.map((k, i) => (
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

      {/* Notes — `helm install`'s NOTES.txt rendering. Often the operator's
          most-used field on a freshly-installed release. */}
      <Section
        t={t}
        title="Notes"
        right={
          <span style={{ fontSize: 10.5, color: t.textMuted }}>
            from chart NOTES.txt
          </span>
        }
      />
      <div style={{ marginBottom: 22 }}>
        <MonoBlock
          t={t}
          text={d.notes ?? ""}
          emptyLabel="— no notes"
          maxHeight={260}
        />
      </div>

      {/* Values — toggle between user-supplied and chart defaults. The
          User tab is editable (when `helm` is on PATH); editing the
          buffer + Save runs `helm upgrade` against the chart embedded in
          this release secret. Chart defaults stay read-only — those
          live with the chart, not the release. */}
      <Section
        t={t}
        title="Values"
        right={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ display: "flex", gap: 4 }}>
              <ValuesTabButton
                t={t}
                label="User"
                active={valuesTab === "user"}
                onClick={() => setValuesTab("user")}
              />
              <ValuesTabButton
                t={t}
                label="Chart defaults"
                active={valuesTab === "computed"}
                onClick={() => setValuesTab("computed")}
              />
            </div>
            {valuesTab === "user" &&
              (canEdit ? (
                <EditModeChrome
                  t={t}
                  editing={editing}
                  dirty={dirty}
                  saving={upgradeStatus.kind === "saving"}
                  onEnter={onEnter}
                  onCancel={onCancel}
                  onSave={onSave}
                />
              ) : (
                <span
                  title="Install helm CLI to enable upgrade"
                  style={{ fontSize: 10.5, color: t.textMuted }}
                >
                  read-only · helm CLI not found
                </span>
              ))}
          </div>
        }
      />
      {/* Update-available banner — surfaces a newer chart version found
          in the operator's local helm repo cache. Click "Upgrade" to run
          helm upgrade with that version while preserving any pending
          value edits. Hidden during an in-flight save to avoid two
          competing actions on screen. */}
      {valuesTab === "user" && d.update_available && upgradeStatus.kind !== "saving" ? (
        <UpdateAvailableBanner
          t={t}
          current={d.chart_version}
          update={d.update_available}
          onUpgrade={() =>
            onUpgradeToVersion({
              source: d.update_available!.source,
              version: d.update_available!.version,
            })
          }
        />
      ) : null}
      {/* Banner — shows save outcome inline. Cleared on next edit-enter. */}
      {valuesTab === "user" && upgradeStatus.kind === "success" ? (
        <SuccessBanner
          t={t}
          message={`Upgraded to revision ${upgradeStatus.revision}${
            upgradeStatus.status ? ` · ${upgradeStatus.status}` : ""
          } · ${upgradeStatus.elapsed_ms}ms`}
          onDismiss={() => setUpgradeStatus({ kind: "idle" })}
        />
      ) : null}
      {valuesTab === "user" && upgradeStatus.kind === "error" ? (
        <ErrorBanner
          t={t}
          message={upgradeStatus.message}
          stderr={upgradeStatus.helm_stderr}
          onDismiss={() => setUpgradeStatus({ kind: "idle" })}
        />
      ) : null}
      <div style={{ marginBottom: 22 }}>
        {valuesTab === "user" && editing ? (
          <EditableYaml
            t={t}
            mode={mode}
            value={buffer!}
            onChange={(next) => setBuffer(next)}
            height={320}
            disabled={upgradeStatus.kind === "saving"}
          />
        ) : (
          <YamlViewer
            t={t}
            mode={mode}
            text={valuesTab === "user" ? userText : defaultsText}
            emptyLabel={
              valuesTab === "user" ? "— no overrides" : "— no defaults"
            }
            height={320}
          />
        )}
      </div>

      {/* Manifest — the rendered Kubernetes YAML Helm applied. Long; we cap
          height so it doesn't push the History section off-screen. */}
      <Section
        t={t}
        title="Manifest"
        right={
          d.manifest ? (
            <span style={{ fontSize: 10.5, color: t.textMuted }}>
              {d.manifest.split("\n").length} lines
            </span>
          ) : null
        }
      />
      <div style={{ marginBottom: 22 }}>
        <YamlViewer
          t={t}
          mode={mode}
          text={d.manifest ?? ""}
          emptyLabel="— no rendered manifest"
          height={360}
        />
      </div>

      {/* Hooks — pre-/post-install/upgrade/rollback objects. We don't have
          shape for each hook beyond raw JSON, so render count + raw. */}
      {d.hooks.length > 0 ? (
        <>
          <Section t={t} title={`Hooks (${d.hooks.length})`} />
          <div style={{ marginBottom: 22 }}>
            <YamlViewer
              t={t}
              mode={mode}
              text={valuesToYaml(d.hooks)}
              emptyLabel="— no hooks"
              height={260}
            />
          </div>
        </>
      ) : null}

      {/* History — every revision Helm has retained for this release.
          Ordered newest-first by the backend. */}
      <Section
        t={t}
        title="History"
        right={
          <span style={{ fontSize: 10.5, color: t.textMuted }}>
            {d.history.length} revision{d.history.length === 1 ? "" : "s"}
          </span>
        }
      />
      <HistoryTable t={t} entries={d.history} />
      {/* Suppress unused-import warning while not yet wiring cross-kind nav
          out of the release panel. */}
      <span style={{ display: "none" }} aria-hidden>
        {onNavigate ? "" : ""}
      </span>
    </Frame>
  );
}

function ValuesTabButton({
  t,
  label,
  active,
  onClick,
}: {
  t: Tokens;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 10.5,
        fontFamily: FONT_MONO,
        padding: "2px 8px",
        borderRadius: 4,
        border: `1px solid ${active ? t.accent : t.border}`,
        background: active ? t.accentSoft : "transparent",
        color: active ? t.accent : t.textMuted,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function HistoryTable({
  t,
  entries,
}: {
  t: Tokens;
  entries: HelmReleaseHistoryEntry[];
}) {
  if (entries.length === 0) {
    return <Mute t={t}>— no revisions</Mute>;
  }
  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        overflow: "hidden",
        marginBottom: 22,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "60px 110px 140px 120px 1fr",
          gap: 8,
          padding: "8px 12px",
          fontSize: 10.5,
          fontWeight: 700,
          color: t.textDim,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          background: t.surface,
          borderBottom: `1px solid ${t.border}`,
        }}
      >
        <span>Rev</span>
        <span>Status</span>
        <span>Updated</span>
        <span>App version</span>
        <span>Description</span>
      </div>
      {entries.map((e) => (
        <div
          key={e.revision}
          style={{
            display: "grid",
            gridTemplateColumns: "60px 110px 140px 120px 1fr",
            gap: 8,
            padding: "8px 12px",
            fontSize: 11.5,
            fontFamily: FONT_MONO,
            borderTop: `1px solid ${t.border}`,
            color: t.text,
          }}
        >
          <Copyable text={String(e.revision)}>
            <span>{e.revision}</span>
          </Copyable>
          <span>{e.status ?? "—"}</span>
          <span title={e.updated ?? undefined} style={{ color: t.textMuted }}>
            {e.updated ? `${ageFromIso(e.updated)} ago` : "—"}
          </span>
          <span>{e.app_version ?? "—"}</span>
          <span style={{ color: t.textMuted, wordBreak: "break-word" }}>
            {e.description ?? "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function statusLabel(s: string): string {
  // Helm uses lowercase ("deployed", "failed", "pending-install"). The
  // status pill helpers key on a fixed bucket vocabulary that already maps
  // these — pass through as-is.
  return s;
}

// Cheap line-level diff: count of edited/added/removed lines vs base.
// Used only for the "Save (N)" chip — operators don't care about exact
// counts, just whether they have pending work to save.
function approxLineDiff(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.split("\n");
  const bl = b.split("\n");
  let differing = 0;
  const len = Math.max(al.length, bl.length);
  for (let i = 0; i < len; i += 1) {
    if (al[i] !== bl[i]) differing += 1;
  }
  return differing;
}

function UpdateAvailableBanner({
  t,
  current,
  update,
  onUpgrade,
}: {
  t: Tokens;
  current: string | null;
  update: { source: string; version: string; app_version: string | null };
  onUpgrade: () => void;
}) {
  return (
    <div
      style={{
        padding: "8px 12px",
        marginBottom: 12,
        background: "rgba(59,130,246,0.10)",
        border: `1px solid rgba(59,130,246,0.45)`,
        color: t.text,
        fontSize: 11.5,
        borderRadius: 6,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontFamily: FONT_MONO }}>
        <strong style={{ color: t.accent }}>Update available</strong>
        {" · "}
        <span>{update.version}</span>
        {update.app_version ? ` · app ${update.app_version}` : ""}
        {current ? (
          <span style={{ color: t.textMuted }}> (current {current})</span>
        ) : null}
        <span style={{ color: t.textMuted }}> from {update.source}</span>
      </span>
      <button
        type="button"
        onClick={onUpgrade}
        title="Run helm upgrade with this version. Preserves any pending value edits."
        style={{
          fontSize: 11,
          fontFamily: FONT_MONO,
          padding: "4px 12px",
          borderRadius: 4,
          border: `1px solid ${t.accent}`,
          background: t.accent,
          color: "#fff",
          cursor: "pointer",
        }}
      >
        Upgrade to {update.version}
      </button>
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
        <strong style={{ color: t.bad }}>{message}</strong>
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
