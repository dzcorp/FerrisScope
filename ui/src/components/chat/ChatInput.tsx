import { useEffect, useRef, useState } from "react";
import { useResolvedTheme } from "../../store";
import {
  tokens,
  FONT_SANS,
  FF_MONO,
  type ThemeMode,
  R_SM,
  R_MD,
  R_LG,
  FS_MD,
  FS_XS,
} from "../../theme";
import { IconBtn, Icons, Toggle } from "../ui";
import { api } from "../../api";
import type { ApprovalMode, ChatImageAttachment } from "../../types";

type Props = {
  mode: ThemeMode;
  disabled: boolean;
  streaming: boolean;
  approvalMode: ApprovalMode;
  onApprovalModeChange: (mode: ApprovalMode) => void;
  onSend: (text: string, images: ChatImageAttachment[]) => void;
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

const MIN_HEIGHT = 56; // ~2 rows. The composer card + bottom toolbar give it
// presence at rest; it auto-grows up to MAX_HEIGHT as the operator types or
// pastes YAML / kubectl output.
const MAX_HEIGHT = 320;

// Attachment caps. Images round-trip as base64 on every subsequent turn, so
// keep both the per-image size and the count bounded — a stray 30 MB
// screenshot would balloon the context and the IPC payload. These are
// generous for the screenshot/diagram use case; the apiserver enforces its
// own hard limits beyond this.
const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB

// In-composer attachment: keeps both the raw base64 (`data`, what we send)
// and the full data URI (`dataUrl`, what the <img> preview renders) so we
// don't reconstruct the prefix twice.
type Attachment = {
  id: string;
  mime: string;
  data: string;
  dataUrl: string;
  name: string;
};

// Read a clipboard / picked File into an Attachment. Resolves `null` on read
// error or a non-data-URL result rather than throwing — the caller filters
// nulls so one bad paste can't wedge the whole batch.
function readImageAttachment(file: File): Promise<Attachment | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma === -1) {
        resolve(null);
        return;
      }
      const header = result.slice(0, comma); // e.g. "data:image/png;base64"
      const data = result.slice(comma + 1);
      if (!data) {
        resolve(null);
        return;
      }
      const mime = /^data:([^;]+)/.exec(header)?.[1] || file.type || "image/png";
      resolve({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mime,
        data,
        dataUrl: result,
        name: file.name || "pasted image",
      });
    };
    reader.readAsDataURL(file);
  });
}

