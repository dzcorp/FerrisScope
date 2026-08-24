// Field-by-field comparison across N subjects. Kind-agnostic: it walks the
// parsed manifests, so a CRD compares exactly as well as a Deployment.
//
// Reads the same `stripServerFields` baseline the YAML tab edits, which means
// `status` is absent — this compares DESIRED state. Observed state lives in
// the Events and Pods tabs. Swapping to a lighter strip is a one-line change
// at the `stripServerFields` call in `useInspectDocs`.

import { useMemo, useState } from "react";
import { buildFieldRows, flattenFields } from "../../lib/fieldFlatten";
import {
  clusterAccent,
  FF_MONO,
  FS_SM,
  FS_XS,
  type Tokens,
} from "../../theme";
import { Copyable, Mute } from "../detail";
import { EmptyState } from "../ui";
import type { DocState, InspectSubject } from ".";

const PATH_COL = 320;
const VALUE_COL = 200;
const ROW_H = 30;

export function FieldsTab({
  t,
  subjects,
  docs,
}: {
  t: Tokens;
  subjects: InspectSubject[];
  docs: Map<string, DocState>;
}) {
  const [diffOnly, setDiffOnly] = useState(true);

  // Subjects whose manifest failed are dropped from the grid rather than
  // rendered as a column of blanks — a column of "—" reads as "this field is
  // unset here", which would be a lie.
  const shown = useMemo(
    () => subjects.filter((s) => docs.get(s.sid)?.status === "ok"),
    [subjects, docs],
  );

  const rows = useMemo(() => {
    const maps = shown.map((s) => {
      const d = docs.get(s.sid);
      return d?.status === "ok" ? flattenFields(d.doc) : new Map<string, string>();
    });
    return buildFieldRows(maps);
  }, [shown, docs]);

  const visible = useMemo(
    () => (diffOnly ? rows.filter((r) => r.differs) : rows),
    [rows, diffOnly],
  );

  const gridWidth = PATH_COL + shown.length * VALUE_COL;
  const diffCount = rows.filter((r) => r.differs).length;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 22px",
          borderBottom: `1px solid ${t.borderSoft}`,
          flexShrink: 0,
        }}
      >
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: FS_SM,
            color: t.textDim,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={diffOnly}
            onChange={(e) => setDiffOnly(e.target.checked)}
          />
          Differences only
        </label>
        <span
          style={{ fontSize: FS_XS, color: t.textMuted, fontFamily: FF_MONO }}
        >
          {diffCount} of {rows.length} fields differ
        </span>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          t={t}
          title={diffOnly ? "No differences" : "No fields"}
          hint={
            diffOnly
              ? "Every compared field matches across the selection."
              : "The manifests carry no comparable fields."
          }
        />
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
          {/* Wide grids scroll inside this container; the page never does. */}
          <div style={{ width: gridWidth, minWidth: "100%" }}>
            <div
              style={{
                display: "flex",
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: t.surface,
                borderBottom: `1px solid ${t.border}`,
              }}
            >
              <HeadCell t={t} width={PATH_COL} sticky>
                Field
              </HeadCell>
              {shown.map((s) => (
                <HeadCell key={s.sid} t={t} width={VALUE_COL}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      minWidth: 0,
                    }}
                    title={`${s.clusterName} · ${s.namespace ?? "cluster-scoped"} / ${s.name}`}
                  >
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: "50%",
                        background: clusterAccent(s.colorIdx),
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
                      {s.name}
                    </span>
                  </span>
                </HeadCell>
              ))}
            </div>

            {/* Not virtualized: a manifest stripped of status is on the order
                of a hundred paths, and "differences only" usually cuts that to
                a handful. Virtualizing would buy nothing and cost the ability
                to render without a measured scroll box. */}
            <div>
              {visible.map((row) => {
                return (
                  <div
                    key={row.path}
                    style={{
                      height: ROW_H,
                      display: "flex",
                      alignItems: "center",
                      borderBottom: `1px solid ${t.borderSoft}`,
                      // Differing rows get a rule rather than a fill — a wash
                      // of colour behind most rows would fight the values.
                      borderLeft: `2px solid ${row.differs ? t.accent : "transparent"}`,
                      background: t.surface,
                    }}
                  >
                    <div
                      style={{
                        width: PATH_COL,
                        flexShrink: 0,
                        position: "sticky",
                        left: 0,
                        background: t.surface,
                        padding: "0 12px",
                        fontFamily: FF_MONO,
                        fontSize: FS_XS,
                        color: t.textDim,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={row.path}
                    >
                      {row.path}
                    </div>
                    {row.values.map((v, i) => (
                      <ValueCell key={shown[i]!.sid} t={t} value={v} />
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function HeadCell({
  t,
  width,
  sticky,
  children,
}: {
  t: Tokens;
  width: number;
  sticky?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        width,
        flexShrink: 0,
        padding: "8px 12px",
        fontFamily: FF_MONO,
        fontSize: FS_XS,
        fontWeight: 700,
        color: t.textMuted,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        overflow: "hidden",
        ...(sticky
          ? { position: "sticky" as const, left: 0, background: t.surface, zIndex: 1 }
          : null),
      }}
    >
      {children}
    </div>
  );
}

function ValueCell({ t, value }: { t: Tokens; value: string | null }) {
  return (
    <div
      style={{
        width: VALUE_COL,
        flexShrink: 0,
        padding: "0 12px",
        fontFamily: FF_MONO,
        fontSize: FS_XS,
        color: t.text,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
      title={value ?? undefined}
    >
      {value === null ? (
        <Mute t={t}>—</Mute>
      ) : (
        <Copyable text={value}>
          <span>{value}</span>
        </Copyable>
      )}
    </div>
  );
}
