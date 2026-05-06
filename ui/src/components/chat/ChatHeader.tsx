import { tokens, FONT_MONO, type ThemeMode } from "../../theme";
import { totalToolCount, type McpStatus } from "./chatStreaming";
import { Btn, Icons } from "../ui";

type Props = {
  mode: ThemeMode;
  title: string;
  contextLabel: string;
  modelId: string;
  mcp: McpStatus | null;
  onToggleSessions: () => void;
  sessionsOpen: boolean;
  onToggleTools: () => void;
  toolsOpen: boolean;
};

// ChatHeader — strip above the message list. Shows the session title, the
// bound cluster context, the active model id, and a clickable "Tools" pill
// that opens the inspector popover. The pill always counts native tools
// (in-process) plus any healthy external MCP servers; the dot turns warn-
// coloured if any configured server failed to spawn so the operator notices
// without having to open the popover.
export function ChatHeader({
  mode,
  title,
  contextLabel,
  modelId,
  mcp,
  onToggleSessions,
  sessionsOpen,
  onToggleTools,
  toolsOpen,
}: Props) {
  const t = tokens(mode);
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
              fontSize: 12.5,
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
              fontSize: 10.5,
              fontFamily: FONT_MONO,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span>{contextLabel} · {modelId || "no model selected"}</span>
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
                borderRadius: 4,
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
