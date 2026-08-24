// Merged event stream across the selection — one chronological list, each row
// tagged with the object it belongs to.
//
// Fan-out is the only correct shape here: the apiserver's field selector is
// single-value equality on `involvedObject.uid` and selector terms AND-join,
// so `uid=a,uid=b` matches nothing. One call per subject also keeps the
// namespaced Event API that `list_object_events_cmd` deliberately uses, rather
// than needing cluster-wide Event permissions.

import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { DETAIL_POLL_MS } from "../detail/detailPoll";
import {
  clusterAccent,
  FF_MONO,
  FS_SM,
  FS_XS,
  type ThemeMode,
  type Tokens,
} from "../../theme";
import { EmptyState, ErrorBlock, LoadingLine, StatusPill } from "../ui";
import { ageFromIso } from "../detail";
import type { ResourceRow } from "../../types";
import type { InspectSubject } from ".";

type Tagged = { row: ResourceRow; subject: InspectSubject };

type State =
  | { kind: "loading" }
  | { kind: "ready"; rows: Tagged[]; warnings: string[] }
  | { kind: "error"; message: string };

export function EventsTab({
  t,
  mode,
  subjects,
}: {
  t: Tokens;
  mode: ThemeMode;
  subjects: InspectSubject[];
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [, setTick] = useState(0);
  const subjectsRef = useRef(subjects);
  subjectsRef.current = subjects;
  const key = subjects.map((s) => s.sid).join("\u0001");

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const load = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      const list = subjectsRef.current;
      try {
        const results = await Promise.allSettled(
          list.map((s) =>
            api.listObjectEvents(s.clusterId, s.namespace, s.uid),
          ),
        );
        if (cancelled) return;

        const rows: Tagged[] = [];
        const warnings: string[] = [];
        results.forEach((res, i) => {
          const subject = list[i]!;
          if (res.status === "rejected") {
            warnings.push(`${subject.name}: ${String(res.reason)}`);
            return;
          }
          for (const row of res.value) {
            // Defensive re-filter, same as the per-object Events tab: a proxy
            // that ignores the field selector would otherwise hand us the
            // whole namespace.
            if (row.involved_uid === subject.uid) rows.push({ row, subject });
          }
        });
        rows.sort((a, b) =>
          String(b.row.last_seen ?? "").localeCompare(
            String(a.row.last_seen ?? ""),
          ),
        );
        setState({ kind: "ready", rows, warnings });
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: String(e) });
      } finally {
        inFlight = false;
      }
    };

    void load();
    const poll = setInterval(() => void load(), DETAIL_POLL_MS);
    // Ages are relative; re-render once a second so they stay honest between
    // polls without refetching.
    const tick = setInterval(() => setTick((n) => n + 1), 1000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [key]);

  if (state.kind === "loading") {
    return (
      <div style={{ padding: "18px 22px" }}>
        <LoadingLine t={t} label="Loading events…" />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div style={{ padding: "18px 22px" }}>
        <ErrorBlock t={t} message={state.message} kindLabel="events" />
      </div>
    );
  }
  if (state.rows.length === 0) {
    return (
      <EmptyState
          t={t}
        title="No events"
        hint={
          state.warnings.length > 0
            ? state.warnings.join("\n")
            : "None of the selected objects has recent events. The apiserver keeps them for about an hour."
        }
      />
    );
  }

  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      {state.warnings.length > 0 && (
        <div
          style={{
            padding: "8px 22px 0",
            fontFamily: FF_MONO,
            fontSize: FS_XS,
            color: t.warn,
          }}
        >
          {state.warnings.slice(0, 4).map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: FS_SM,
          tableLayout: "fixed",
        }}
      >
        <thead>
          <tr>
            {HEADERS.map(([label, width]) => (
              <th
                key={label}
                style={{
                  width: width ?? undefined,
                  textAlign: "left",
                  padding: "8px 12px",
                  position: "sticky",
                  top: 0,
                  background: t.surface,
                  borderBottom: `1px solid ${t.border}`,
                  fontFamily: FF_MONO,
                  fontSize: FS_XS,
                  fontWeight: 700,
                  color: t.textMuted,
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                }}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state.rows.map(({ row, subject }) => (
            <tr
              key={row.uid}
              style={{ borderBottom: `1px solid ${t.borderSoft}` }}
            >
              <td style={{ padding: "6px 12px", overflow: "hidden" }}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    minWidth: 0,
                    fontFamily: FF_MONO,
                    fontSize: FS_XS,
                    color: t.textDim,
                  }}
                  title={`${subject.clusterName} · ${subject.namespace ?? ""}/${subject.name}`}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
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
              </td>
              <td style={{ padding: "6px 12px" }}>
                <StatusPill
                  status={String(row.type ?? "Normal")}
                  t={t}
                  mode={mode}
                  dense
                />
              </td>
              <td
                style={{
                  padding: "6px 12px",
                  fontFamily: FF_MONO,
                  fontSize: FS_XS,
                  color: t.textDim,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {String(row.reason ?? "")}
              </td>
              <td style={{ padding: "6px 12px", color: t.text }}>
                {String(row.message ?? "")}
              </td>
              <td
                style={{
                  padding: "6px 12px",
                  fontFamily: FF_MONO,
                  fontSize: FS_XS,
                  color: t.textMuted,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {typeof row.count === "number" && row.count > 1
                  ? `×${row.count}`
                  : ""}
              </td>
              <td
                style={{
                  padding: "6px 12px",
                  fontFamily: FF_MONO,
                  fontSize: FS_XS,
                  color: t.textMuted,
                }}
              >
                {typeof row.last_seen === "string"
                  ? ageFromIso(row.last_seen)
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const HEADERS: [string, number | null][] = [
  ["Object", 180],
  ["Type", 90],
  ["Reason", 160],
  ["Message", null],
  ["Count", 70],
  ["Age", 80],
];
