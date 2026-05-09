import { useEffect, useRef, useState } from "react";
import { tokens, FONT_SANS, FONT_MONO, type ThemeMode } from "../../theme";
import { Btn, Toggle } from "../ui";
import type { ApprovalMode } from "../../types";

type Props = {
  mode: ThemeMode;
  disabled: boolean;
  streaming: boolean;
  approvalMode: ApprovalMode;
  onApprovalModeChange: (mode: ApprovalMode) => void;
  onSend: (text: string) => void;
  onCancel: () => void;
  /// Manual compaction trigger. Kicks off the same summarisation
  /// pipeline auto-compaction uses; folds older history into a
  /// "context checkpoint" message. `null` = button hidden (no chat
  /// open).
  onCompact?: (() => void) | null;
  /// `true` while a compaction call is in flight; disables the button
  /// and shows "compacting…".
  compacting?: boolean;
  /// Most recent token usage from the provider, if any. Rendered as a
  /// compact footer chip — operator can eyeball context burn at a glance.
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  /// Model's full context window in tokens, resolved through models.dev.
  /// `0` ⇒ unknown (catalogue not loaded yet); the chip falls back to
  /// rendering only the used count when this is missing.
  contextLimit?: number;
  /// Usable window after subtracting the reserved output buffer the
  /// auto-compaction trigger uses. The chip's percentage and warn tone
  /// fire against this so what the operator sees matches when the
  /// trigger will actually run.
  usableContext?: number;
};

const MIN_HEIGHT = 84; // ~3 rows. Tall enough that the input reads as a
// multiline composer at rest, not a one-line prompt — operators routinely
// paste YAML / kubectl output / multi-step questions.
const MAX_HEIGHT = 360;

// ChatInput — multiline composer. Enter sends; Shift+Enter inserts a
// newline. Matches Slack / Discord / ChatGPT muscle memory — most
// operator messages are one-liners, so single-Enter-to-send is what
// fingers expect. Multi-line YAML / paste flows still work via
// Shift+Enter or by pasting (newlines in pasted content survive).
export function ChatInput({
  mode,
  disabled,
  streaming,
  approvalMode,
  onApprovalModeChange,
  onSend,
  onCancel,
  onCompact,
  compacting,
  usage,
  contextLimit = 0,
  usableContext = 0,
}: Props) {
  const t = tokens(mode);
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const allowAllWrites = approvalMode === "allow_all_writes";

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [value]);

  const submit = () => {
    if (disabled) return;
    const text = value;
    if (!text.trim()) return;
    setValue("");
    onSend(text);
  };

  return (
    <div
      style={{
        flexShrink: 0,
        borderTop: `1px solid ${t.border}`,
        background: t.surfaceAlt,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends. Shift+Enter inserts a newline. IME
            // composition (CJK, accents) routes Enter through the
            // composer — `isComposing` / keyCode 229 lets that
            // through so we don't fire mid-composition.
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing &&
              e.keyCode !== 229
            ) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            disabled
              ? "chat unavailable…"
              : streaming
                ? "agent is responding — your message will be queued for its next round (Enter to send)"
                : "Ask about this cluster — Enter to send, Shift+Enter for newline"
          }
          disabled={disabled}
          rows={3}
          style={{
            flex: 1,
            minHeight: MIN_HEIGHT,
            maxHeight: MAX_HEIGHT,
            resize: "vertical",
            fontFamily: FONT_SANS,
            fontSize: 13,
            color: t.text,
            background: t.surface,
            border: `1px solid ${t.borderSoft}`,
            borderRadius: 6,
            padding: "8px 10px",
            outline: "none",
            lineHeight: 1.5,
          }}
        />
        <div style={{ display: "flex", gap: 6 }}>
          {streaming && (
            <Btn t={t} variant="secondary" size="sm" onClick={onCancel}>
              Stop
            </Btn>
          )}
          <Btn
            t={t}
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={disabled || !value.trim()}
            title={
              streaming
                ? "Queue this message for the agent's next round"
                : undefined
            }
          >
            {streaming ? "Queue" : "Send"}
          </Btn>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          paddingLeft: 2,
          fontSize: 10.5,
          fontFamily: FONT_MONO,
          userSelect: "none",
        }}
      >
        <Toggle
          t={t}
          size="sm"
          tone="warn"
          checked={allowAllWrites}
          onChange={(next) =>
            onApprovalModeChange(next ? "allow_all_writes" : "approve_per_write")
          }
          title="When on, the agent runs write tools without asking."
          label={
            <span style={{ color: allowAllWrites ? t.warn : t.textMuted }}>
              allow all writes
            </span>
          }
        />
        {onCompact ? (
          <button
            type="button"
            onClick={onCompact}
            disabled={!!compacting || disabled}
            title="Summarise older messages into a context checkpoint to free up the model's context window"
            style={{
              background: "transparent",
              color: compacting ? t.warn : t.textMuted,
              border: `1px solid ${compacting ? t.warn : "transparent"}`,
              borderRadius: 4,
              padding: "1px 6px",
              cursor: compacting || disabled ? "default" : "pointer",
              fontFamily: FONT_MONO,
              fontSize: 10.5,
              opacity: compacting || disabled ? 0.7 : 1,
            }}
          >
            {compacting ? "compacting…" : "compact"}
          </button>
        ) : null}
        <span style={{ flex: 1, color: t.textDim, textAlign: "right" }}>
          {usage ? (
            <UsageChip
              t={t}
              usage={usage}
              contextLimit={contextLimit}
              usableContext={usableContext}
            />
          ) : null}
          Enter to send · Shift+Enter for newline
        </span>
      </div>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Compaction trigger fraction must mirror agent.rs::COMPACTION_TRIGGER_FRACTION.
