import { useState } from "react";
import { FS_SM, type Tokens } from "../theme";
import { IconBtn, Icons, Tooltip } from "./ui";

// Right-placement (chat) minimised pill. With sessions living inside a single
// chat window the steady state is one chat tab, so the whole pill is the
// restore affordance — click anywhere on it to bring the chat back — and a
// single close button (stopPropagation so it doesn't also restore) tears the
// chat down. The vertical label reads "Chat" for the common single-tab case
// and "{n} chats" only when more than one cluster's chat is open at once.
export function MinimizedChatPill({
  t,
  count,
  onRestore,
  onClose,
}: {
  t: Tokens;
  count: number;
  onRestore: () => void;
  onClose: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Restore chat"
      onClick={onRestore}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onRestore();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "fixed",
        top: "calc(60px + var(--fs-titlebar-h, 0px))",
        right: 0,
        background: hover ? t.hover : t.headerAlt,
        borderLeft: `1px solid ${t.border}`,
        borderTop: `1px solid ${t.border}`,
        borderBottom: `1px solid ${t.border}`,
        borderTopLeftRadius: 6,
        borderBottomLeftRadius: 6,
        padding: "8px 8px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        zIndex: 25,
        fontSize: FS_SM,
        cursor: "pointer",
        transition: "background .12s",
      }}
    >
      {/*
        Themed hint on the obvious target (icon + label) rather than the whole
        pill — wrapping the whole pill would surface this tooltip at the same
        time as the close button's own when the cursor is over the ×.
      */}
      <Tooltip label="Restore chat" side="left">
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ color: t.textDim, display: "inline-flex" }}>
            {Icons.chat}
          </span>
          <span
            style={{
              color: t.textMuted,
              writingMode: "vertical-rl",
              transform: "rotate(180deg)",
              fontWeight: 500,
              letterSpacing: 0.4,
            }}
          >
            {count === 1 ? "Chat" : `${count} chats`}
          </span>
        </div>
      </Tooltip>
      <IconBtn
        t={t}
        title={count === 1 ? "Close chat" : "Close all chats"}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        {Icons.close}
      </IconBtn>
    </div>
  );
}
