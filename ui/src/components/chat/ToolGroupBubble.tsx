import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useResolvedTheme } from "../../store";
import { FF_MONO, type ThemeMode, type Tokens, R_LG, R_MD, FS_SM } from "../../theme";
import type { ChatViewMessage, ExecutingToolCall } from "./chatStreaming";

// A row inside a tool group is either a resolved result message or an
// in-flight execution (running tool, no result yet). Folding both into
// one item list means the bubble can show a tool transition from
// `running` → `done` in-place without the row jumping from a separate
// strip into the group.
export type ToolGroupItem =
  | { kind: "result"; message: ChatViewMessage }
  | { kind: "executing"; entry: ExecutingToolCall };

type Props = {
  mode: ThemeMode;
  items: ToolGroupItem[];
};

// Approximate single-row height of the strip below. Used as the
// collapsed-mode viewport unit so the latest N rows are visible. Each
// strip is one line of mono text with small padding, so the constant
// stays reliable; the viewport's smooth scroll only needs an
// upper-bound clip height to feel right.
const ROW_HEIGHT = 28;
// Operator can see up to this many tool rows at a glance before the
// viewport starts scrolling older ones out of view. Three is a good
// balance — gives context for the current call plus the previous two
// without crowding the transcript.
const MAX_VISIBLE_ROWS = 3;

// Stable React key for an item. Tied to the underlying tool_call_id (or
// the message id as a fallback) so a transition from `executing` →
// `result` re-renders the same component in place, instead of
// remounting (which would lose any animation continuity).
function itemKey(item: ToolGroupItem): string {
  if (item.kind === "result") {
    return item.message.toolCallId ?? item.message.id;
  }
  return item.entry.toolCallId;
}

// ToolGroupBubble — wraps a contiguous run of tool activity (result
// messages plus in-flight executions) in one collapsible card.
// Collapsed: a viewport showing the latest few rows; older ones scroll
// out of view smoothly. Expanded: every row stacked, each individually
// expandable into its payload.
function ToolGroupBubbleInner({ items }: Props) {
  const t = useResolvedTheme().tokens;
  const [expanded, setExpanded] = useState(false);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const viewportRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Track the last key we've reacted to so we only animate on genuine
  // arrivals (not on parent re-renders or expand toggles). Seeded on
  // first mount so loading a long transcript doesn't strobe every row.
  const lastSeenKeyRef = useRef<string | null>(null);
  const initializedRef = useRef(false);

  const latest = items[items.length - 1];
  const total = items.length;
  const errorCount = items.reduce(
    (n, it) => (it.kind === "result" && it.message.toolIsError ? n + 1 : n),
    0,
  );
  const runningCount = items.reduce(
    (n, it) => (it.kind === "executing" ? n + 1 : n),
    0,
  );

  // Tick once per second while at least one tool is running, so the
  // elapsed-time chip in ExecutingRow stays current. Skip the interval
  // entirely when nothing's running — no point churning React state.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (runningCount === 0) return;
    const id = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [runningCount]);

  // Snap to bottom on initial mount, smooth-scroll on subsequent arrivals.
  // Also flash the card and tag the freshly-mounted row so its enter
  // animation plays. useLayoutEffect because we want the snap to happen
  // before the browser paints — otherwise the viewport flashes the top
  // of the stack for one frame.
  useLayoutEffect(() => {
    if (!latest) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const latestKey = itemKey(latest);
    if (!initializedRef.current) {
      initializedRef.current = true;
      lastSeenKeyRef.current = latestKey;
      viewport.scrollTop = viewport.scrollHeight;
      return;
    }
    if (lastSeenKeyRef.current === latestKey) return;
    lastSeenKeyRef.current = latestKey;
    // Smooth-scroll the viewport's last child into view.
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    // Restart the new-row enter animation by removing+adding the class.
    const lastChild = viewport.lastElementChild as HTMLElement | null;
    if (lastChild) {
      lastChild.classList.remove("fs-tool-row-enter");
      void lastChild.offsetWidth;
      lastChild.classList.add("fs-tool-row-enter");
    }
    // Pulse the card border.
    const card = cardRef.current;
    if (card) {
      card.classList.remove("fs-tool-group-flash");
      void card.offsetWidth;
      card.classList.add("fs-tool-group-flash");
    }
  }, [latest && itemKey(latest)]);

  // When expanded, immediately after the transition completes, jump
  // scroll back to the latest so the bottom of the list stays anchored.
  useEffect(() => {
    if (!expanded) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [expanded]);

  if (!latest) return null;

  const toggleOpen = (key: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div
      ref={cardRef}
      style={{
        display: "flex",
        flexDirection: "column",
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: R_LG,
        boxShadow: "0 1px 2px rgba(15,20,30,0.04)",
        // Paint containment: the viewport's scroll + the row enter
        // animation shouldn't bleed paint into sibling bubbles.
        contain: "content",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 10px",
          background: "transparent",
          border: "none",
          borderBottom: expanded ? `1px solid ${t.borderSoft}` : "none",
          color: t.textMuted,
          fontFamily: FF_MONO,
          fontSize: FS_SM,
          cursor: "pointer",
          textAlign: "left",
          width: "100%",
        }}
        title={expanded ? "Collapse tool group" : "Expand tool group"}
      >
        <span style={{ color: t.textDim, width: 8 }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span style={{ color: t.textDim, letterSpacing: 0.4 }}>
          {total} tool {total === 1 ? "call" : "calls"}
        </span>
        {runningCount > 0 && (
          <span style={{ color: t.accent, fontWeight: 600 }}>
            {runningCount} running
          </span>
        )}
        {errorCount > 0 && (
          <span style={{ color: t.bad, fontWeight: 600 }}>
            {errorCount} failed
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!expanded && total > MAX_VISIBLE_ROWS && (
          <span style={{ color: t.textDim, opacity: 0.8 }}>
            showing latest {MAX_VISIBLE_ROWS}
          </span>
        )}
      </button>
      <div
        ref={viewportRef}
        style={{
          // Collapsed: clip to N rows so the latest few stay in view;
          // programmatic scrollTop still works on overflow: hidden, and
          // scroll-behavior: smooth animates it. Expanded: let the stack
          // take its natural height.
          maxHeight: expanded ? "none" : ROW_HEIGHT * MAX_VISIBLE_ROWS,
          overflow: "hidden",
          scrollBehavior: "smooth",
          transition: "max-height 220ms ease",
          padding: "2px 6px",
        }}
      >
        {items.map((item) => {
          const key = itemKey(item);
          return (
            <ToolRow
              key={key}
              t={t}
              item={item}
              open={openIds.has(key)}
              onToggle={() => toggleOpen(key)}
              expanded={expanded}
            />
          );
        })}
      </div>
    </div>
  );
}

export const ToolGroupBubble = memo(ToolGroupBubbleInner);

// ToolRow — single tool strip inside the group. Handles both states:
//   - `executing`: tool has cleared approval and is running; renders a
//     pulsing accent dot + "running Xs" elapsed counter, no payload
//     expand (no content yet).
//   - `result`: tool finished; renders ✓/✗ + name + preview + line
//     count, click to expand the payload (only when the group itself
//     is also expanded — collapsed view clips per-row height anyway).
// Keying both states under the same tool_call_id means the transition
// is an in-place update, not a remount.
function ToolRow({
  t,
  item,
  open,
  onToggle,
  expanded,
}: {
  t: Tokens;
  item: ToolGroupItem;
  open: boolean;
  onToggle: () => void;
  expanded: boolean;
}) {
  if (item.kind === "executing") {
    return <ExecutingRow t={t} entry={item.entry} />;
  }
  return (
    <ResultRow
      t={t}
      message={item.message}
      open={open}
      onToggle={onToggle}
      expanded={expanded}
    />
  );
}

function ExecutingRow({
  t,
  entry,
}: {
  t: Tokens;
  entry: ExecutingToolCall;
}) {
  const secs = Math.max(0, Math.floor((Date.now() - entry.startedAt) / 1000));
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "2px 0",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "3px 6px",
          borderRadius: R_MD,
          color: t.textMuted,
          fontFamily: FF_MONO,
          fontSize: FS_SM,
          textAlign: "left",
          width: "100%",
          contain: "content",
        }}
      >
        <span style={{ color: t.textDim, width: 8 }}>›</span>
        <span
          className="fs-pulse-dot"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: t.accent,
            display: "inline-block",
            flexShrink: 0,
          }}
        />
        <span style={{ color: t.accent, fontWeight: 600 }}>{entry.name}</span>
        <span style={{ color: t.textDim }}>running</span>
        <span style={{ color: t.textDim, flex: 1, minWidth: 0 }}>{secs}s</span>
      </div>
    </div>
  );
}