// At/above this share of the *usable* window the backend auto-summarises;
// the chip shifts to a warn tone as we approach so the operator gets
// visual heads-up before the next turn fires the trigger.
const COMPACTION_FRACTION = 0.9;
// Visual warn threshold. We flip the chip earlier than the trigger so the
// operator can choose to /compact preemptively before the next big tool
// call pushes us over.
const WARN_FRACTION = 0.75;

// UsageChip — the `<used> / <limit>  P%` footer chip. Token count tints to
// `warn` as we cross WARN_FRACTION of the usable window, then to `bad`
// once we're above the auto-compaction trigger. Falls back to `<used> tok`
// when the catalogue hasn't loaded yet (`contextLimit === 0`).
function UsageChip({
  t,
  usage,
  contextLimit,
  usableContext,
}: {
  t: ReturnType<typeof tokens>;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  contextLimit: number;
  usableContext: number;
}) {
  const total = usage.totalTokens;
  const denom = usableContext > 0 ? usableContext : contextLimit;
  const fraction = denom > 0 ? total / denom : 0;
  const tone =
    fraction >= COMPACTION_FRACTION
      ? t.bad
      : fraction >= WARN_FRACTION
        ? t.warn
        : t.textDim;
  const pct = denom > 0 ? Math.round(fraction * 100) : null;
  const title =
    `prompt ${usage.promptTokens} · completion ${usage.completionTokens}` +
    (contextLimit > 0
      ? `\n${total} / ${contextLimit} tokens (window)` +
        (usableContext > 0 && usableContext !== contextLimit
          ? `\nusable: ${total} / ${usableContext} (${pct}%) — auto-compact at ${Math.round(COMPACTION_FRACTION * 100)}%`
          : "")
      : "");
  return (
    <span title={title} style={{ color: tone }}>
      {formatTokens(total)}
      {contextLimit > 0 ? ` / ${formatTokens(contextLimit)}` : ""}
      {pct !== null ? ` · ${pct}%` : ""}
      {" tok · "}
    </span>
  );
}
