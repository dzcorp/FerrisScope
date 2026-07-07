import { useEffect, useState } from "react";
import { useAppStore, useResolvedTheme } from "../store";
import type { Notification, NotificationDetail, NotificationMeta } from "../store";
import {
  FF_MONO,
  FONT_SANS,
  type ThemeMode,
  type Tokens,
  R_SM,
  R_MD,
  FS_MD,
  FS_SM,
  FS_XS,
} from "../theme";
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

// Flatten a notification's structured meta into an ordered label/value list.
// Fixed order puts the operator's most-asked question first (which context /
// cluster did this happen against), then resource identity, then the reason.
// Empty fields are skipped; caller `extra` pairs append in their own order.
function metaRows(m: NotificationMeta): NotificationDetail[] {
  const out: NotificationDetail[] = [];
  const push = (label: string, value?: string | null, mono?: boolean) => {
    if (value != null && value !== "") out.push({ label, value, mono });
  };
  push("Context", m.context);
  push("Cluster", m.cluster, true);
  push("Namespace", m.namespace, true);
  push("Kind", m.kind);
  push("Resource", m.name, true);
  push("Reason", m.reason, true);
  if (m.extra) for (const d of m.extra) push(d.label, d.value, d.mono);
  return out;
}

function Row({ t, n }: { t: Tokens; n: Notification }) {
  const [open, setOpen] = useState(false);
  const accent =
    n.tone === "ok"
      ? t.good
      : n.tone === "warn"
        ? t.warn
        : n.tone === "bad"
          ? t.bad
          : t.accent;

  const rows = n.meta ? metaRows(n.meta) : [];
  // Only rows with something to reveal get an expand affordance. A bare
  // one-line toast with no meta and no body stays a static card.
  const hasDetail = rows.length > 0 || !!n.body;

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
        {hasDetail ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            title={open ? "Collapse" : "Show detail"}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              alignItems: "start",
              gap: 8,
              width: "100%",
              padding: 0,
              border: "none",
              background: "transparent",
              textAlign: "left",
              cursor: "pointer",
              color: "inherit",
              font: "inherit",
            }}
          >
            <span
              style={{
                fontSize: FS_MD,
                color: t.text,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                lineHeight: 1.5,
                fontWeight: 600,
              }}
            >
              {n.text}
            </span>
            <span
              aria-hidden
              style={{
                display: "inline-flex",
                color: t.textMuted,
                marginTop: 2,
                transition: "color .12s",
              }}
            >
              {open ? Icons.chevD : Icons.chevR}
            </span>
          </button>
        ) : (
          <div
            style={{
              fontSize: FS_MD,
              color: t.text,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              lineHeight: 1.5,
            }}
          >
            {n.text}
          </div>
        )}

        {open && hasDetail && (
          <div
            style={{
              marginTop: 8,
              padding: "8px 10px",
              background: t.chip,
              border: `1px solid ${t.borderSoft}`,
              borderRadius: R_MD,
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              columnGap: 12,
              rowGap: 5,
              alignItems: "baseline",
            }}
          >
            {rows.map((d, i) => (
              <DetailLine key={`${d.label}-${i}`} t={t} d={d} />
            ))}
            <DetailLine
              t={t}
              d={{
                label: "Time",
                value: new Date(n.createdAt).toLocaleString(),
                mono: true,
              }}
            />
            {n.body && (
              <DetailLine t={t} d={{ label: "Details", value: n.body, mono: true }} />
            )}
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

// One label/value line inside the expanded detail box. Label column is dim and
// nowrap; value wraps and is selectable so operators can copy it out.
function DetailLine({ t, d }: { t: Tokens; d: NotificationDetail }) {
  return (
    <>
      <span
        style={{
          fontSize: FS_XS,
          color: t.textMuted,
          fontFamily: FF_MONO,
          whiteSpace: "nowrap",
        }}
      >
        {d.label}
      </span>
      <span
        style={{
          fontSize: FS_SM,
          color: t.text,
          fontFamily: d.mono ? FF_MONO : FONT_SANS,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          lineHeight: 1.45,
          userSelect: "text",
        }}
      >
        {d.value}
      </span>
    </>
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
