import { useEffect, useRef } from "react";
import { tokens, FONT_MONO, FONT_SANS, type ThemeMode } from "../../theme";
import { Btn, Icons } from "../ui";
import type { AiSettingsWire, ProviderKind } from "../../types";

type Props = {
  mode: ThemeMode;
  settings: AiSettingsWire;
  /// The current chat's bound provider — gets the check mark and is
  /// disabled in the click-handler. Distinct from `settings.active_provider`,
  /// which is the global "new chats default to this" value.
  currentProviderKind: ProviderKind;
  onPick: (kind: ProviderKind) => void;
  /// Opens the AI settings panel. Optional `anchor` argument lets the
  /// popover land on the most-relevant control inside that tab —
  /// here, the providers block.
  onOpenSettings: (anchor?: string) => void;
  onClose: () => void;
};

// ProviderPickerPopover — anchored under the provider chip in ChatHeader.
// Picking a row switches this tab to a fresh chat session bound to the
// chosen provider; the active session is preserved on disk and reachable
// from the sessions popover. Mid-chat provider hot-swap is intentionally
// not offered — different providers translate transcripts into different
// wire formats, and tool-call ID streams don't carry across cleanly.
export function ProviderPickerPopover({
  mode,
  settings,
  currentProviderKind,
  onPick,
  onOpenSettings,
  onClose,
}: Props) {
  const t = tokens(mode);
  const ref = useRef<HTMLDivElement | null>(null);

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

  // Render in the same order Settings → AI uses (mirrors Rust's
  // `ProviderKind::all()`), so muscle memory carries between the two
  // surfaces.
  const order: ProviderKind[] = [
    "opencode_zen",
    "openai",
    "anthropic",
    "open_router",
    "zai",
    "minimax",
    "groq",
    "deepseek",
    "mistral",
    "together",
    "ollama",
  ];
  const rows = order
    .map((kind) => settings.providers[kind])
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

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
            Provider
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
            title="Picking a different provider opens a new chat for this cluster — the current chat is preserved and reachable from the sessions popover."
          >
            switching opens a fresh chat
          </div>
        </div>
        <Btn
          t={t}
          variant="ghost"
          size="sm"
          onClick={() => onOpenSettings("providers")}
          icon={Icons.settings}
          title="Open AI settings — manage credentials, base URLs, MCP servers"
        >
          Settings
        </Btn>
      </div>
      <div style={{ overflow: "auto", flex: 1 }}>
        {rows.map((p) => {
          const isCurrent = p.kind === currentProviderKind;
          // `configured` is true for any provider that can actually
          // serve traffic — operator key, OAuth, or the public-tier
          // fallback (OpenCode Zen). The picker disables rows that
          // would otherwise produce "no credential configured" errors
          // and routes operators to Settings instead.
          const usable = p.configured;
          return (
            <button
              key={p.kind}
              type="button"
              onClick={() => {
                // Unusable rows (no credential, no public-fallback)
                // route to Settings → AI → providers so the operator
                // can connect them in one click instead of dead-
                // clicking a disabled row.
                if (!usable) {
                  onOpenSettings("providers");
                  return;
                }
                onPick(p.kind);
              }}
              title={
                usable
                  ? undefined
                  : `${p.display_name} isn't connected — click to open Settings → AI`
              }
              style={{
                display: "flex",
                width: "100%",
                textAlign: "left",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                border: "none",
                borderBottom: `1px solid ${t.borderSoft}`,
                background: isCurrent ? t.surfaceAlt : "transparent",
                cursor: "pointer",
                color: usable ? t.text : t.textDim,
                fontFamily: FONT_SANS,
                fontSize: 12.5,
                opacity: usable ? 1 : 0.65,
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
                    fontSize: 12.5,
                    color: usable ? t.text : t.textDim,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.display_name}
                </span>
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: 10.5,
                    color: t.textMuted,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.id}
                </span>
              </span>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 10.5,
                  color: usable
                    ? p.account_label === "free tier"
                      ? t.info
                      : t.good
                    : t.textDim,
                }}
              >
                {p.configured
                  ? p.account_label ?? p.auth_mode ?? "ready"
                  : "not connected"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
