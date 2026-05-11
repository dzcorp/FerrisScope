import { memo, useMemo, useState } from "react";
import { useResolvedTheme } from "../../store";
import { api } from "../../api";
import { FF_MONO, type ThemeMode, R_MD, FS_MD, FS_SM, FS_XS } from "../../theme";
import { Btn, ErrorBlock } from "../ui";
import { useCopyFlash } from "../detail/primitives";
import type { PendingApproval } from "./chatStreaming";

type Props = {
  mode: ThemeMode;
  chatId: string;
  approval: PendingApproval;
};

// ToolApprovalCard — inline card for an outstanding write/destructive tool
// call. Three actions: Approve once, Approve always (remember name for the
// rest of the chat), Deny. The arguments JSON is shown pretty-printed so
// the operator can read what's about to happen before clicking.
//
// Wrapped in `memo` because MessageList re-renders on every chat-state tick
// (token deltas during streaming, executing-strip churn, …) and the reducer
// keeps `PendingApproval` references stable across unrelated events. Without
// memoization a visible approval card re-runs `formatArgs` (JSON parse +
// stringify) on every reducer dispatch — enough JSON work to noticeably
// stutter scrolling while a card is on screen.
function ToolApprovalCardInner({ chatId, approval }: Props) {
  const t = useResolvedTheme().tokens;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Pulse the pretty-args block after a successful clipboard write so the
  // operator sees acknowledgement without a toast. Same pattern as
  // <Copyable> in detail primitives.
  const [argsPreRef, flashArgs] = useCopyFlash<HTMLPreElement>();

  const pretty = useMemo(() => formatArgs(approval.arguments), [approval.arguments]);

  const copyArgs = () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(pretty)
      .then(() => flashArgs())
      .catch(() => {});
  };

  const decide = async (
    decision: "approved" | "approved_always" | "denied",
  ) => {
    setBusy(true);
    setError(null);
    try {
      await api.chatApproveToolCall(chatId, approval.toolCallId, decision);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-start",
        gap: 8,
      }}
    >
      <div
        // `fs-selectable` opts the whole card body — tool name, arguments
        // JSON, error text — back into text selection (the global
        // `body { user-select: none }` rule otherwise blocks it). Lets
        // operators select+copy a path/manifest snippet from the args
        // before deciding, or grab the tool name into search.
        className="fs-selectable"
        style={{
          maxWidth: "92%",
          flex: 1,
          background: t.surfaceAlt,
          border: `1px solid ${t.warn}66`,
          borderLeft: `3px solid ${t.warn}`,
          borderRadius: R_MD,
          padding: "10px 12px",
          fontFamily: FF_MONO,
          // Paint containment isolates the card's repaints (busy state
          // toggle, error banner appearing) from the surrounding list so
          // a card visible mid-scroll doesn't force the whole transcript
          // to repaint.
          contain: "content",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <span style={{ color: t.warn, fontWeight: 600, fontSize: FS_SM }}>
            ⚠ APPROVAL REQUIRED
          </span>
          <span style={{ color: t.text, fontSize: FS_MD, flex: 1, minWidth: 0 }}>
            {approval.name}
          </span>
          <button
            type="button"
            onClick={copyArgs}
            title="Copy arguments JSON"
            style={{
              background: "transparent",
              border: `1px solid ${t.borderSoft}`,
              borderRadius: R_MD,
              color: t.textDim,
              fontFamily: FF_MONO,
              fontSize: FS_XS,
              padding: "2px 6px",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            copy
          </button>
        </div>
        <pre
          ref={argsPreRef}
          className="fs-selectable"
          style={{
            margin: 0,
            padding: "6px 8px",
            background: t.surface,
            border: `1px solid ${t.borderSoft}`,
            borderRadius: R_MD,
            color: t.text,
            fontFamily: FF_MONO,
            fontSize: FS_SM,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 240,
            overflow: "auto",
            contain: "content",
          }}
        >
          {pretty}
        </pre>
        {error && (
          <div style={{ marginTop: 6 }}>
            <ErrorBlock
              t={t}
              message={error}
              kindLabel="tool approval"
              verb="save"
              inline
            />
          </div>
        )}
        <div
          style={{
            marginTop: 8,
            display: "flex",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          <Btn
            t={t}
            variant="primary"
            size="sm"
            onClick={() => decide("approved")}
            disabled={busy}
          >
            Approve
          </Btn>
          <Btn
            t={t}
            variant="secondary"
            size="sm"
            onClick={() => decide("approved_always")}
            disabled={busy}
          >
            Approve always
          </Btn>
          <Btn
            t={t}
            variant="ghost"
            size="sm"
            onClick={() => decide("denied")}
            disabled={busy}
          >
            Deny
          </Btn>
        </div>
      </div>
    </div>
  );
}

export const ToolApprovalCard = memo(ToolApprovalCardInner);

function formatArgs(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "(no arguments)";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return raw;
  }
}
