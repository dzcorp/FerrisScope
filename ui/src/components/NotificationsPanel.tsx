import { useEffect } from "react";
import { useAppStore, useResolvedTheme } from "../store";
import type { Notification } from "../store";
import { FF_MONO, FONT_SANS, type ThemeMode, type Tokens, R_SM, FS_MD, FS_SM, FS_XS } from "../theme";
import { Btn, Eyebrow, IconBtn, Icons, EmptyState } from "./ui";

type Props = { mode: ThemeMode };

// Right-side history panel for every toast that's ever fired this session.
// Same slide-from-right pattern as DetailPanel; in-memory only — closing the
// app drops the log.
export function NotificationsPanel({ mode }: Props) {
  const t = useResolvedTheme().tokens;
  const open = useAppStore((s) => s.notificationsOpen);
  const close = useAppStore((s) => s.closeNotifications);
  const notifications = useAppStore((s) => s.notifications);
  const clear = useAppStore((s) => s.clearNotifications);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  // Newest at the top — most operators want the recent thing first.
  const ordered = [...notifications].reverse();

  return (
    <>
      <div
        onClick={close}
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          left: 0,
          background: t.scrim,
          zIndex: 30,
          animation: "fs-fade-in .18s ease",
        }}
      />
      <div
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          width: 420,
          maxWidth: "92vw",
          background: t.surface,
          borderLeft: `1px solid ${t.border}`,
          boxShadow:
            mode === "dark"
              ? "-12px 0 32px rgba(0,0,0,0.4)"
              : "-12px 0 32px rgba(15,20,30,0.12)",
          display: "flex",
          flexDirection: "column",
          zIndex: 31,
          animation: "fs-slide-from-right .22s cubic-bezier(.2,.7,.2,1)",
          fontFamily: FONT_SANS,
        }}
      >
        <header
          style={{
            padding: "16px 18px 12px",
            borderBottom: `1px solid ${t.borderSoft}`,
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <Eyebrow t={t}>Notifications</Eyebrow>
            <div
              style={{
                marginTop: 2,
                fontSize: FS_MD,
                fontWeight: 600,
                color: t.text,
              }}
            >
              {notifications.length} entr
              {notifications.length === 1 ? "y" : "ies"}
            </div>
          </div>
          {notifications.length > 0 && (
            <Btn t={t} variant="ghost" size="sm" onClick={clear}>
              Clear all
            </Btn>
          )}
          <IconBtn t={t} title="Close (Esc)" onClick={close}>
            {Icons.close}
          </IconBtn>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {ordered.length === 0 ? (
            <EmptyState
              t={t}
              title="No notifications yet"
              hint="Toasts you've seen this session land here."
            />
          ) : (
            ordered.map((n) => <Row key={n.id} t={t} n={n} />)
          )}
        </div>
      </div>
    </>
  );
}

function Row({ t, n }: { t: Tokens; n: Notification }) {
  const accent =
    n.tone === "ok"
      ? t.good
      : n.tone === "warn"
        ? t.warn
        : n.tone === "bad"
          ? t.bad
          : t.accent;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "10px 18px",
        borderBottom: `1px solid ${t.borderSoft}`,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 3,
          alignSelf: "stretch",
          background: accent,
          borderRadius: R_SM,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: FS_MD,
            color: t.text,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            lineHeight: 1.5,
            fontWeight: n.body ? 600 : 400,
          }}
        >
          {n.text}
        </div>
        {n.body && (
          <div
            style={{
              marginTop: 4,
              fontSize: FS_SM,
              color: t.textDim,
              fontFamily: FF_MONO,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              lineHeight: 1.45,
            }}
          >
            {n.body}
          </div>
        )}
        <div
          style={{
            marginTop: 4,
            fontSize: FS_XS,
            color: t.textMuted,
            fontFamily: FF_MONO,
          }}
        >
          {timeAgo(n.createdAt)} · {n.tone}
        </div>
      </div>
    </div>
  );
}

function timeAgo(then: number): string {
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
