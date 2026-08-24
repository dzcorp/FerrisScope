// Multi-select Inspect drawer — structured comparison across 2..N objects of
// one kind, armed from the bulk bar.
//
// Sibling to ComparePanel, not a replacement: that one diffs a pair's raw
// manifests in Monaco, this one compares N objects field by field and merges
// their events and pods. Both can be open from the same selection.
//
// Every tab reads from ONE shared fetch of each subject's manifest via
// `getResourceYaml`, which is generic across every kind including CRDs. That
// is why this needs no per-kind dispatch and no backend change.

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { parseYaml, stripServerFields, type Json } from "../../lib/yamlEdit";
import { useResolvedTheme, type SelectionMeta } from "../../store";
import { parseScopedUid } from "../../lib/multiCluster";
import {
  clusterAccent,
  FF_MONO,
  FS_MD,
  FS_SM,
  FS_XS,
  R_MD,
  type ThemeMode,
  type Tokens,
} from "../../theme";
import { ErrorBlock, Icons, IconBtn, LoadingLine, TabButton } from "../ui";
import { FieldsTab } from "./FieldsTab";
import { EventsTab } from "./EventsTab";
import { PodsTab } from "./PodsTab";
import { OBSERVABLE_KIND_IDS } from "../LogPanel";

export type InspectSubject = {
  /// The selection key — `${clusterId}::${uid}`.
  sid: string;
  /// Recovered from `sid`; the events fan-out keys on it.
  uid: string;
  clusterId: string;
  clusterName: string;
  /// Identifies the CLUSTER, not the column — two subjects on one cluster
  /// deliberately share a colour.
  colorIdx: number;
  namespace: string | null;
  name: string;
};

export type InspectTarget = {
  kindId: string;
  kindLabel: string;
  subjects: InspectSubject[];
};

export type InspectTab = "fields" | "events" | "pods";

/// Cap on subjects one drawer fetches. Each is a live apiserver GET, and a
/// 200-row bulk selection would fire 200 of them to feed a grid nobody can
/// read. Overflow is a warning, not an error — same treatment as
/// `MAX_OBSERVE_TARGETS`.
export const MAX_INSPECT_SUBJECTS = 20;

/// Build an inspect target from the current selection. Unlike
/// `compareTargetFromSelection` this iterates `entries()`, because the uid
/// lives in the Map KEY and the events tab needs it.
export function inspectTargetFromSelection(
  selection: Map<string, SelectionMeta>,
  kindId: string,
  kindLabel: string,
  clusterNameFor: (clusterId: string) => string,
  colorIdxFor: (clusterId: string) => number,
): InspectTarget | null {
  if (selection.size < 2) return null;
  const subjects: InspectSubject[] = [];
  for (const [sid, m] of selection.entries()) {
    subjects.push({
      sid,
      uid: parseScopedUid(sid).uid,
      clusterId: m.clusterId,
      clusterName: clusterNameFor(m.clusterId),
      colorIdx: colorIdxFor(m.clusterId),
      namespace: m.namespace,
      name: m.name,
    });
  }
  return { kindId, kindLabel, subjects };
}

export type DocState =
  | { status: "ok"; doc: Json }
  | { status: "error"; message: string };

type DocsState = {
  loading: boolean;
  /// Keyed by subject sid. Absent while still in flight.
  docs: Map<string, DocState>;
  warnings: string[];
};

/// One hook over the whole array — `useSideYaml` is called once per side and
/// so can't go to N (hooks can't run in a loop). Mirrors `useObservedPods`:
/// string-keyed effect, subjects read through a ref so a display-name change
/// doesn't refetch.
export function useInspectDocs(
  kindId: string,
  subjects: InspectSubject[],
  attempt: number,
): DocsState {
  const [state, setState] = useState<DocsState>({
    loading: true,
    docs: new Map(),
    warnings: [],
  });
  const key = subjects
    .map((s) => [s.clusterId, s.namespace ?? "", s.name].join("\u0000"))
    .join("\u0001");
  const subjectsRef = useRef(subjects);
  subjectsRef.current = subjects;

  useEffect(() => {
    let cancelled = false;
    const list = subjectsRef.current;
    setState({ loading: true, docs: new Map(), warnings: [] });

    (async () => {
      const results = await Promise.allSettled(
        list.map((s) =>
          api.getResourceYaml(s.clusterId, kindId, s.namespace, s.name),
        ),
      );
      if (cancelled) return;

      const docs = new Map<string, DocState>();
      const warnings: string[] = [];
      results.forEach((res, i) => {
        const s = list[i]!;
        const label = `${s.clusterName} · ${s.namespace ? `${s.namespace}/` : ""}${s.name}`;
        if (res.status === "rejected") {
          docs.set(s.sid, { status: "error", message: String(res.reason) });
          warnings.push(`${label}: ${String(res.reason)}`);
          return;
        }
        try {
          docs.set(s.sid, {
            status: "ok",
            doc: stripServerFields(parseYaml(res.value)),
          });
        } catch (e) {
          // A manifest we can't parse is one subject's problem, not the
          // comparison's — record it and keep the other columns.
          docs.set(s.sid, { status: "error", message: String(e) });
          warnings.push(`${label}: ${String(e)}`);
        }
      });
      setState({ loading: false, docs, warnings });
    })();

    return () => {
      cancelled = true;
    };
  }, [kindId, key, attempt]);

  return state;
}

type Props = {
  mode: ThemeMode;
  target: InspectTarget;
  onClose: () => void;
};

