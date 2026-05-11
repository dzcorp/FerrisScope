import { useEffect, useMemo } from "react";
import { useResolvedTheme } from "../../store";
import { useVirtualizer } from "@tanstack/react-virtual";
import { tokens, FF_MONO, type ThemeMode, R_LG, FS_MD, FS_SM, FS_XS } from "../../theme";
import { Eyebrow } from "../ui";
import {
  shouldRenderMessage,
  type ChatViewMessage,
  type ChatViewState,
} from "./chatStreaming";
import { MessageBubble, ThinkingIndicator } from "./MessageBubble";
import { ToolApprovalBulkBar } from "./ToolApprovalBulkBar";
import { ToolApprovalCard } from "./ToolApprovalCard";
import { ToolGroupBubble, type ToolGroupItem } from "./ToolGroupBubble";
import { useStickToBottom } from "./useStickToBottom";

// Virtualized row shape — either a single non-tool message, or a contiguous
// run of tool activity (result messages plus currently-executing tools)
// grouped into one ToolGroupBubble. Grouping turns a chain of N tool calls
// between assistant turns into one card with an internal viewport (latest
// few visible, older ones scroll out), and folding executing entries into
// the same group means an in-flight tool no longer "jumps" from a bottom
// strip into the group when its result lands — it just transitions in
// place from `running` → ✓.
type Row =
  | { kind: "single"; id: string; message: ChatViewMessage }
  | { kind: "toolGroup"; id: string; items: ToolGroupItem[] };

type Props = {
  mode: ThemeMode;
  state: ChatViewState;
  streaming: boolean;
  chatId: string | null;
  compacting: boolean;
};

// 12 px between adjacent bubbles. The original render relied on the parent's
// flex `gap`, but a virtualized list positions rows absolutely so the spacing
// must live inside each row's measured height instead.
const ROW_GAP = 12;

