import { useEffect, useRef } from "react";
import { useResolvedTheme } from "../../store";
import { FF_MONO, FONT_SANS, type ThemeMode, R_LG, FS_MD, FS_XS } from "../../theme";
import { Btn, Icons } from "../ui";
import type { AiSettingsWire, ProviderKind } from "../../types";
import { isProviderUsable, orderedProviders } from "../../lib/providers";
import { useEscLayer } from "../../lib/escStack";

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
  
  settings,
  currentProviderKind,
  onPick,
  onOpenSettings,
  onClose,
}: Props) {
  const t = useResolvedTheme().tokens;
  const ref = useRef<HTMLDivElement | null>(null);

  useEscLayer(true, onClose);
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose]);

  // Same backend order as Settings → AI, so muscle memory carries between
  // the two surfaces.
  const all = orderedProviders(settings);
  // Switched-off providers aren't choices here; they stay manageable in
  // Settings, which the footer points at.
  const rows = all.filter((p) => p.enabled);
  const disabledCount = all.length - rows.length;

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
        borderRadius: R_LG,
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
              fontSize: FS_XS,
              fontFamily: FF_MONO,
              letterSpacing: 0.5,
              textTransform: "uppercase",
            }}
          >
            Provider
          </div>
          <div
            style={{
              color: t.textDim,
              fontSize: FS_XS,
              fontFamily: FF_MONO,
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
          // Usable = enabled and holding a credential (operator key,
          // OAuth, or the free-tier fallback once switched on). Rows that
          // would otherwise produce "no credential configured" errors
          // route operators to Settings instead.
          const usable = isProviderUsable(p);
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
                fontSize: FS_MD,
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
                    fontSize: FS_MD,
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
                    fontFamily: FF_MONO,
                    fontSize: FS_XS,
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
                  fontFamily: FF_MONO,
                  fontSize: FS_XS,
                  color: usable
                    ? p.free_tier
                      ? t.info
                      : t.good
                    : t.textDim,
                }}
              >
                {p.configured
                  ? p.free_tier
                    ? "free tier"
                    : (p.account_label ?? p.auth_mode ?? "ready")
                  : "not connected"}
              </span>
            </button>
          );
        })}
        {disabledCount > 0 && (
          <button
            type="button"
            onClick={() => onOpenSettings("providers")}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "8px 10px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: t.textMuted,
              fontFamily: FF_MONO,
              fontSize: FS_XS,
            }}
          >
            {disabledCount} disabled — manage in Settings
          </button>
        )}
      </div>
    </div>
  );
}
