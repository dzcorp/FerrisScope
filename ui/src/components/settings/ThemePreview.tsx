import type { CSSProperties } from "react";
import { FS_SM, R_PILL, type ResolvedTheme, type Tokens, FW_MEDIUM, FW_SEMIBOLD } from "../../theme";

// Miniature of the app shell drawn in a theme's own palette, radius and font,
// so a theme card shows the look instead of describing it.
export function ThemePreview({ theme }: { theme: ResolvedTheme }) {
  const k = theme.tokens;
  const r = theme.sizing.radius;
  const bar = (w: string, c: string, h = 4): CSSProperties => ({
    width: w,
    height: h,
    borderRadius: R_PILL,
    background: c,
    flexShrink: 0,
  });
  return (
    <div
      aria-hidden
      data-testid="theme-preview"
      style={{
        display: "flex",
        height: 76,
        borderRadius: r.md,
        overflow: "hidden",
        border: `1px solid ${k.border}`,
        background: k.bg,
        fontFamily: theme.typography.fontSans,
      }}
    >
      <div
        style={{
          width: 34,
          background: k.rail,
          borderRight: `1px solid ${k.borderSoft}`,
          padding: "8px 5px",
          display: "flex",
          flexDirection: "column",
          gap: 5,
        }}
      >
        <div
          data-testid="theme-preview-rail-active"
          style={{
            height: 8,
            borderRadius: r.sm,
            background: k.railActive,
            boxShadow:
              k.railIndicator === "transparent" ? undefined : `inset 2px 0 0 ${k.railIndicator}`,
          }}
        />
        <div style={bar("70%", k.textMuted, 3)} />
        <div style={bar("80%", k.textMuted, 3)} />
        <div style={bar("60%", k.textMuted, 3)} />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            height: 16,
            background: k.header,
            borderBottom: `1px solid ${k.border}`,
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "0 6px",
          }}
        >
          <div style={bar("28%", k.textDim, 3)} />
          <div style={{ flex: 1 }} />
          <div
            data-testid="theme-preview-button"
            style={{
              height: 9,
              width: 24,
              borderRadius: r.sm,
              background: k.accent,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div style={bar("50%", k.onAccent, 2)} />
          </div>
        </div>
        <div style={{ flex: 1, background: k.surface, display: "flex", flexDirection: "column" }}>
          <PreviewRow k={k} bg={k.tableHeader} dot={null} w="40%" ink={k.tableHeaderText} />
          <PreviewRow k={k} bg="transparent" dot={k.good} w="56%" ink={k.text} />
          <PreviewRow
            k={k}
            bg={k.rowSelected}
            bar={k.rowSelectedBar}
            dot={k.warn}
            w="48%"
            ink={k.text}
          />
          <PreviewRow k={k} bg="transparent" dot={k.bad} w="62%" ink={k.text} />
        </div>
      </div>
    </div>
  );
}

function PreviewRow({
  k,
  bg,
  bar,
  dot,
  w,
  ink,
}: {
  k: Tokens;
  bg: string;
  bar?: string;
  dot: string | null;
  w: string;
  ink: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        gap: 5,
        padding: "0 7px",
        background: bg,
        borderBottom: `1px solid ${k.borderSoft}`,
        boxShadow: bar && bar !== "transparent" ? `inset 2px 0 0 ${bar}` : undefined,
      }}
    >
      {dot ? (
        <span style={{ width: 5, height: 5, borderRadius: R_PILL, background: dot }} />
      ) : (
        <span style={{ width: 5 }} />
      )}
      <span style={{ width: w, height: 3, borderRadius: R_PILL, background: ink, opacity: 0.85 }} />
      <span style={{ flex: 1 }} />
      <span style={{ width: "14%", height: 3, borderRadius: R_PILL, background: k.textMuted }} />
    </div>
  );
}

/// Two-tone chip for a palette: its surface with the accent dot inside.
export function PaletteSwatch({
  t,
  theme,
  name,
  active,
  onClick,
}: {
  t: Tokens;
  theme: ResolvedTheme;
  name: string;
  active: boolean;
  onClick: () => void;
}) {
  const k = theme.tokens;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 10px 5px 6px",
        borderRadius: R_PILL,
        border: `1px solid ${active ? t.accent : t.border}`,
        background: active ? t.accentSoft : t.surface,
        color: active ? t.accent : t.text,
        fontFamily: "inherit",
        fontSize: FS_SM,
        fontWeight: active ? FW_SEMIBOLD : FW_MEDIUM,
        cursor: "pointer",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 18,
          height: 18,
          borderRadius: R_PILL,
          background: k.surface,
          boxShadow: `inset 0 0 0 1px ${k.border}`,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: R_PILL, background: k.accent }} />
      </span>
      {name}
    </button>
  );
}
