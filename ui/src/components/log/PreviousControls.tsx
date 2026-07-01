import { FF_MONO, type Tokens, FS_SM, FS_XS, R_SM } from "../../theme";

// Shared chrome for the "previous (terminated) instance" log view — issue #63.
// Both single-pod log surfaces (Detail panel Logs tab + single-pod overlay)
// use these so the toggle + banner stay identical. The amber tint follows the
// same convention as `ConflictBanner` (rgba on the warn hue) since there is no
// dedicated warn-background token.

// Amber (== `t.warn` #f59e0b) tints, matching `ConflictBanner` in edit.tsx.
const WARN_FILL = "rgba(245,158,11,0.16)";
const WARN_BORDER = "rgba(245,158,11,0.5)";
const BANNER_FILL = "rgba(245,158,11,0.12)";
const BANNER_BORDER = "rgba(245,158,11,0.35)";

/// Chip toggle that switches the log pane between the live container and its
/// previously-terminated instance. Warn-toned + `aria-pressed` when active.
export function PreviousLogsToggle({
  t,
  active,
  onToggle,
}: {
  t: Tokens;
  active: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onToggle(!active)}
      title={
        "Show logs from the previously-terminated container instance " +
        "(like `kubectl logs --previous`). Useful right after a crash / restart."
      }
      style={{
        height: 26,
        padding: "0 10px",
        borderRadius: R_SM,
        border: `1px solid ${active ? WARN_BORDER : t.border}`,
        background: active ? WARN_FILL : t.chip,
        color: active ? t.warn : t.textDim,
        fontFamily: FF_MONO,
        fontSize: FS_SM,
        fontWeight: active ? 600 : 400,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      Previous
    </button>
  );
}

/// Full-width strip shown above the log body while previous-instance logs are
/// active, so the operator can't mistake a terminated instance for the live
/// runtime.
export function PreviousLogsBanner({ t }: { t: Tokens }) {
  return (
    <div
      role="status"
      style={{
        padding: "5px 14px",
        background: BANNER_FILL,
        borderBottom: `1px solid ${BANNER_BORDER}`,
        color: t.warn,
        fontFamily: FF_MONO,
        fontSize: FS_XS,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <span aria-hidden style={{ fontWeight: 700 }}>
        ⚠
      </span>
      Showing logs from the previous terminated instance — not the live
      container.
    </div>
  );
}