// ChatInput — multiline composer. Enter sends; Shift+Enter inserts a
// newline. Matches Slack / Discord / ChatGPT muscle memory — most
// operator messages are one-liners, so single-Enter-to-send is what
// fingers expect. Multi-line YAML / paste flows still work via
// Shift+Enter or by pasting (newlines in pasted content survive).
export function ChatInput({
  
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
  const t = useResolvedTheme().tokens;
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const allowAllWrites = approvalMode === "allow_all_writes";

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [value]);

  // Accept image files from paste / drop / picker. Non-images are ignored;
  // over-size and over-count attempts surface an inline note rather than
  // silently dropping. `accepted.length` is folded into the count check so a
  // multi-image paste respects the cap within a single batch.
  const addFiles = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setAttachError(null);
    const accepted: Attachment[] = [];
    for (const f of images) {
      if (attachments.length + accepted.length >= MAX_ATTACHMENTS) {
        setAttachError(`At most ${MAX_ATTACHMENTS} images per message.`);
        break;
      }
      if (f.size > MAX_IMAGE_BYTES) {
        setAttachError(
          `“${f.name || "image"}” is too large (max ${Math.round(
            MAX_IMAGE_BYTES / (1024 * 1024),
          )} MB).`,
        );
        continue;
      }
      const att = await readImageAttachment(f);
      if (att) accepted.push(att);
    }
    if (accepted.length > 0) {
      setAttachments((prev) => [...prev, ...accepted]);
    }
  };

  // Add an image the webview only exposes on the native clipboard (the
  // WebKitGTK case — see `onPaste`). Reconstructs the data URI for preview;
  // size is bounded from the base64 length since there's no File here.
  const addNativeClipboardImage = async () => {
    let img: ChatImageAttachment | null;
    try {
      img = await api.readClipboardImage();
    } catch {
      return; // No native image / read failed — nothing to attach.
    }
    if (!img) return;
    if (attachments.length >= MAX_ATTACHMENTS) {
      setAttachError(`At most ${MAX_ATTACHMENTS} images per message.`);
      return;
    }
    // base64 decodes to ~3/4 its length in bytes.
    if (img.data.length * 0.75 > MAX_IMAGE_BYTES) {
      setAttachError(
        `Pasted image is too large (max ${Math.round(
          MAX_IMAGE_BYTES / (1024 * 1024),
        )} MB).`,
      );
      return;
    }
    setAttachError(null);
    setAttachments((prev) => [
      ...prev,
      {
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mime: img.mime,
        data: img.data,
        dataUrl: `data:${img.mime};base64,${img.data}`,
        name: "pasted image",
      },
    ]);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const files: File[] = [];
    for (let i = 0; i < cd.items.length; i++) {
      const it = cd.items[i];
      if (it && it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    // Standard path: the clipboard exposed image File(s) on the event.
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
      return;
    }
    // WebKitGTK path: the webview doesn't surface clipboard images as Files.
    // If there's also no plain text to paste, the clipboard most likely holds
    // an image — read it natively. (When text IS present we leave the default
    // textarea paste alone so YAML / kubectl output still works.)
    const text =
      typeof cd.getData === "function" ? cd.getData("text/plain") : "";
    if (!text) {
      void addNativeClipboardImage();
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const submit = () => {
    if (disabled) return;
    const text = value;
    const images: ChatImageAttachment[] = attachments.map((a) => ({
      mime: a.mime,
      data: a.data,
    }));
    if (!text.trim() && images.length === 0) return;
    setValue("");
    setAttachments([]);
    setAttachError(null);
    onSend(text, images);
  };

  const canSend = !disabled && (!!value.trim() || attachments.length > 0);

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
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          // Reset so picking the same file twice in a row still fires change.
          e.target.value = "";
          if (files.length > 0) void addFiles(files);
        }}
      />
      {attachError && (
        <div style={{ color: t.warn, fontSize: FS_XS, fontFamily: FF_MONO }}>
          {attachError}
        </div>
      )}

      {/* Composer card: textarea + bottom toolbar in one rounded surface, with
          a focus ring. Attach sits bottom-left, send/stop bottom-right — no
          dead space beside a tall textarea. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          background: t.surface,
          border: `1px solid ${focused ? t.accent : t.borderSoft}`,
          borderRadius: R_LG,
          padding: 8,
          boxShadow: focused ? `0 0 0 3px ${t.accentSoft}` : "none",
          transition: "border-color 120ms ease, box-shadow 120ms ease",
        }}
      >
        {attachments.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {attachments.map((a) => (
              <Thumbnail
                key={a.id}
                t={t}
                att={a}
                onRemove={() => removeAttachment(a.id)}
              />
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            // Enter sends. Shift+Enter inserts a newline. IME composition
            // (CJK, accents) routes Enter through the composer — `isComposing`
            // / keyCode 229 lets that through so we don't fire mid-composition.
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
                ? "agent is responding — Enter to queue for its next round"
                : "Ask about this cluster…"
          }
          disabled={disabled}
          rows={2}
          style={{
            width: "100%",
            minHeight: MIN_HEIGHT,
            maxHeight: MAX_HEIGHT,
            resize: "none",
            fontFamily: FONT_SANS,
            fontSize: FS_MD,
            color: t.text,
            background: "transparent",
            border: "none",
            padding: "2px 4px",
            outline: "none",
            lineHeight: 1.5,
          }}
        />

        {/* Bottom toolbar: attach (left) · send / stop (right). */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <IconBtn
            t={t}
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || attachments.length >= MAX_ATTACHMENTS}
            title="Attach image (or paste from clipboard)"
          >
            {Icons.plus}
          </IconBtn>
          <span style={{ flex: 1 }} />
          {streaming && (
            <RoundAction
              t={t}
              variant="neutral"
              onClick={onCancel}
              title="Stop the agent"
            >
              {Icons.stop}
            </RoundAction>
          )}
          {(!streaming || canSend) && (
            <RoundAction
              t={t}
              variant="accent"
              onClick={submit}
              disabled={!canSend}
              title={streaming ? "Queue for the next round" : "Send"}
            >
              {Icons.send}
            </RoundAction>
          )}
        </div>
      </div>

      {/* Meta row: secondary controls + token usage, muted under the card. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          paddingLeft: 2,
          fontSize: FS_XS,
          fontFamily: FF_MONO,
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
              borderRadius: R_MD,
              padding: "1px 6px",
              cursor: compacting || disabled ? "default" : "pointer",
              fontFamily: FF_MONO,
              fontSize: FS_XS,
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
        </span>
      </div>
    </div>
  );
}

// RoundAction — circular icon button for the composer's primary actions.
// `accent` is the send/queue button (filled, lights up on hover, dims when
// there's nothing to send); `neutral` is the stop button shown mid-stream.
function RoundAction({
  t,
  variant,
  onClick,
  disabled,
  title,
  children,
}: {
  t: ReturnType<typeof tokens>;
  variant: "accent" | "neutral";
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const accent = variant === "accent";
  const bg = disabled
    ? t.surfaceAlt
    : accent
      ? hover
        ? t.accentHover
        : t.accent
      : hover
        ? t.btnHover
        : t.surface;
  const fg = disabled ? t.textMuted : accent ? "#ffffff" : t.text;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 30,
        height: 30,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "50%",
        border: `1px solid ${accent ? "transparent" : t.border}`,
        background: bg,
        color: fg,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 120ms ease, color 120ms ease",
      }}
    >
      {children}
    </button>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Thumbnail — a single pending attachment in the composer strip. 48px square
// preview with a hover-revealed remove badge in the top-right corner.
function Thumbnail({
  t,
  att,
  onRemove,
}: {
  t: ReturnType<typeof tokens>;
  att: Attachment;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        position: "relative",
        width: 48,
        height: 48,
        borderRadius: R_SM,
        overflow: "hidden",
        border: `1px solid ${t.border}`,
        background: t.surface,
      }}
      title={att.name}
    >
      <img
        src={att.dataUrl}
        alt={att.name}
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
      />
      <button
        type="button"
        aria-label={`Remove ${att.name}`}
        onClick={onRemove}
        style={{
          position: "absolute",
          top: 1,
          right: 1,
          width: 16,
          height: 16,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          borderRadius: R_SM,
          border: "none",
          cursor: "pointer",
          color: "#fff",
          background: "rgba(15,20,30,0.65)",
          lineHeight: 1,
          fontSize: 12,
        }}
      >
        ×
      </button>
    </div>
  );
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
      {" tok"}
    </span>
  );
}
