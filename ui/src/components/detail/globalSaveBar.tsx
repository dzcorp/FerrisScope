// Sticky bar at the bottom of a detail panel that surfaces the session-
// wide pending-changes count plus Save / Cancel. Replaces the per-editor
// Save/Cancel chrome — once the panel is wrapped in <EditSessionProvider>,
// this bar is the single source of truth for committing batched edits.
//
// Hidden when nothing is dirty AND no error / conflict is up. Renders a
// muted backdrop while saving, an amber strip when SSA returned 409 with
// a Force Takeover button, and a red strip on hard errors.

import type { Tokens } from "../../theme";
import { FONT_MONO } from "../../theme";
import { Btn, ErrorBlock } from "../ui";
import { useEditSession } from "./editSession";

export function GlobalSaveBar({ t }: { t: Tokens }) {
  const session = useEditSession();
  if (!session) return null;
  const { dirty, saving, conflict, error, saveAll, cancelAll } = session;
  if (dirty === 0 && !conflict && !error) return null;
  return (
    <div
      style={{
        position: "sticky",
        bottom: 0,
        marginTop: 16,
        marginLeft: -22,
        marginRight: -22,
        padding: "10px 22px",
        background: t.surfaceAlt,
        borderTop: `1px solid ${conflict ? t.warn : error ? t.bad : t.borderSoft}`,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        boxShadow: "0 -8px 24px rgba(0,0,0,0.10)",
        zIndex: 5,
      }}
    >
      {conflict && (
        <ConflictRow t={t} conflict={conflict} />
      )}
      {error && !conflict && (
        <ErrorBlock t={t} message={error} verb="save" inline />
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: 11.5,
            fontFamily: FONT_MONO,
            color: t.textDim,
          }}
        >
          {dirty > 0
            ? `${dirty} pending change${dirty === 1 ? "" : "s"}`
            : conflict
              ? "Save conflicted"
              : "Save failed"}
        </span>
        <span style={{ flex: 1 }} />
        <Btn
          t={t}
          variant="ghost"
          size="sm"
          onClick={cancelAll}
          disabled={saving}
        >
          Cancel
        </Btn>
        {conflict ? (
          <Btn
            t={t}
            variant="primary"
            size="sm"
            onClick={() => saveAll(true)}
            disabled={saving}
            kbd="Force"
          >
            Force takeover
          </Btn>
        ) : (
          <Btn
            t={t}
            variant="primary"
            size="sm"
            onClick={() => saveAll(false)}
            disabled={saving || dirty === 0}
            kbd={saving ? "…" : "↵"}
          >
            Save ({dirty})
          </Btn>
        )}
      </div>
    </div>
  );
}

function ConflictRow({
  t,
  conflict,
}: {
  t: Tokens;
  conflict: { managers: string[]; fields: string[]; message: string };
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 10px",
        border: `1px solid ${t.warn}`,
        background: "rgba(245,158,11,0.10)",
        borderRadius: 4,
      }}
    >
      <div
        style={{
          fontSize: 11.5,
          fontFamily: FONT_MONO,
          color: t.warn,
          fontWeight: 600,
        }}
      >
        SSA conflict
        {conflict.managers.length > 0
          ? ` with ${conflict.managers.join(", ")}`
          : ""}
      </div>
      {conflict.fields.length > 0 && (
        <div
          style={{
            fontSize: 11,
            fontFamily: FONT_MONO,
            color: t.textDim,
            wordBreak: "break-word",
          }}
        >
          {conflict.fields.join(" · ")}
        </div>
      )}
      <div
        style={{
          fontSize: 10.5,
          fontFamily: FONT_MONO,
          color: t.textMuted,
          wordBreak: "break-word",
        }}
      >
        {conflict.message}
      </div>
    </div>
  );
}
