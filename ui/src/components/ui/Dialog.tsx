import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../store";
import { FONT_SANS, FS_MD, FS_SM, R_LG, type Tokens } from "../../theme";
import { IconBtn } from "./Btn";
import { Icons } from "./icons";

type Props = {
  t: Tokens;
  title: ReactNode;
  subtitle?: ReactNode;
  width?: number;
  /** Blocks Esc / scrim dismissal while a request is in flight. */
  busy?: boolean;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
};

// Form dialog with the confirm modal's chrome. Sits one layer below
// ModalHost (60/61) so a confirm() raised from inside stacks on top.
export function Dialog({
  t,
  title,
  subtitle,
  width = 560,
  busy = false,
  onClose,
  footer,
  children,
}: Props) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    // Capture phase so the detail panel's own Esc handler never sees it; a
    // confirm() stacked on top (ModalHost) owns Esc while it is open.
    const onKey = (e: KeyboardEvent) => {
      if (useAppStore.getState().modals.length > 0) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!busyRef.current) closeRef.current();
      } else if (e.key === "Tab" && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === panelRef.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      restore?.focus?.();
    };
  }, []);

  return createPortal(
    <>
      <div
        onClick={() => !busy && onClose()}
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          left: 0,
          background: t.scrim,
          zIndex: 58,
          animation: "fs-fade-in .15s ease",
        }}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          position: "fixed",
          top: "calc(32px + var(--fs-titlebar-h, 0px))",
          left: "50%",
          transform: "translateX(-50%)",
          width,
          maxWidth: "92vw",
          maxHeight: "calc(100vh - 64px - var(--fs-titlebar-h, 0px))",
          display: "flex",
          flexDirection: "column",
          background: t.surface,
          color: t.text,
          border: `1px solid ${t.border}`,
          borderRadius: R_LG,
          boxShadow: "0 24px 60px rgba(0,0,0,0.35)",
          zIndex: 59,
          animation: "fs-modal-drop .18s cubic-bezier(.2,.7,.2,1)",
          fontFamily: FONT_SANS,
          outline: "none",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: "14px 16px 10px",
            borderBottom: `1px solid ${t.borderSoft}`,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              id={titleId}
              style={{ fontSize: FS_MD, fontWeight: 600, wordBreak: "break-word" }}
            >
              {title}
            </div>
            {subtitle && (
              <div
                style={{
                  fontSize: FS_SM,
                  color: t.textMuted,
                  marginTop: 2,
                  wordBreak: "break-word",
                }}
              >
                {subtitle}
              </div>
            )}
          </div>
          <IconBtn t={t} title="Close (Esc)" disabled={busy} onClick={onClose}>
            {Icons.close}
          </IconBtn>
        </header>
        <div style={{ padding: "12px 16px", overflowY: "auto", minHeight: 0 }}>
          {children}
        </div>
        <footer
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 8,
            padding: "10px 16px 14px",
            borderTop: `1px solid ${t.borderSoft}`,
          }}
        >
          {footer}
        </footer>
      </div>
    </>,
    document.body,
  );
}
