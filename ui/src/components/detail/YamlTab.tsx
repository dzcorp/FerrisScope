// The detail panel's YAML tab — a `kubectl edit`-style manifest editor.
//
// Design notes vs. the structured per-field editors:
//   • Always editable. There is no pencil / read-mode gate; the operator
//     types straight into the document and a Save/Discard pair appears the
//     moment the buffer diverges from the server copy.
//   • Saves via an RFC 7386 JSON merge patch (`api.mergePatchResource`), not
//     SSA. That's what makes removals and blanked values actually apply —
//     a removed key is sent as `null`. See `lib/yamlEdit.ts::mergePatch`.
//   • Optimistic concurrency: the patch carries the `resourceVersion` the
//     operator opened. If the object moved on, the apiserver rejects it and
//     we surface a stale-conflict banner (Reload / Apply anyway) instead of
//     silently clobbering the newer copy.
//
// The buffer + save/stale/error state is owned by the parent (`DetailPanel`)
// so it survives tab switches and is reset on target change. `buffer === null`
// means "in sync with the server" — the editor then tracks live refetches.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Editor from "@monaco-editor/react";
import { api } from "../../api";
import { installClipboardShortcuts } from "../../lib/monacoClipboard";
import { mergePatch, parseYaml, type Json } from "../../lib/yamlEdit";
import { useResolvedTheme } from "../../store";
import {
  FF_MONO,
  FS_MD,
  FS_SM,
  FS_XS,
  R_SM,
  type ThemeMode,
  type Tokens,
} from "../../theme";
import { ErrorBlock } from "../ui";

export type YamlStale = { message: string };

type Props = {
  mode: ThemeMode;
  t: Tokens;
  // Stripped, source-like YAML — the editable baseline.
  yaml: string;
  // Unstripped YAML (managedFields / status / resourceVersion …) — shown
  // read-only via the "Show server fields" toggle.
  yamlRaw: string;
  // Parsed form of the stripped doc; the merge-patch baseline. Null when the
  // server YAML failed to parse, which disables saving.
  original: Json | null;
  // resourceVersion the operator opened — drives optimistic concurrency.
  resourceVersion: string | null;
  refreshedAt: number | null;
  clusterId: string;
  kindId: string;
  kindLabel: string;
  namespace: string | null;
  name: string;
  // Parent-owned draft. null = synced to server (editor tracks `yaml`).
  buffer: string | null;
  setBuffer: (v: string | null) => void;
  saving: boolean;
  setSaving: (v: boolean) => void;
  stale: YamlStale | null;
  setStale: (v: YamlStale | null) => void;
  error: string | null;
  setError: (v: string | null) => void;
  // Clear local draft/stale/error and refetch the live object. Used after a
  // successful save and on an explicit Reload.
  onResync: () => void;
  // True when the cluster is unavailable / mid auto-reconnect. Forces the
  // editor read-only and blocks Save + Apply-anyway (the draft is preserved so
  // it can be saved once reconnected). Viewing, Discard, and the server-fields
  // toggle stay live.
  readOnly?: boolean;
};

