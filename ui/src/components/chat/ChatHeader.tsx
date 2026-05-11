import { FF_MONO, type ThemeMode, R_MD, FS_MD, FS_XS } from "../../theme";
import { useResolvedTheme } from "../../store";
import { totalToolCount, type McpStatus } from "./chatStreaming";
import { Btn, Icons } from "../ui";

type Props = {
  mode: ThemeMode;
  title: string;
  contextLabel: string;
  modelId: string;
  /// Display name of the chat's bound provider — drives the provider
  /// chip and the model chip's tooltip. Empty string while AI settings
  /// are still loading; the chip degrades to a `…` label.
  providerLabel: string;
  mcp: McpStatus | null;
  onToggleSessions: () => void;
  sessionsOpen: boolean;
  onToggleTools: () => void;
  toolsOpen: boolean;
  onToggleModelPicker: () => void;
  modelPickerOpen: boolean;
  onToggleProviderPicker: () => void;
  providerPickerOpen: boolean;
};

// ChatHeader — strip above the message list. Shows the session title, the
// bound cluster context, the active model id, and a clickable "Tools" pill
// that opens the inspector popover. The pill always counts native tools
// (in-process) plus any healthy external MCP servers; the dot turns warn-
// coloured if any configured server failed to spawn so the operator notices
// without having to open the popover.
export function ChatHeader({
  
  title,
  contextLabel,
  modelId,
  providerLabel,
  mcp,
  onToggleSessions,
  sessionsOpen,
  onToggleTools,
  toolsOpen,
  onToggleModelPicker,
  modelPickerOpen,
  onToggleProviderPicker,
  providerPickerOpen,
}: Props) {
  const t = useResolvedTheme().tokens;
  const total = totalToolCount(mcp ?? undefined);
  const failedServers = (mcp?.servers ?? []).filter(
    (s) => !s.available && s.message,
  );
  const pendingServers = (mcp?.servers ?? []).filter(
    (s) => !s.available && !s.message,
  );
  const dotColor = !mcp
    ? t.textDim
    : failedServers.length > 0
      ? t.warn
      : pendingServers.length > 0
        ? t.info
        : t.good;
  const label = !mcp
    ? "Tools · …"
    : pendingServers.length > 0
      ? `Tools · ${total} (${pendingServers.length} starting)`
      : `Tools · ${total}`;
  const titleHint = !mcp
    ? "Loading tool catalogue…"
    : failedServers.length > 0
      ? `${failedServers.length} MCP server${
          failedServers.length === 1 ? "" : "s"
        } failed — click for details`
      : "Show available tools (native + MCP)";
  return (
    <div
      style={{
        flexShrink: 0,
        borderBottom: `1px solid ${t.border}`,
        background: t.surfaceAlt,
      }}
    >
      <div
        style={{
          padding: "8px 14px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          position: "relative",
        }}
      >
        <Btn
          t={t}
          variant={sessionsOpen ? "secondary" : "ghost"}
          size="sm"
          onClick={onToggleSessions}
          icon={Icons.chat}
          iconRight={Icons.chevD}
          title="Switch session"
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            flex: 1,
          }}
        >
          <div
            style={{
              color: t.text,
              fontSize: FS_MD,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </div>
          <div
            style={{
              color: t.textMuted,
              fontSize: FS_XS,
              fontFamily: FF_MONO,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {contextLabel}
            </span>
            <span style={{ color: t.textDim }}>·</span>
            <button
              type="button"
              onClick={onToggleProviderPicker}
              title={
                providerLabel
                  ? `${providerLabel} — click to switch provider (opens a fresh chat)`
                  : "Switch provider"
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                color: t.text,
                background: providerPickerOpen ? t.surface : "transparent",
                border: `1px solid ${
                  providerPickerOpen ? t.borderSoft : "transparent"
                }`,
                borderRadius: R_MD,
                padding: "1px 6px 1px 6px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: "inherit",
                maxWidth: 200,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {providerLabel || "…"}
              </span>
              <span
                style={{
                  display: "inline-flex",
                  color: t.textDim,
                  transform: providerPickerOpen ? "rotate(180deg)" : undefined,
                  transition: "transform 120ms ease",
                }}
                aria-hidden
              >
                {Icons.chevD}
              </span>
            </button>
            <span style={{ color: t.textDim }}>·</span>
            <button
              type="button"
              onClick={onToggleModelPicker}
              title={
                providerLabel
                  ? `${providerLabel} · ${modelId || "no model selected"} — click to switch model`
                  : "Click to switch model"
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                color: t.text,
                background: modelPickerOpen ? t.surface : "transparent",
                border: `1px solid ${
                  modelPickerOpen ? t.borderSoft : "transparent"
                }`,
                borderRadius: R_MD,
                padding: "1px 6px 1px 6px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: "inherit",
                maxWidth: 280,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {modelId || "no model selected"}
              </span>
              <span
                style={{
                  display: "inline-flex",
                  color: t.textDim,
                  transform: modelPickerOpen ? "rotate(180deg)" : undefined,
                  transition: "transform 120ms ease",
                }}
                aria-hidden
              >
                {Icons.chevD}
              </span>
            </button>
            <span style={{ color: t.textDim }}>·</span>
            <button
              type="button"
              onClick={onToggleTools}
              title={titleHint}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                color: dotColor,
                background: toolsOpen ? t.surface : "transparent",
                border: `1px solid ${
                  toolsOpen ? t.borderSoft : "transparent"
                }`,
                borderRadius: R_MD,
                padding: "1px 4px",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: "inherit",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: dotColor,
                }}
              />
              <span>{label}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