// MessageList — the scrolling transcript. Auto-scroll-to-bottom is owned
// by `useStickToBottom`, which uses pixel distance for stickiness and a
// ResizeObserver for content-growth follow. Rows are virtualized via
// `@tanstack/react-virtual` with `measureElement` because heights vary
// wildly (single-line user message vs. 800 px assistant block with code/
// tables). Footer surfaces (pending approvals, compacting bubble) sit
// below the virtual container — small fixed count, easier than folding
// them into the row array.
export function MessageList({ mode, state, streaming, chatId, compacting }: Props) {
  const t = useResolvedTheme().tokens;
  const { scrollRef, stuck, snapToBottom } = useStickToBottom();
  // Filter out messages that MessageBubble would render as null
  // (settled assistant turns with no text — typically tool-call-only
  // turns whose tool results render below as their own strips, plus
  // EmptyTurn retry phantoms). Keeping them in the virtualizer leaves
  // 12 px paddingBottom-only wrappers stacked between consecutive
  // tool-result groups, which the operator reads as an unexplained
  // gap. The filter is the only consumer of the index, so reordering
  // here doesn't affect anything else (ids stay stable).
  const messages = useMemo(
    () => state.messages.filter(shouldRenderMessage),
    [state.messages],
  );
  // Collapse runs of consecutive tool activity (resolved results +
  // currently-executing entries) into single rows, and float operator
  // messages queued mid-turn AFTER the unified tool group. The "active
  // turn" is the suffix of messages following the most recent assistant
  // message that produced text content — within it, the FIRST user
  // message is the turn's kickoff and any later user messages were
  // queued via `chat_send_message` while the model was busy. Without
  // this deferral the queued users wedge between tool groups (when
  // some tools have resolved) or land in front of the still-running
  // group (when nothing has resolved yet), which is what made the
  // transcript "jump in / out". The group id is keyed off the
  // preceding non-tool, non-queued-user message id so the bubble's
  // expand/collapse state and scroll position survive across queueing
  // and resolution events.
  const rows = useMemo<Row[]>(() => {
    // Active-turn boundary: index after the most recent assistant
    // message with non-empty content. Everything from this index to
    // the end is the in-flight turn (or a fresh queue that the model
    // hasn't started answering yet).
    let activeStart = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "assistant" && (m.content ?? "").trim().length > 0) {
        activeStart = i + 1;
        break;
      }
    }
    // Kickoff = first user message inside the active turn (if any).
    // Everything else of role `user` inside the active turn is queued.
    let kickoffUserId: string | null = null;
    for (let i = activeStart; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.role === "user") {
        kickoffUserId = m.id;
        break;
      }
    }

    type ActiveTool = { parentId: string; items: ToolGroupItem[] };
    const out: Row[] = [];
    let activeTool: ActiveTool | null = null;
    let deferredUsers: ChatViewMessage[] = [];
    let lastNonToolId = "start";

    const flush = () => {
      if (activeTool) {
        out.push({
          kind: "toolGroup",
          id: `group-after-${activeTool.parentId}`,
          items: activeTool.items,
        });
        activeTool = null;
      }
      for (const u of deferredUsers) {
        out.push({ kind: "single", id: u.id, message: u });
      }
      deferredUsers = [];
    };

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      const inActive = i >= activeStart;
      if (m.role === "tool") {
        if (!activeTool) {
          activeTool = { parentId: lastNonToolId, items: [] };
        }
        activeTool.items.push({ kind: "result", message: m });
      } else if (m.role === "user") {
        const isQueued = inActive && m.id !== kickoffUserId;
        if (isQueued) {
          // Defer — render after the active tool group (or after the
          // executing-fold group, if no results have landed yet).
          deferredUsers.push(m);
        } else {
          flush();
          out.push({ kind: "single", id: m.id, message: m });
          lastNonToolId = m.id;
        }
      } else {
        // assistant with content (tool-only assistant turns were
        // filtered upstream by shouldRenderMessage).
        flush();
        out.push({ kind: "single", id: m.id, message: m });
        lastNonToolId = m.id;
      }
    }

    // Fold in-flight tools into the active group (creating one if the
    // model jumped straight to tool calls before any result landed).
    if (state.executing.length > 0) {
      if (!activeTool) {
        activeTool = { parentId: lastNonToolId, items: [] };
      }
      for (const e of state.executing) {
        activeTool.items.push({ kind: "executing", entry: e });
      }
    }
    flush();
    return out;
  }, [messages, state.executing]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Rough seed; `measureElement` refines per-row from the rendered DOM.
    estimateSize: () => 80,
    // Small overscan: the hook's stickiness now reads pixel distance,
    // not range.endIndex, so we no longer need a wide overscan to keep
    // sticky stable. Keeps virtualization work cheap during streaming.
    overscan: 4,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // Force-snap on chat switch — new session always lands at the bottom
  // regardless of where the previous session left the scroll position.
  // The hook's ResizeObserver re-snaps as `measureElement` settles row
  // heights on subsequent frames (markdown highlighter resolving on
  // frames 3-5, etc.), so a single explicit snap here is enough — no
  // multi-timeout retry chain.
  useEffect(() => {
    if (!chatId) return;
    snapToBottom();
    // Intentionally only re-runs on chat switch — content-growth follow
    // within a session is owned by the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const lastIndex = rows.length - 1;
  const showJumpButton = !stuck && rows.length > 0;
  // A streaming assistant bubble owns its own thinking/streaming UI —
  // either the in-bubble dots while content is empty, the ToolCallStrip
  // while tool calls are landing, or the markdown + caret once tokens
  // flow. So a footer placeholder would double up. Only show it when no
  // streaming bubble is live and the chat is otherwise still busy
  // (tools executing) — covers the gap between an assistant turn ending
  // with only tool calls and the next assistant_start firing.
  const hasStreamingBubble = state.messages.some(
    (m) => m.role === "assistant" && m.streaming,
  );
  const showThinkingPlaceholder =
    !hasStreamingBubble && state.executing.length > 0;

  return (
    <>
      <div
        ref={scrollRef}
        style={{
          position: "absolute",
          inset: 0,
          overflowY: "auto",
          padding: "16px 16px 8px",
          display: "flex",
          flexDirection: "column",
          gap: ROW_GAP,
          // Hint the compositor that scrolling this container is a hot
          // path. Combined with `contain: content` on each bubble, this
          // keeps long histories scrolling on the GPU instead of forcing
          // a full repaint of the dock surface on every scroll tick.
          willChange: "scroll-position",
          contain: "content",
        }}
      >
        {rows.length === 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: 1,
              color: t.textMuted,
              fontSize: FS_MD,
              textAlign: "center",
              padding: 24,
            }}
          >
            <div>
              <Eyebrow t={t}>Cluster-aware AI chat</Eyebrow>
              <div style={{ marginTop: 6, fontFamily: FF_MONO }}>
                Ask anything about this cluster.
              </div>
            </div>
          </div>
        )}
        {rows.length > 0 && (
          <div
            style={{
              position: "relative",
              height: totalSize,
              width: "100%",
              // Disable the parent's flex sizing for this slot — virtualized
              // rows are positioned absolutely and `flex-shrink: 1` would
              // collapse the slot below `totalSize` and clip them.
              flex: "0 0 auto",
            }}
          >
            {virtualItems.map((vi) => {
              const r = rows[vi.index];
              if (!r) return null;
              // Each row's measured height includes a 12 px gap below it,
              // so the next row sits exactly `ROW_GAP` below — except the
              // last row, where the parent's flex `gap` already handles the
              // spacing to the footer.
              const isLast = vi.index === lastIndex;
              return (
                <div
                  key={r.id}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${vi.start}px)`,
                    paddingBottom: isLast ? 0 : ROW_GAP,
                  }}
                >
                  {r.kind === "single" ? (
                    <MessageBubble mode={mode} message={r.message} />
                  ) : (
                    <ToolGroupBubble mode={mode} items={r.items} />
                  )}
                </div>
              );
            })}
          </div>
        )}
        {showThinkingPlaceholder && <ThinkingPlaceholder t={t} />}
        {chatId &&
          state.pendingApprovals.map((p) => (
            <ToolApprovalCard
              key={p.toolCallId}
              mode={mode}
              chatId={chatId}
              approval={p}
            />
          ))}
        {chatId && state.pendingApprovals.length > 1 && (
          <ToolApprovalBulkBar
            mode={mode}
            chatId={chatId}
            approvals={state.pendingApprovals}
          />
        )}
        {compacting && <CompactingBubble t={t} />}
      </div>
      {showJumpButton && (
        <JumpToLatestButton t={t} streaming={streaming} onClick={snapToBottom} />
      )}
    </>
  );
}

// Floating affordance shown when the operator has scrolled away from
// the bottom while the transcript keeps growing. Click → snap to the
// latest message and resume auto-follow. Bottom-centre so it doesn't
// collide with right-side scrollbars on long transcripts.
function JumpToLatestButton({
  t,
  streaming,
  onClick,
}: {
  t: ReturnType<typeof tokens>;
  streaming: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: "absolute",
        bottom: 12,
        left: "50%",
        transform: "translateX(-50%)",
        background: t.surface,
        border: `1px solid ${t.borderSoft}`,
        borderRadius: R_LG,
        padding: "5px 12px",
        fontFamily: FF_MONO,
        fontSize: FS_SM,
        color: t.text,
        cursor: "pointer",
        boxShadow: "0 2px 8px rgba(15,20,30,0.18)",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        zIndex: 2,
      }}
    >
      <span style={{ color: t.accent, fontWeight: 700 }}>↓</span>
      <span>{streaming ? "follow latest" : "jump to latest"}</span>
    </button>
  );
}

// ThinkingPlaceholder — assistant-style bubble shown while tools are
// executing and no streaming bubble is currently live. Bridges the gap
// from "model finished emitting tool calls" → "tools running" →
// "model resumes" so the thinking indicator doesn't blink off and on
// between rounds. Mirrors the assistant bubble silhouette so the swap
// to a real bubble on the next assistant_start is visually seamless.
function ThinkingPlaceholder({ t }: { t: ReturnType<typeof tokens> }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-start",
        gap: 8,
        // Soft fade-in on first mount so the placeholder appears as a
        // continuation rather than a sudden insertion.
        animation: "fs-fade-in 200ms ease-out",
      }}
    >
      <div
        style={{
          maxWidth: "92%",
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: R_LG,
          padding: "9px 13px 10px",
          color: t.text,
          fontSize: FS_MD,
          lineHeight: 1.55,
          boxShadow: "0 1px 3px rgba(15,20,30,0.05)",
        }}
      >
        <div
          style={{
            fontFamily: FF_MONO,
            fontSize: FS_XS,
            color: t.textDim,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            marginBottom: 5,
            fontWeight: 700,
            opacity: 0.85,
          }}
        >
          assistant
        </div>
        <ThinkingIndicator t={t} />
      </div>
    </div>
  );
}

// Animated placeholder bubble shown as the latest message while a
// compaction call is in flight. Visually mirrors an assistant bubble
// so the operator reads it as "the agent is doing something" — three
// dots pulse to telegraph progress on a call that can take 5–15 s.
function CompactingBubble({ t }: { t: ReturnType<typeof tokens> }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-start", gap: 8 }}>
      <div
        style={{
          maxWidth: "92%",
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: R_LG,
          padding: "9px 13px 10px",
          color: t.text,
          fontSize: FS_MD,
          lineHeight: 1.55,
          boxShadow: "0 1px 3px rgba(15,20,30,0.05)",
        }}
      >
        <div
          style={{
            fontFamily: FF_MONO,
            fontSize: FS_XS,
            color: t.textDim,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            marginBottom: 5,
            fontWeight: 700,
            opacity: 0.85,
          }}
        >
          Compacting
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            color: t.textDim,
            fontSize: FS_MD,
          }}
        >
          <span>summarising older context</span>
          <span style={{ display: "inline-flex", gap: 3 }}>
            <Dot t={t} delay={0} />
            <Dot t={t} delay={150} />
            <Dot t={t} delay={300} />
          </span>
        </div>
        <style>{`
          @keyframes fs-compact-dot {
            0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
            30% { opacity: 1; transform: translateY(-2px); }
          }
        `}</style>
      </div>
    </div>
  );
}

function Dot({
  t,
  delay,
}: {
  t: ReturnType<typeof tokens>;
  delay: number;
}) {
  return (
    <span
      style={{
        width: 5,
        height: 5,
        borderRadius: "50%",
        background: t.accent,
        display: "inline-block",
        animation: `fs-compact-dot 1.2s ${delay}ms infinite ease-in-out`,
      }}
    />
  );
}