export function InspectPanel({ mode, target, onClose }: Props) {
  const t = useResolvedTheme().tokens;
  const [tab, setTab] = useState<InspectTab>("fields");
  const [attempt, setAttempt] = useState(0);

  // Cap before fetching, not after — the point is to not fire 200 GETs.
  const { subjects, capWarnings } = useMemo(() => {
    const all = target.subjects;
    if (all.length <= MAX_INSPECT_SUBJECTS) {
      return { subjects: all, capWarnings: [] as string[] };
    }
    return {
      subjects: all.slice(0, MAX_INSPECT_SUBJECTS),
      capWarnings: [
        `selection capped — inspecting the first ${MAX_INSPECT_SUBJECTS} of ${all.length} (narrow the selection for the rest)`,
      ],
    };
  }, [target.subjects]);

  const { loading, docs, warnings } = useInspectDocs(
    target.kindId,
    subjects,
    attempt,
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // A Pods tab over pods themselves would just restate the subjects.
  const hasPods =
    OBSERVABLE_KIND_IDS.has(target.kindId) && target.kindId !== "pods";
  const allWarnings = [...capWarnings, ...warnings];
  const allFailed =
    !loading && subjects.every((s) => docs.get(s.sid)?.status === "error");

  const title =
    subjects
      .slice(0, 3)
      .map((s) => s.name)
      .join(", ") + (subjects.length > 3 ? ` +${subjects.length - 3}` : "");

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
          // The field grid is N columns wide; it needs the room.
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
            padding: "16px 22px 0",
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            flexShrink: 0,
            minWidth: 0,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: FS_XS,
                color: t.textMuted,
                fontFamily: FF_MONO,
                textTransform: "uppercase",
                letterSpacing: 0.6,
              }}
            >
              {subjects.length} {target.kindLabel}
              {subjects.length === 1 ? "" : "s"} · compared
            </div>
            <div
              style={{
                fontSize: FS_MD,
                fontWeight: 600,
                color: t.text,
                letterSpacing: -0.2,
                marginTop: 4,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={subjects.map((s) => s.name).join(", ")}
            >
              {title}
            </div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginTop: 8,
                minWidth: 0,
              }}
            >
              {subjects.map((s) => (
                <SubjectChip key={s.sid} t={t} subject={s} />
              ))}
            </div>
          </div>
          <IconBtn t={t} title="Close (Esc)" onClick={onClose}>
            {Icons.close}
          </IconBtn>
        </header>

        {allWarnings.length > 0 && (
          <div
            style={{
              margin: "10px 22px 0",
              fontFamily: FF_MONO,
              fontSize: FS_XS,
              color: t.warn,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            {allWarnings.slice(0, 4).map((w, i) => (
              <div key={i}>{w}</div>
            ))}
            {allWarnings.length > 4 && (
              <div>+{allWarnings.length - 4} more</div>
            )}
          </div>
        )}

        <div
          style={{
            display: "flex",
            borderBottom: `1px solid ${t.borderSoft}`,
            padding: "10px 12px 0",
            flexShrink: 0,
          }}
        >
          <TabButton
            t={t}
            active={tab === "fields"}
            onClick={() => setTab("fields")}
          >
            Fields
          </TabButton>
          <TabButton
            t={t}
            active={tab === "events"}
            onClick={() => setTab("events")}
          >
            Events
          </TabButton>
          {hasPods && (
            <TabButton
              t={t}
              active={tab === "pods"}
              onClick={() => setTab("pods")}
            >
              Pods
            </TabButton>
          )}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          {loading && (
            <div style={{ padding: "18px 22px" }}>
              <LoadingLine t={t} label="Fetching manifests…" />
            </div>
          )}

          {!loading && allFailed && (
            <div style={{ padding: "18px 22px" }}>
              <ErrorBlock
                t={t}
                message={allWarnings.join("\n") || "every subject failed"}
                kindLabel={target.kindLabel}
              />
              <button
                type="button"
                onClick={() => setAttempt((n) => n + 1)}
                style={{
                  marginTop: 12,
                  border: `1px solid ${t.border}`,
                  background: t.surface,
                  color: t.textDim,
                  height: 28,
                  padding: "0 12px",
                  borderRadius: R_MD,
                  fontSize: FS_SM,
                  fontFamily: "inherit",
                  cursor: "pointer",
                }}
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !allFailed && tab === "fields" && (
            <FieldsTab t={t} subjects={subjects} docs={docs} />
          )}
          {!loading && !allFailed && tab === "events" && (
            <EventsTab t={t} mode={mode} subjects={subjects} />
          )}
          {!loading && !allFailed && tab === "pods" && hasPods && (
            <PodsTab
              t={t}
              mode={mode}
              kindId={target.kindId}
              subjects={subjects}
              docs={docs}
            />
          )}
        </div>
      </div>
    </>
  );
}

function SubjectChip({ t, subject }: { t: Tokens; subject: InspectSubject }) {
  return (
    <span
      title={`${subject.clusterName} · ${subject.namespace ?? "cluster-scoped"} / ${subject.name}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: t.chip,
        border: `1px solid ${t.borderSoft}`,
        borderRadius: R_MD,
        padding: "2px 8px",
        fontFamily: FF_MONO,
        fontSize: FS_XS,
        color: t.textDim,
        maxWidth: 260,
        minWidth: 0,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: clusterAccent(subject.colorIdx),
          flexShrink: 0,
        }}
      />
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {subject.name}
      </span>
    </span>
  );
}
