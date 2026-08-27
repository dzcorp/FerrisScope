// Resource compare drawer — a LogPanel-style overlay that diffs the YAML of
// two selected resources side by side, typically the "same" object on two
// clusters of a virtual context (but any two rows of one kind work).
//
// The documents shown are the SAME stripped baseline the detail panel's
// YAML tab edits (`stripYaml` — managedFields / status / resourceVersion
// and friends removed), so the diff shows real spec divergence instead of
// server-managed noise.
//
// v1 keeps the pair fixed to the two selected rows; Swap flips sides. A
// future iteration can add per-side re-picking.

import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { api } from "../api";
import { stripYaml } from "../lib/yamlEdit";
import { useResolvedTheme, type SelectionMeta } from "../store";
import {
  clusterAccent,
  FF_MONO,
  FS_MD,
  FS_SM,
  FS_XS,
  R_MD,
  type ThemeMode,
  type Tokens,
} from "../theme";
import { Btn, ErrorBlock, IconBtn, Icons, LoadingLine } from "./ui";

export type CompareSide = {
  clusterId: string;
  clusterName: string;
  // Identity accent index (same assignment the merged table uses).
  colorIdx: number;
  namespace: string | null;
  name: string;
};

export type CompareTarget = {
  kindId: string;
  kindLabel: string;
  a: CompareSide;
  b: CompareSide;
};

/// Build a compare target from the current selection — exactly two rows,
/// ordered by selection insertion order. Returns null otherwise.
export function compareTargetFromSelection(
  selection: Map<string, SelectionMeta>,
  kindId: string,
  kindLabel: string,
  clusterNameFor: (clusterId: string) => string,
  colorIdxFor: (clusterId: string) => number,
): CompareTarget | null {
  if (selection.size !== 2) return null;
  const [ma, mb] = Array.from(selection.values());
  if (!ma || !mb) return null;
  const side = (m: SelectionMeta): CompareSide => ({
    clusterId: m.clusterId,
    clusterName: clusterNameFor(m.clusterId),
    colorIdx: colorIdxFor(m.clusterId),
    namespace: m.namespace,
    name: m.name,
  });
  return { kindId, kindLabel, a: side(ma), b: side(mb) };
}

type SideState =
  | { status: "loading" }
  | { status: "ok"; yaml: string }
  | { status: "error"; message: string };

function useSideYaml(
  kindId: string,
  side: CompareSide,
  attempt: number,
): SideState {
  const [state, setState] = useState<SideState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    api
      .getResourceYaml(side.clusterId, kindId, side.namespace, side.name)
      .then((raw) => {
        if (cancelled) return;
        // Strip server-managed fields with the same rules as the YAML tab's
        // editable baseline; fall back to the raw doc if parsing chokes.
        let yaml = raw;
        try {
          yaml = stripYaml(raw);
        } catch {
          // Show the unstripped document rather than nothing.
        }
        setState({ status: "ok", yaml });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ status: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [kindId, side.clusterId, side.namespace, side.name, attempt]);
  return state;
}

type Props = {
  mode: ThemeMode;
  target: CompareTarget;
  onClose: () => void;
};

export function ComparePanel({ mode, target, onClose }: Props) {
  const resolved = useResolvedTheme();
  const t = resolved.tokens;
  const monoFont = resolved.typography.fontMono;
  // Fetch keyed to the fixed a/b pair; Swap only re-orders which side is
  // "original" vs "modified" at render time, so flipping never refetches.
  const [swapped, setSwapped] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const aState = useSideYaml(target.kindId, target.a, attempt);
  const bState = useSideYaml(target.kindId, target.b, attempt);
  const left = swapped ? target.b : target.a;
  const right = swapped ? target.a : target.b;
  const leftState = swapped ? bState : aState;
  const rightState = swapped ? aState : bState;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loading =
    leftState.status === "loading" || rightState.status === "loading";
  const errors = [
    leftState.status === "error" ? { side: left, msg: leftState.message } : null,
    rightState.status === "error"
      ? { side: right, msg: rightState.message }
      : null,
  ].filter((e): e is { side: CompareSide; msg: string } => e !== null);

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
          // Side-by-side diff needs real width — wider than LogPanel's 680.
          width: "min(1200px, 94vw)",
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
            padding: "14px 22px 12px",
            borderBottom: `1px solid ${t.borderSoft}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
            minWidth: 0,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: FS_MD,
                fontWeight: 600,
                color: t.text,
                letterSpacing: -0.2,
              }}
            >
              Compare {target.kindLabel}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 6,
                minWidth: 0,
              }}
            >
              <SideChip t={t} side={left} />
              <span style={{ color: t.textMuted, fontSize: FS_SM, flexShrink: 0 }}>
                vs
              </span>
              <SideChip t={t} side={right} />
            </div>
          </div>
          <Btn
            t={t}
            size="sm"
            title="Swap sides"
            onClick={() => setSwapped((v) => !v)}
          >
            ⇄ Swap
          </Btn>
          <IconBtn t={t} size="lg" title="Close (Esc)" onClick={onClose}>
            {Icons.close}
          </IconBtn>
        </header>

        <div style={{ flex: 1, minHeight: 0 }}>
          {errors.length > 0 ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 12,
                padding: 22,
              }}
            >
              {errors.map((e) => (
                <div key={e.side.clusterId + e.side.name}>
                  <div
                    style={{
                      fontSize: FS_XS,
                      color: t.textMuted,
                      fontFamily: FF_MONO,
                      marginBottom: 6,
                    }}
                  >
                    {e.side.clusterName} · {e.side.namespace ?? "—"}/
                    {e.side.name}
                  </div>
                  <ErrorBlock
                    t={t}
                    message={e.msg}
                    kindLabel={target.kindLabel}
                    inline
                  />
                </div>
              ))}
              <div>
                <Btn t={t} size="sm" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </Btn>
              </div>
            </div>
          ) : loading ? (
            <LoadingLine t={t} label="Fetching both manifests…" />
          ) : (
            <DiffEditor
              height="100%"
              language="yaml"
              theme={mode === "dark" ? "vs-dark" : "light"}
              original={leftState.status === "ok" ? leftState.yaml : ""}
              modified={rightState.status === "ok" ? rightState.yaml : ""}
              options={{
                readOnly: true,
                originalEditable: false,
                renderSideBySide: true,
                minimap: { enabled: false },
                fontSize: 12.5,
                fontFamily: monoFont,
                wordWrap: "on",
                scrollBeyondLastLine: false,
                renderLineHighlight: "none",
                folding: true,
              }}
            />
          )}
        </div>
      </div>
    </>
  );
}

// Identity chip for one side: accent dot + cluster name + ns/name.
function SideChip({ t, side }: { t: Tokens; side: CompareSide }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        borderRadius: R_MD,
        background: t.chip,
        border: `1px solid ${t.borderSoft}`,
        fontSize: FS_XS,
        fontFamily: FF_MONO,
        color: t.textDim,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
      title={`${side.clusterName} · ${side.namespace ?? "cluster-scoped"} / ${side.name}`}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: clusterAccent(side.colorIdx),
          flexShrink: 0,
        }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
        {side.clusterName}
      </span>
      <span style={{ color: t.textMuted }}>
        {side.namespace ? `${side.namespace}/` : ""}
        {side.name}
      </span>
    </span>
  );
}
