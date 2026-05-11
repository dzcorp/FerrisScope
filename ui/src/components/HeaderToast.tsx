import { useEffect } from "react";
import type { MouseEvent } from "react";
import { useAppStore, useResolvedTheme } from "../store";
import type { Toast as ToastT } from "../store";
import {
  
  FF_MONO,
  FONT_SANS,
  type ThemeMode,
  type Tokens, R_LG, R_MD, FS_MD, FS_XS
} from "../theme";
import { IconBtn, Icons } from "./ui";

type Props = { mode: ThemeMode };

// In-header toast strip. Sits to the right of the search/palette button and
// before the icon row in AppHeader. Renders only the newest active toast as
// a single-line card; the rest collapse into a small "+N" pill so a bulk
// operation never takes over the chrome. Clicking anywhere on the strip
// (except the dismiss `×`) opens the NotificationsPanel — that's the
// durable surface where the headline + multi-line body live.
//
// Per Helmsman v2 design principles, on-screen feedback (Terminating row,
// status pills) is the primary signal; this strip is reserved for things
// that happened off-screen or completed in the background.
export function HeaderToast({}: Props) {
  const t = useResolvedTheme().tokens;
  const toasts = useAppStore((s) => s.toasts);
  const newest = toasts[toasts.length - 1];
  if (!newest) return null;
  const queued = toasts.length - 1;
  return <HeaderToastCard t={t} toast={newest} queued={queued} />;
}

function HeaderToastCard({
  t,
  toast,
  queued,
}: {
  t: Tokens;
  toast: ToastT;
  queued: number;
}) {
  const dismissToast = useAppStore((s) => s.dismissToast);
  const openNotifications = useAppStore((s) => s.openNotifications);

  useEffect(() => {
    if (toast.durationMs <= 0) return;
    const id = setTimeout(() => dismissToast(toast.id), toast.durationMs);
    return () => clearTimeout(id);
  }, [toast.id, toast.durationMs, dismissToast]);

  const tone = toast.tone;
  const accent =
    tone === "ok"
      ? t.good
      : tone === "warn"
        ? t.warn
        : tone === "bad"
          ? t.bad
          : t.info;
  const icon =
    tone === "ok"
      ? Icons.check
      : tone === "warn"
        ? Icons.warn
        : tone === "bad"
          ? Icons.error
          : Icons.info;

  // Sticky errors get a faint outer ring so they don't read as a chip — the
  // strip itself is small, the ring escalates the visual weight enough that
  // the eye lands on it without growing the header.
  const sticky = tone === "bad" && toast.durationMs <= 0;
  const ringShadow = sticky ? `0 0 0 1px ${withAlpha(t.bad, 0.32)}` : "none";

  const onCardClick = () => openNotifications();
  const onDismissClick = (e: MouseEvent) => {
    e.stopPropagation();
    dismissToast(toast.id);
  };

  return (
    <button
      type="button"
      onClick={onCardClick}
      title={
        toast.body
          ? `${toast.text}\n${toast.body}\n\nClick to open notifications`
          : "Click to open notifications"
      }
      style={{
        display: "grid",
        gridTemplateColumns: queued > 0
          ? "3px auto 1fr auto auto"
          : "3px auto 1fr auto",
        alignItems: "center",
        height: 32,
        width: 360,
        background: t.surface,
        color: t.text,
        border: `1px solid ${t.border}`,
        borderRadius: R_MD,
        boxShadow: ringShadow,
        cursor: "pointer",
        overflow: "hidden",
        animation: "fs-toast-slide-in .18s cubic-bezier(.2,.7,.2,1)",
        fontSize: FS_MD,
        fontFamily: FONT_SANS,
        textAlign: "left",
        padding: 0,
      }}
    >
      <span aria-hidden style={{ background: accent, height: "100%" }} />
      <span
        aria-hidden
        style={{
          color: accent,
          padding: "0 6px 0 9px",
          display: "inline-flex",
          alignItems: "center",
        }}
      >
        {icon}
      </span>
      <span
        style={{
          color: t.text,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
          paddingRight: 8,
          fontWeight: tone === "bad" ? 600 : 500,
        }}
      >
        {toast.text}
      </span>
      {queued > 0 && (
        <span
          style={{
            fontSize: FS_XS,
            fontFamily: FF_MONO,
            fontVariantNumeric: "tabular-nums",
            color: t.textDim,
            padding: "1px 6px",
            marginRight: 4,
            background: t.chip,
            borderRadius: R_LG,
            lineHeight: 1.3,
          }}
        >
          +{queued}
        </span>
      )}
      <span
        onClick={onDismissClick}
        style={{ display: "inline-flex", paddingRight: 2 }}
      >
        <IconBtn t={t} title="Dismiss" onClick={onDismissClick}>
          {Icons.close}
        </IconBtn>
      </span>
    </button>
  );
}

// Convert a hex token (e.g. "#f43f5e") to rgba() for use inside box-shadow.
// Falls back to the input on shape mismatch — tokens can in principle be
// rgba already.
function withAlpha(hex: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
