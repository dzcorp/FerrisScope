import { memo, useState } from "react";
import { tokens, FONT_MONO, type ThemeMode } from "../../theme";
import type { ChatViewMessage } from "./chatStreaming";
import { Markdown } from "./markdown";

type Props = {
  mode: ThemeMode;
  message: ChatViewMessage;
};

// MessageBubble — single message card. User and assistant get the same shape
// but different background tones so the role reads at a glance. Tool result
// messages get a distinct collapsible card with a status dot (red for
// is_error, green otherwise).
//
// Empty-content assistant turns (the model called a tool without any prose)
// collapse to a thin one-liner so the chat shows real messages as bubbles
// and tool plumbing as quiet operational chrome — see ToolCallStrip below.
//
// Wrapped in `memo` because token streaming re-renders MessageList many
// times per second; the reducer keeps stable references for every
// non-streaming message, so memoization lets unchanged bubbles skip
// re-render (and skip re-parsing their markdown). Without this, an N-long
// history pays an O(N) reparse on every token delta.
function MessageBubbleInner({ mode, message }: Props) {
  const t = tokens(mode);

  if (message.role === "tool") {
    return <ToolResultBubble t={t} message={message} />;
  }

  const isUser = message.role === "user";
  // User: tinted with the accent so it pops as "your turn". Assistant:
  // clean surface card so the model's prose / markdown is the focal point.
  // Both get a 1px border + tiny shadow so they read as physical cards on
  // both the light page bg (#f7f8fa) and the dark dock.
  const bg = isUser ? t.accentSoft : t.surface;
  const borderColor = isUser ? t.accent : t.border;
  const align = isUser ? "flex-end" : "flex-start";
  const labelColor = isUser ? t.accent : t.textDim;
  const hasContent = (message.content ?? "").trim().length > 0;
  const hasToolCalls = !!message.toolCalls && message.toolCalls.length > 0;

  // Pure-tool-call assistant message. While streaming we surface a tiny
  // "calling…" strip so the operator sees activity; once streaming settles
  // we suppress it entirely — the matching ToolResultBubble immediately
  // below already shows the call name + outcome, and stacking both feels
  // redundant.
  if (message.role === "assistant" && !hasContent && hasToolCalls) {
    if (message.streaming) {
      return <ToolCallStrip t={t} names={message.toolCalls!.map((c) => c.name)} />;
    }
    return null;
  }

  return (
    <div
      style={{
        display: "flex",
        justifyContent: align,
        gap: 8,
      }}
    >
      <div
        className="fs-selectable"
        style={{
          maxWidth: "92%",
          background: bg,
          border: `1px solid ${borderColor}`,
          borderRadius: 10,
          padding: "9px 13px 10px",
          color: t.text,
          fontSize: 13,
          lineHeight: 1.55,
          wordBreak: "break-word",
          boxShadow: isUser
            ? "0 1px 2px rgba(15,20,30,0.04)"
            : "0 1px 3px rgba(15,20,30,0.05)",
          // Paint containment: tells the browser the bubble's contents
          // can't affect layout / paint outside its box. Long
          // transcripts with shadows otherwise force the whole list to
          // repaint when any single bubble updates.
          contain: "content",
        }}
      >
        <div
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10,
            color: labelColor,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            marginBottom: 5,
            fontWeight: 700,
            opacity: 0.85,
          }}
        >
          {isUser ? "you" : "assistant"}
        </div>
        <Markdown text={message.content} t={t} />
        {message.streaming && (
          <span
            style={{
              display: "inline-block",
              width: 6,
              height: 14,
              marginLeft: 2,
              verticalAlign: "text-bottom",
              background: t.accent,
              animation: "fs-blink 1.1s steps(2, start) infinite",
            }}
          />
        )}
      </div>
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleInner);

// ToolCallStrip — quiet one-liner shown while the assistant is in the middle
// of emitting tool calls. Once the result lands we drop it (see the early
// return in MessageBubble) so the transcript stays clean: bubble → result
// strip → bubble, instead of bubble → "I'm calling X" → result → bubble.
function ToolCallStrip({
  t,
  names,
}: {
  t: ReturnType<typeof tokens>;
  names: string[];
}) {
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
      }}
    >
      <span style={{ color: t.textDim }}>›</span>
      <span>calling</span>
      {names.map((n, i) => (
        <span key={`${n}-${i}`} style={{ color: t.accent, fontWeight: 600 }}>
          {n}
          {i < names.length - 1 ? "," : ""}
        </span>
      ))}
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

// ToolResultBubble — compact one-line strip (no card, no role label) that
// expands inline on click. Matches ToolCallStrip's silhouette so a turn
// reads `› calling X` → `› ✓ X  preview…` → assistant bubble. Clicking the
// row reveals the full output below in a scrollable monospace block.
function ToolResultBubble({
  t,
  message,
}: {
  t: ReturnType<typeof tokens>;
  message: ChatViewMessage;
}) {
  const [open, setOpen] = useState(false);
  const status = message.toolIsError ? t.bad : t.good;
  const label = message.toolName ?? "tool";
  const content = message.content ?? "";
  // Preview + line count come pre-computed from the reducer (see
  // chatStreaming.ts → summarizeToolContent). Splitting a multi-KB tool
  // result string on every render — twice — was a real cost on the
  // initial paint of a long transcript.
  const preview = message.toolPreview ?? "";
  const lineCount = message.toolLineCount ?? 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        // No `contentVisibility: auto` here on purpose. The collapsed strip
        // is ~32 px but the wrapper grows to ~360 px when the operator
        // expands it, and any intrinsic-size hint we pick is wrong for one
        // of those states. The placeholder/real-height mismatch made
        // scrollHeight jump while scrolling past a cluster of tool
        // messages — the "teleport" symptom. Plain `contain: content`
        // gives paint isolation without the size-prediction risk.
        contain: "content",
      }}
    >
      <button
        type="button"
        className="fs-tool-strip"
        data-open={open ? "true" : "false"}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          border: `1px solid ${open ? t.borderSoft : "transparent"}`,
          borderRadius: 6,
          color: t.textMuted,
          fontFamily: FONT_MONO,
          fontSize: 11,
          cursor: "pointer",
          textAlign: "left",
          width: "100%",
          // Hover background and the expanded-state background flow through
          // these CSS vars so .fs-tool-strip's :hover rule can drive paint
          // without a per-frame JS style mutation during scroll.
          ["--fs-tool-hover" as string]: t.hover,
          ["--fs-tool-open-bg" as string]: t.surfaceAlt,
          // Paint containment keeps the strip's repaints (hover, expand)
          // from cascading into sibling bubbles while scrolling past.
          contain: "content",
        }}
        title={open ? "Collapse" : "Expand"}
      >
        <span style={{ color: t.textDim, width: 8 }}>{open ? "▾" : "▸"}</span>
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
      {open && (
        <pre
          className="fs-selectable"
          style={{
            margin: 0,
            marginLeft: 22,
            padding: "8px 10px",
            background: t.surface,
            border: `1px solid ${t.border}`,
            borderLeft: `3px solid ${status}`,
            borderRadius: 6,
            color: t.text,
            fontFamily: FONT_MONO,
            fontSize: 11,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 320,
            overflow: "auto",
            boxShadow: "0 1px 2px rgba(15,20,30,0.04)",
            // `wordBreak: break-word` on a large tool result is a sneaky
            // layout cost during scroll — explicit containment scopes that
            // work to this element instead of cascading into the list.
            contain: "content",
          }}
        >
          {content}
        </pre>
      )}
    </div>
  );
}
