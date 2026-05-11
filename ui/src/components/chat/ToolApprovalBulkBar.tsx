import { memo, useState } from "react";
import { useResolvedTheme } from "../../store";
import { api } from "../../api";
import { FF_MONO, type ThemeMode, R_MD, FS_SM } from "../../theme";
import { Btn, ErrorBlock } from "../ui";
import type { ApprovalDecision } from "../../types";
import type { PendingApproval } from "./chatStreaming";

type Props = {
  mode: ThemeMode;
  chatId: string;
  approvals: PendingApproval[];
};

// ToolApprovalBulkBar — single footer card shown below the stack of
// individual ToolApprovalCards when more than one approval is pending.
// Sits last so the chat's stick-to-bottom keeps the bulk action
// visible at the viewport edge — the operator scrolls up through the
// per-call cards to audit arguments, then drops the cursor onto the
// bulk action without scrolling further.
//
// The model frequently emits multiple parallel write calls in a
// single turn (e.g. apply N manifests, scale K deployments); clicking
// through each card individually is mechanical and slow. The bulk bar
// fans out the same decision across every currently-pending approval
// in one click. The per-call cards stay rendered above so the
// operator can still inspect arguments, or override one specific call
// with a different decision before pressing the bulk action.
//
// Mechanics:
//  - Snapshot the ids at click-time so an approval that arrives mid-
//    batch (rare but possible — backend can emit additional approval
//    requests while we're still resolving earlier ones) is NOT silently
//    decided. The operator sees the new card and decides explicitly.
//  - `Promise.allSettled` so a single backend rejection doesn't abandon
//    the rest of the batch. We surface the count of failures; the
//    matching cards stay visible so the operator can retry them
//    individually.
//  - `decideAll("approved_always")` repeats the "remember name" flag
//    for every call. Repeated remembers for the same name are a no-op
//    on the backend, so this is safe even when the batch has
//    duplicates.
function ToolApprovalBulkBarInner({ chatId, approvals }: Props) {
  const t = useResolvedTheme().tokens;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decideAll = async (decision: ApprovalDecision) => {
    setBusy(true);
    setError(null);
    const ids = approvals.map((a) => a.toolCallId);
    const results = await Promise.allSettled(
      ids.map((id) => api.chatApproveToolCall(chatId, id, decision)),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      const first = results.find(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      const detail = first ? String(first.reason) : "unknown error";
      setError(
        failed === ids.length
          ? `All ${failed} requests failed: ${detail}`
          : `${failed} of ${ids.length} failed: ${detail}`,
      );
    }
    setBusy(false);
  };

  // Distinct tool name list — operators want a glance-readable summary
  // of "what kinds am I about to approve" without scrolling each card.
  // Cap to a few names + a "(+N more)" suffix so the strip stays
  // single-row even when the batch is large.
  const uniqueNames = Array.from(new Set(approvals.map((a) => a.name)));
  const namesPreview =
    uniqueNames.length <= 4
      ? uniqueNames.join(", ")
      : `${uniqueNames.slice(0, 4).join(", ")} +${uniqueNames.length - 4} more`;

  return (
    <div
      // Match the per-card text-selection opt-in so an operator can grab
      // the tool name list ("foo, bar +3 more") from the header before
      // deciding.
      className="fs-selectable"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 12px",
        background: t.surfaceAlt,
        border: `1px solid ${t.warn}66`,
        borderLeft: `3px solid ${t.warn}`,
        borderRadius: R_MD,
        fontFamily: FF_MONO,
        contain: "content",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ color: t.warn, fontWeight: 600, fontSize: FS_SM }}>
          ⚠ {approvals.length} APPROVALS PENDING
        </span>
        <span
          style={{
            color: t.textDim,
            fontSize: FS_SM,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
            minWidth: 0,
          }}
          title={uniqueNames.join(", ")}
        >
          {namesPreview}
        </span>
      </div>
      {error && (
        <ErrorBlock
          t={t}
          message={error}
          kindLabel="tool approval"
          verb="save"
          inline
        />
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Btn
          t={t}
          variant="primary"
          size="sm"
          onClick={() => decideAll("approved")}
          disabled={busy}
        >
          Approve all ({approvals.length})
        </Btn>
        <Btn
          t={t}
          variant="secondary"
          size="sm"
          onClick={() => decideAll("approved_always")}
          disabled={busy}
        >
          Approve all & remember
        </Btn>
        <Btn
          t={t}
          variant="ghost"
          size="sm"
          onClick={() => decideAll("denied")}
          disabled={busy}
        >
          Deny all
        </Btn>
      </div>
    </div>
  );
}

export const ToolApprovalBulkBar = memo(ToolApprovalBulkBarInner);
