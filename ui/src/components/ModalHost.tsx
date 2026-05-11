import { useEffect } from "react";
import { useAppStore, useResolvedTheme } from "../store";
import type { ConfirmModal } from "../store";
import { tokens, FONT_SANS, FF_MONO, type ThemeMode, R_LG, FS_MD } from "../theme";
import { Btn, IconBtn, Icons } from "./ui";

type Props = { mode: ThemeMode };

// ModalHost — single render point for the imperative `confirm()` modal stack.
// Modals slide down from the top edge per the design (R-09): they sit above
// every panel (DetailPanel z-index 31; modal scrim 60). Esc and backdrop click
// resolve as Cancel.
export function ModalHost({}: Props) {
  const t = useResolvedTheme().tokens;
  const modals = useAppStore((s) => s.modals);
  const resolveModal = useAppStore((s) => s.resolveModal);

  // Only the topmost modal is interactive. Earlier ones stay parked under the
  // scrim so the stack unwinds in order as the operator answers each.
  const top = modals[modals.length - 1] ?? null;

  useEffect(() => {
    if (!top) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        resolveModal(top.id, false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        resolveModal(top.id, true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [top, resolveModal]);

  if (!top) return null;

  return (
    <>
      {/* Scrim. Click cancels — same as Esc. zIndex sits above DetailPanel (31). */}
      <div
        onClick={() => resolveModal(top.id, false)}
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          left: 0,
          background: t.scrim,
          zIndex: 60,
          animation: "fs-fade-in .15s ease",
        }}
      />
      <Modal t={t} m={top} onResolve={(ok) => resolveModal(top.id, ok)} />
    </>
  );
}

function Modal({
  t,
  m,
  onResolve,
}: {
  t: ReturnType<typeof tokens>;
  m: ConfirmModal;
  onResolve: (ok: boolean) => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`modal-title-${m.id}`}
      style={{
        position: "fixed",
        top: "calc(32px + var(--fs-titlebar-h, 0px))",
        left: "50%",
        transform: "translateX(-50%)",
        width: 480,
        maxWidth: "92vw",
        background: t.surface,
        color: t.text,
        border: `1px solid ${t.border}`,
        borderRadius: R_LG,
        boxShadow: "0 24px 60px rgba(0,0,0,0.35)",
        zIndex: 61,
        animation: "fs-modal-drop .18s cubic-bezier(.2,.7,.2,1)",
        fontFamily: FONT_SANS,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "14px 16px 10px",
          borderBottom: `1px solid ${t.borderSoft}`,
        }}
      >
        <div
          id={`modal-title-${m.id}`}
          style={{
            flex: 1,
            fontSize: FS_MD,
            fontWeight: 600,
            color: t.text,
            wordBreak: "break-word",
          }}
        >
          {m.title}
        </div>
        <IconBtn
          t={t}
          title="Cancel (Esc)"
          onClick={() => onResolve(false)}
        >
          {Icons.close}
        </IconBtn>
      </header>
      {m.body && (
        <div
          style={{
            padding: "12px 16px",
            color: t.textDim,
            fontSize: FS_MD,
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
            fontFamily:
              // Use mono only if the body looks like an identifier list
              // (multi-line with slashes) — keeps copy-friendly content tabular
              // and still legible.
              /\n.+\//.test(m.body) ? FF_MONO : FONT_SANS,
            maxHeight: "60vh",
            overflowY: "auto",
          }}
        >
          {m.body}
        </div>
      )}
      <footer
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          padding: "10px 16px 14px",
          borderTop: `1px solid ${t.borderSoft}`,
        }}
      >
        <Btn t={t} variant="ghost" onClick={() => onResolve(false)}>
          {m.cancelLabel}
        </Btn>
        <Btn
          t={t}
          variant={m.tone === "danger" ? "danger" : "primary"}
          onClick={() => onResolve(true)}
        >
          {m.confirmLabel}
        </Btn>
      </footer>
    </div>
  );
}
