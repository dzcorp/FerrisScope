import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { tokens, FONT_MONO, type ThemeMode } from "../../theme";
import { Eyebrow } from "../ui";
import type { ChatViewState, ExecutingToolCall } from "./chatStreaming";
import { MessageBubble } from "./MessageBubble";
import { ToolApprovalCard } from "./ToolApprovalCard";

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

// MessageList — the scrolling transcript. Auto-scrolls to bottom on new
// messages while the operator is already at the bottom; respects the scroll
// position otherwise so they can read backscroll while the model streams.
//
// Rows are virtualized via `@tanstack/react-virtual` with `measureElement`
// because heights vary wildly (single-line user message vs. 800 px assistant
// block with code/tables). The footer surfaces (executing strip, pending
// approvals, compacting bubble) stay non-virtualized below the virtual
// container — small fixed count, easier than folding them into the row array.
export function MessageList({ mode, state, streaming, chatId, compacting }: Props) {
  const t = tokens(mode);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const messages = state.messages;

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    // Rough seed; `measureElement` refines per-row from the rendered DOM.
    estimateSize: () => 80,
    overscan: 8,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // useLayoutEffect runs after DOM mutation but before paint, so any
  // height changes from this render are visible to the virtualizer when
  // we ask it to scroll.
  //
  // Deps key off the reducer's reference identity: every event that
  // could change rendered height (token_delta, tool_call_*, tool_result,
  // approval_request, …) returns a fresh `messages` / `toolBuffers` /
  // `pendingApprovals` reference, so referential equality is enough —
  // no need to walk the array building a fingerprint string on every
  // render.
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    if (messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
    }
    // The footer (executing strip, pending approvals, compacting bubble)
    // sits below the virtualized region; nudge the scroll element to its
    // raw `scrollHeight` on the next frame so footer content lands in
    // view too. Cheap — one rAF, no observers.
    const raf = requestAnimationFrame(() => {
      if (!stickToBottomRef.current) return;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [
    messages,
    state.toolBuffers,
    state.pendingApprovals,
    state.executing,
    compacting,
    virtualizer,
  ]);

  // Session-load snap. Force sticky on chat switch so the new session
  // always lands at the bottom regardless of where the previous session
  // left the ref. `measureElement` corrects positions as bubble heights
  // settle (markdown highlighter resolving on frames 3-5, etc.) without
  // the multi-timeout retry the manual scroll path used to need.
  useEffect(() => {
    if (!chatId) return;
    stickToBottomRef.current = true;
    if (messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: "end" });
    }
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
    // Intentionally only re-runs on chat switch — height changes within a
    // session are handled by the layout effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  const onScroll = () => {
    if (messages.length === 0) {
      stickToBottomRef.current = true;
      return;
    }
    const range = virtualizer.range;
    if (!range) return;
    // Sticky while the last message (or the footer beneath it) is in the
    // visible window. The virtualizer's range tracks which message indexes
    // are currently rendered, so `endIndex >= count - 1` is a precise
    // equivalent of the old "scrollHeight - scrollTop - clientHeight < 24"
    // slop without depending on raw scroll math.
    stickToBottomRef.current = range.endIndex >= messages.length - 1;
  };

  const lastIndex = messages.length - 1;

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
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
      {messages.length === 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flex: 1,
            color: t.textMuted,
            fontSize: 12,
            textAlign: "center",
            padding: 24,
          }}
        >
          <div>
            <Eyebrow t={t}>Cluster-aware AI chat</Eyebrow>
            <div style={{ marginTop: 6, fontFamily: FONT_MONO }}>
              Ask anything about this cluster.
            </div>
          </div>
        </div>
      )}
      {messages.length > 0 && (
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
            const m = messages[vi.index];
            if (!m) return null;
            // Each row's measured height includes a 12 px gap below it,
            // so the next row sits exactly `ROW_GAP` below — except the
            // last row, where the parent's flex `gap` already handles the
            // spacing to the footer.
            const isLast = vi.index === lastIndex;
            return (
              <div
                key={m.id}
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
                <MessageBubble mode={mode} message={m} />
              </div>
            );
          })}
        </div>
      )}
      {state.executing.length > 0 && (
        <ExecutingStrip t={t} executing={state.executing} />
      )}
      {chatId &&
        state.pendingApprovals.map((p) => (
          <ToolApprovalCard
            key={p.toolCallId}
            mode={mode}
            chatId={chatId}
            approval={p}
          />
        ))}
      {compacting && <CompactingBubble t={t} />}
      {streaming &&
        messages.length > 0 &&
        // No-op visual: the streaming caret lives inside the MessageBubble
        // for the in-flight assistant. Kept this slot here so future
        // surfaces (token usage, "thinking…" indicator) have a home.
        null}
    </div>
  );
}

// ExecutingStrip — silhouette mirrors the streaming `› calling X` strip but
// fires *after* the call shape lands and the dispatch starts. Stays visible
// until the matching tool_result lands. A second-resolution elapsed counter
// reassures the operator that something's happening on the long ones (port-
// forward setup, ssh handshakes, http_fetch hitting a slow target).
function ExecutingStrip({
  t,
  executing,
}: {
  t: ReturnType<typeof tokens>;
  executing: ExecutingToolCall[];
}) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const now = Date.now();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        color: t.textMuted,
        fontFamily: FONT_MONO,
        fontSize: 11,
        flexWrap: "wrap",
      }}
    >
      <span style={{ color: t.textDim }}>›</span>
      <span>running</span>
      {executing.map((e, i) => {
        const secs = Math.max(0, Math.floor((now - e.startedAt) / 1000));
        return (
          <span key={e.toolCallId} style={{ display: "inline-flex", gap: 4 }}>
            <span style={{ color: t.accent, fontWeight: 600 }}>{e.name}</span>
            <span style={{ color: t.textDim }}>{secs}s</span>
            {i < executing.length - 1 && <span>,</span>}
          </span>
        );
      })}
      <span
        style={{
          display: "inline-block",
          width: 6,
          height: 10,
          background: t.accent,
          animation: "fs-blink 1.1s steps(2, start) infinite",
        }}
      />
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
          borderRadius: 10,
          padding: "9px 13px 10px",
          color: t.text,
          fontSize: 13,
          lineHeight: 1.55,
          boxShadow: "0 1px 3px rgba(15,20,30,0.05)",
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
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
            fontSize: 12,
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