export function YamlTab({
  mode,
  t,
  yaml,
  yamlRaw,
  original,
  resourceVersion,
  refreshedAt,
  clusterId,
  kindId,
  kindLabel,
  namespace,
  name,
  buffer,
  setBuffer,
  saving,
  setSaving,
  stale,
  setStale,
  error,
  setError,
  onResync,
  readOnly = false,
}: Props) {
  const monoFont = useResolvedTheme().typography.fontMono;

  // Operator-facing toggle: render the unstripped raw YAML read-only so
  // server-managed fields can be inspected without leaving the panel. The
  // draft is preserved underneath. Reset whenever the document refetches.
  const [showRaw, setShowRaw] = useState(false);
  useEffect(() => {
    setShowRaw(false);
  }, [refreshedAt]);

  const hasRaw = yamlRaw !== yaml;

  // Frozen merge-patch baseline. The detail panel refetches the live object
  // every few hundred ms while the watcher is chatty — if we diffed against
  // (and saved the resourceVersion of) that moving target, a concurrent
  // external edit would be silently rebased away and the optimistic lock
  // would never fire. So we snapshot {original, resourceVersion, yaml} at the
  // instant editing begins and hold it until the operator is back in sync.
  // While in sync (buffer null) the baseline tracks the latest server copy.
  const [baseline, setBaseline] = useState({ original, resourceVersion, yaml });
  useEffect(() => {
    if (buffer === null) setBaseline({ original, resourceVersion, yaml });
  }, [buffer, original, resourceVersion, yaml]);

  // The text Monaco renders. When synced (buffer null) we track the live
  // server copy so a watcher refetch keeps the view fresh.
  const draft = buffer ?? yaml;
  const value = showRaw ? yamlRaw : draft;

  // Merge-patch metrics for the current draft against the frozen baseline.
  // `count` drives the change chip; `parseError` flips Save + the status line.
  const diff = useMemo(() => {
    if (baseline.original == null)
      return { count: 0, empty: true, parseError: false };
    try {
      const edited = parseYaml(draft);
      const mp = mergePatch(baseline.original, edited);
      return { count: mp.count, empty: mp.empty, parseError: false };
    } catch {
      return { count: 0, empty: true, parseError: true };
    }
  }, [baseline.original, draft]);

  const editable = baseline.original != null;
  const dirty = buffer !== null && !diff.empty && !diff.parseError;
  const canSave = editable && dirty && !saving && !showRaw && !readOnly;

  const save = async (ignoreVersion: boolean) => {
    if (baseline.original == null) {
      setError("Cannot edit: the server document failed to parse.");
      return;
    }
    let edited: Json;
    try {
      edited = parseYaml(buffer ?? baseline.yaml);
    } catch (e) {
      setError(`YAML parse error: ${String(e)}`);
      return;
    }
    const mp = mergePatch(baseline.original, edited);
    if (mp.empty) {
      setError("Nothing changed.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.mergePatchResource(
        clusterId,
        kindId,
        namespace,
        name,
        mp.patch,
        ignoreVersion ? null : baseline.resourceVersion,
      );
      setSaving(false);
      if (res.kind === "applied") {
        setStale(null);
        onResync();
      } else {
        setStale({ message: res.message });
      }
    } catch (e) {
      setSaving(false);
      setError(String(e));
    }
  };

  const discard = () => {
    setBuffer(null);
    setStale(null);
    setError(null);
  };

  const reload = () => {
    setStale(null);
    setError(null);
    onResync();
  };

  // ── Header status line ───────────────────────────────────────────────────
  let statusText: string;
  let statusTone: "muted" | "accent" | "bad" = "muted";
  if (showRaw) {
    statusText = "read-only · all server fields shown";
  } else if (readOnly) {
    statusText = dirty
      ? "read-only · cluster unavailable · changes kept"
      : "read-only · cluster unavailable";
    statusTone = "bad";
  } else if (!editable) {
    statusText = "read-only · server YAML could not be parsed";
    statusTone = "bad";
  } else if (diff.parseError) {
    statusText = "YAML parse error · fix to enable Save";
    statusTone = "bad";
  } else if (dirty) {
    statusText = `${diff.count} unsaved change${diff.count === 1 ? "" : "s"}`;
    statusTone = "accent";
  } else {
    statusText =
      refreshedAt != null
        ? `in sync · fetched ${timeAgo(refreshedAt)}`
        : "in sync";
  }

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
          gap: 10,
          padding: "6px 14px",
          borderBottom: `1px solid ${t.borderSoft}`,
          background: t.headerAlt,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontSize: FS_XS,
            fontFamily: FF_MONO,
            color:
              statusTone === "accent"
                ? t.accent
                : statusTone === "bad"
                  ? t.bad
                  : t.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.6,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {dirty && !showRaw && !diff.parseError && (
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: t.accent,
                flexShrink: 0,
              }}
            />
          )}
          {statusText}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          {hasRaw && (
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              title={
                showRaw
                  ? "Hide server-managed fields (managedFields, status, resourceVersion, …)"
                  : "Show server-managed fields (managedFields, status, resourceVersion, …)"
              }
              style={toggleBtnStyle(t, showRaw)}
            >
              {showRaw ? "Editing view" : "Server fields"}
            </button>
          )}
          {buffer !== null && !showRaw && (
            // Available whenever the draft has diverged — including when the
            // YAML no longer parses, so a typo is always recoverable.
            <button
              type="button"
              onClick={discard}
              disabled={saving}
              title="Discard your edits and return to the server copy"
              style={chipBtnStyle(t, "ghost", saving)}
            >
              Discard
            </button>
          )}
          {editable && !showRaw && (
            <button
              type="button"
              onClick={() => save(false)}
              disabled={!canSave}
              title={
                dirty
                  ? "Apply your changes (kubectl edit-style merge patch)"
                  : "No changes to save"
              }
              style={chipBtnStyle(t, "primary", !canSave)}
            >
              {saving
                ? "Saving…"
                : dirty
                  ? `Save (${diff.count})`
                  : "Save"}
            </button>
          )}
        </span>
      </div>

      {error && (
        <div
          style={{
            padding: "8px 14px",
            background: "rgba(244,63,94,0.1)",
            borderBottom: `1px solid ${t.borderSoft}`,
            flexShrink: 0,
          }}
        >
          <ErrorBlock
            t={t}
            message={error}
            kindLabel={kindLabel}
            verb="save"
            inline
          />
        </div>
      )}

      {stale && (
        <div style={{ padding: "10px 14px 0", flexShrink: 0 }}>
          <StaleBanner
            t={t}
            message={stale.message}
            saving={saving}
            applyDisabled={readOnly}
            onReload={reload}
            onApplyAnyway={() => save(true)}
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
            if (showRaw || saving || readOnly) return;
            setBuffer(next ?? "");
          }}
          onMount={installClipboardShortcuts}
          options={{
            readOnly: showRaw || saving || !editable || readOnly,
            minimap: { enabled: false },
            fontSize: 12.5,
            fontFamily: monoFont,
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

// Stale-conflict surface: the object changed on the server since the operator
// opened it. They either reload (discard their edits, take the new copy) or
// apply anyway (re-send the merge patch without the resourceVersion guard —
// only the fields they touched are overwritten, concurrent edits to other
// fields survive).
function StaleBanner({
  t,
  message,
  saving,
  applyDisabled = false,
  onReload,
  onApplyAnyway,
}: {
  t: Tokens;
  message: string;
  saving: boolean;
  // Blocks "Apply my changes anyway" when the cluster is degraded (it's a
  // write). Reload stays enabled — it's a read that refetches the live object.
  applyDisabled?: boolean;
  onReload: () => void;
  onApplyAnyway: () => void;
}) {
  return (
    <div
      style={{
        margin: "0 0 12px",
        padding: "10px 12px",
        background: "rgba(245,158,11,0.12)",
        border: "1px solid rgba(245,158,11,0.4)",
        borderRadius: R_SM,
        color: t.text,
        fontSize: FS_MD,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span style={{ color: t.warn, fontWeight: 700 }}>Object changed</span>
        <span style={{ color: t.textDim }}>
          since you opened it — saving would overwrite the newer copy
        </span>
      </div>
      <div
        style={{
          fontSize: FS_SM,
          color: t.textMuted,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {message}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          onClick={onReload}
          disabled={saving}
          style={chipBtnStyle(t, "ghost", saving)}
        >
          Reload
        </button>
        <button
          type="button"
          onClick={onApplyAnyway}
          disabled={saving || applyDisabled}
          style={{
            ...chipBtnStyle(t, "ghost", saving || applyDisabled),
            background: "rgba(244,63,94,0.16)",
            color: t.bad,
          }}
        >
          {saving ? "Applying…" : "Apply my changes anyway"}
        </button>
      </div>
    </div>
  );
}

function toggleBtnStyle(t: Tokens, active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 22,
    padding: "0 8px",
    borderRadius: R_SM,
    border: "none",
    background: active ? t.accentSoft : t.chip,
    color: active ? t.accent : t.textDim,
    fontFamily: FF_MONO,
    fontSize: FS_SM,
    fontWeight: 700,
    letterSpacing: 0.4,
    cursor: "pointer",
    textTransform: "uppercase",
  };
}

function chipBtnStyle(
  t: Tokens,
  variant: "primary" | "ghost",
  disabled: boolean,
): CSSProperties {
  const base: CSSProperties = {
    height: 22,
    padding: "0 10px",
    borderRadius: R_SM,
    border: "none",
    fontFamily: FF_MONO,
    fontSize: FS_SM,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    cursor: disabled ? "not-allowed" : "pointer",
  };
  if (variant === "primary") {
    // Match the codebase's Save convention (soft-green `good` tone) so the
    // YAML save reads the same as the structured editors' Save chips.
    return disabled
      ? { ...base, background: t.chip, color: t.textMuted }
      : { ...base, background: "rgba(16,185,129,0.16)", color: t.good };
  }
  return { ...base, background: t.chip, color: t.textDim, opacity: disabled ? 0.5 : 1 };
}

function timeAgo(then: number): string {
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
