import { useEffect, useMemo, useRef, useState } from "react";
import { tokens, FONT_MONO, FONT_SANS, type ThemeMode } from "../../theme";
import { Btn, ErrorBlock, Icons } from "../ui";
import type { ModelInfo, ProviderKind } from "../../types";

type Props = {
  mode: ThemeMode;
  /// Loaded model list for the chat's bound provider. `null` while a fetch
  /// is in flight on first open. The popover renders a small spinner row
  /// in that case.
  models: ModelInfo[] | null;
  loading: boolean;
  error: string | null;
  currentModelId: string;
  /// Provider id + label, shown as a small caption above the list. The
  /// caption doubles as a "provider is locked for this session" cue —
  /// mid-chat provider switches aren't supported (history keys off the
  /// provider's wire format), so the operator changes the *active*
  /// provider in Settings → AI for new chats.
  providerKind: ProviderKind;
  providerLabel: string;
  /// Open the AI Settings page so the operator can switch active
  /// provider / re-key. Wired from `useAppStore.openSettings()` in the
  /// caller; the optional anchor lets the popover land on the
  /// most-relevant control (default model select for this view).
  onOpenSettings: (anchor?: string) => void;
  onPick: (modelId: string) => void;
  onRetry: () => void;
  onClose: () => void;
};

// ModelPickerPopover — anchored under the model chip in ChatHeader. Lets
// the operator hot-swap models within the chat's current provider; the
// chat's history is preserved (model is per-request, not per-session at
// the wire level). Provider switches aren't offered here — they require
// a fresh chat and live in Settings → AI.
export function ModelPickerPopover({
  mode,
  models,
  loading,
  error,
  currentModelId,
  providerKind: _providerKind,
  providerLabel,
  onOpenSettings,
  onPick,
  onRetry,
  onClose,
}: Props) {
  const t = tokens(mode);
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const filtered = useMemo(() => {
    const list = models ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (m) =>
        m.id.toLowerCase().includes(q) ||
        (m.name ?? "").toLowerCase().includes(q),
    );
  }, [models, query]);

  // Reset active highlight when the filtered list changes — keep it
  // pinned to the current model when present so the popover opens with
  // the right row already focused.
  useEffect(() => {
    const idx = filtered.findIndex((m) => m.id === currentModelId);
    setActive(idx >= 0 ? idx : 0);
  }, [filtered, currentModelId]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Outside click + Esc to close. Identical pattern to SessionsPopover —
  // keeping it duplicated rather than extracting a hook because each
  // popover has its own escape-handling needs (the sessions one closes
  // a rename input first, this one doesn't).
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const m = filtered[active];
      if (m) onPick(m.id);
    }
  };

  // Scroll the active row into view as the operator arrows through.
  useEffect(() => {
    const el = itemRefs.current[active];
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        top: "100%",
        left: 8,
        right: 8,
        zIndex: 50,
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        marginTop: 4,
        maxHeight: 420,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontFamily: FONT_SANS,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderBottom: `1px solid ${t.borderSoft}`,
          background: t.surfaceAlt,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minWidth: 0,
          }}
        >
          <div
            style={{
              color: t.textMuted,
              fontSize: 10.5,
              fontFamily: FONT_MONO,
              letterSpacing: 0.5,
              textTransform: "uppercase",
            }}
          >
            Model · {providerLabel}
          </div>
          <div
            style={{
              color: t.textDim,
              fontSize: 10.5,
              fontFamily: FONT_MONO,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title="Provider is fixed for the lifetime of this chat. Switch provider for new chats from Settings → AI."
          >
            provider locked for this chat
          </div>
        </div>
        <Btn
          t={t}
          variant="ghost"
          size="sm"
          onClick={() => onOpenSettings("default-model")}
          icon={Icons.settings}
          title="Open AI settings — switch active provider, manage credentials"
        >
          Settings
        </Btn>
      </div>
      <div
        style={{
          padding: "6px 8px",
          borderBottom: `1px solid ${t.borderSoft}`,
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
          placeholder="Search models…"
          style={{
            width: "100%",
            background: t.surfaceAlt,
            border: `1px solid ${t.borderSoft}`,
            color: t.text,
            borderRadius: 4,
            padding: "5px 8px",
            fontFamily: FONT_MONO,
            fontSize: 12,
            outline: "none",
          }}
        />
      </div>
      <div style={{ overflow: "auto", flex: 1 }}>
        {loading && (
          <div
            style={{
              padding: 14,
              color: t.textDim,
              fontSize: 12,
              textAlign: "center",
            }}
          >
            Loading models…
          </div>
        )}
        {!loading && error && (
          <div
            style={{
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              alignItems: "center",
            }}
          >
            <ErrorBlock
              t={t}
              message={error}
              kindLabel="model list"
              inline
            />
            <Btn t={t} variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </Btn>
          </div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div
            style={{
              padding: 14,
              color: t.textDim,
              fontSize: 12,
              textAlign: "center",
            }}
          >
            {query.trim() ? "No models match." : "No models available."}
          </div>
        )}
        {!loading && !error &&
          filtered.map((m, i) => {
            const isCurrent = m.id === currentModelId;
            const isActive = i === active;
            return (
              <button
                key={m.id}
                type="button"
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(m.id)}
                style={{
                  display: "flex",
                  width: "100%",
                  textAlign: "left",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 10px",
                  border: "none",
                  borderBottom: `1px solid ${t.borderSoft}`,
                  background: isActive
                    ? t.surfaceAlt
                    : isCurrent
                      ? t.surfaceAlt
                      : "transparent",
                  cursor: "pointer",
                  color: t.text,
                  fontFamily: FONT_SANS,
                  fontSize: 12.5,
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    width: 14,
                    color: isCurrent ? t.good : "transparent",
                  }}
                  aria-hidden
                >
                  {Icons.check}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  <span
                    style={{
                      fontFamily: FONT_MONO,
                      fontSize: 12,
                      color: t.text,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.id}
                  </span>
                  {m.name && m.name !== m.id && (
                    <span
                      style={{
                        fontSize: 11,
                        color: t.textMuted,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {m.name}
                    </span>
                  )}
                </span>
                {typeof m.context_length === "number" &&
                  m.context_length > 0 && (
                    <span
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 10.5,
                        color: t.textDim,
                      }}
                      title="context window"
                    >
                      {formatCtx(m.context_length)}
                    </span>
                  )}
              </button>
            );
          })}
      </div>
    </div>
  );
}

function formatCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