function ResultRow({
  t,
  message,
  open,
  onToggle,
  expanded,
}: {
  t: Tokens;
  message: ChatViewMessage;
  open: boolean;
  onToggle: () => void;
  expanded: boolean;
}) {
  const status = message.toolIsError ? t.bad : t.good;
  const label = message.toolName ?? "tool";
  const content = message.content ?? "";
  const preview = message.toolPreview ?? "";
  const lineCount = message.toolLineCount ?? 0;
  // Payload-expand only makes sense when the group itself is expanded —
  // when collapsed the viewport clips to N rows anyway.
  const showPayload = open && expanded;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "2px 0",
      }}
    >
      <button
        type="button"
        className="fs-tool-strip"
        data-open={showPayload ? "true" : "false"}
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "3px 6px",
          border: `1px solid ${showPayload ? t.borderSoft : "transparent"}`,
          borderRadius: R_MD,
          color: t.textMuted,
          fontFamily: FF_MONO,
          fontSize: FS_SM,
          cursor: expanded ? "pointer" : "default",
          textAlign: "left",
          width: "100%",
          ["--fs-tool-hover" as string]: t.hover,
          ["--fs-tool-open-bg" as string]: t.surfaceAlt,
          contain: "content",
        }}
        title={expanded ? (showPayload ? "Collapse" : "Expand") : undefined}
      >
        <span style={{ color: t.textDim, width: 8 }}>
          {showPayload ? "▾" : "▸"}
        </span>
        <span style={{ color: status, width: 10, fontWeight: 700 }}>
          {message.toolIsError ? "✗" : "✓"}
        </span>
        <span style={{ color: t.accent, fontWeight: 600 }}>{label}</span>
        {preview && (
          <span
            style={{
              color: t.textDim,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              flex: 1,
              minWidth: 0,
            }}
          >
            {preview}
          </span>
        )}
        {lineCount > 1 && (
          <span style={{ color: t.textDim, flexShrink: 0 }}>
            {lineCount} lines
          </span>
        )}
      </button>
      {showPayload && (
        <pre
          className="fs-selectable"
          style={{
            margin: 0,
            marginLeft: 22,
            padding: "8px 10px",
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderLeft: `3px solid ${status}`,
            borderRadius: R_MD,
            color: t.text,
            fontFamily: FF_MONO,
            fontSize: FS_SM,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 320,
            overflow: "auto",
            boxShadow: "0 1px 2px rgba(15,20,30,0.04)",
            contain: "content",
          }}
        >
          {content}
        </pre>
      )}
    </div>
  );
}
