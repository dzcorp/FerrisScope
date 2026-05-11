import { memo, useMemo } from "react";
import { tokens, FONT_MONO, type ThemeMode } from "../../theme";
import type { ChatViewMessage } from "./chatStreaming";
import { Markdown } from "./markdown";
import { safePrefixLength } from "./safePrefix";

type Props = {
  mode: ThemeMode;
  message: ChatViewMessage;
};

// MessageBubble — single user / assistant card. Tool-result messages are
// rendered via ToolGroupBubble in MessageList (consecutive tool calls
// collapse into one ticker card), so this component only handles the
// user / assistant cases.
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
    // Defensive — MessageList groups tool messages into ToolGroupBubble
    // before they reach here. Returning null avoids a duplicate render
    // path if a tool message ever slips through.
    return null;
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

  // While streaming, render only the safe-prefix slice so partial
  // markdown constructs (mid-link, mid-code, mid-row…) don't flash as
  // raw text and then re-render. Once streaming settles we render the
  // full content unconditionally. The slice is memoized so unrelated
  // bubble re-renders don't recompute it.
  const renderText = useMemo(() => {
    const text = message.content ?? "";
    if (!message.streaming) return text;
    return text.slice(0, safePrefixLength(text));
  }, [message.content, message.streaming]);

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

  // Empty assistant turn (no text, no tool calls) that has settled — the
  // backend's auto-retry on `EmptyTurn` will spawn a fresh AssistantStart
  // for the retry, leaving this AssistantStart/AssistantEnd pair as a
  // phantom in the reducer. Hide it so the operator only sees the real
  // response (or the explicit "model returned no output" notice once
  // retries are exhausted, which has content and falls through). While
  // still streaming we DO render the empty bubble — the blinking caret
  // shows the model is working.
  if (
    message.role === "assistant" &&
    !hasContent &&
    !hasToolCalls &&
    !message.streaming
  ) {
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
        {!isUser && message.streaming && !hasContent ? (
          // No tokens have landed yet (the gap between AssistantStart and the
          // first TokenDelta — model is "thinking"). Show animated dots so
          // the bubble doesn't just sit empty with a lone caret.
          <ThinkingIndicator t={t} />
        ) : (
          <>
            <Markdown text={renderText} t={t} />
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
          </>
        )}
      </div>
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleInner);

// ThinkingIndicator — three bouncing dots + a soft "thinking" label,
// shown inside an assistant bubble that's streaming but hasn't received
// any tokens yet (and reused in MessageList's placeholder bubble so the
// indicator stays alive across tool-execution waits). Replaces the
// previous lone blinking caret so the pre-first-token latency reads as
// active work, not a stalled bubble.
export function ThinkingIndicator({ t }: { t: ReturnType<typeof tokens> }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        color: t.textDim,
        fontSize: 12,
        lineHeight: 1.55,
      }}
    >
      <span className="fs-think-text" style={{ fontFamily: FONT_MONO }}>
        thinking
      </span>
      <span style={{ display: "inline-flex", gap: 3 }}>
        <ThinkDot t={t} delay={0} />
        <ThinkDot t={t} delay={160} />
        <ThinkDot t={t} delay={320} />
      </span>
    </div>
  );
}

function ThinkDot({
  t,
  delay,
}: {
  t: ReturnType<typeof tokens>;
  delay: number;
}) {
  return (
    <span
      className="fs-think-dot"
      style={{
        width: 5,
        height: 5,
        borderRadius: "50%",
        background: t.accent,
        display: "inline-block",
        animationDelay: `${delay}ms`,
      }}
    />
  );
}

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

