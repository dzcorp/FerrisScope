import { useEffect, useState } from "react";
import { useResolvedTheme } from "../store";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Mirrors `@tauri-apps/api/window`'s internal `ResizeDirection` (declared but
// not exported in 2.x). Re-stating it locally avoids a public-API dance just
// to type the eight resize-edge handlers below.
type ResizeDir =
  | "North"
  | "NorthEast"
  | "East"
  | "SouthEast"
  | "South"
  | "SouthWest"
  | "West"
  | "NorthWest";
import { FONT_SANS, type ThemeMode, type Tokens, FS_SM } from "../theme";
import { Icons } from "./ui";

// Linux-only window chrome. Tauri strips GTK's client-side decorations on
// Linux (see `set_decorations(false)` in main.rs setup); this component
// supplies the replacement: drag region + min/max/close, themed via
// `theme.ts` tokens so it tracks the rest of the app's chrome.
//
// macOS / Windows keep native decorations because the system titlebar is
// well-themed and gives us blur for free; on those platforms this
// component renders nothing and `TITLEBAR_INSET_PX` is 0.
export const IS_LINUX_TITLEBAR = /linux/i.test(
  typeof navigator === "undefined" ? "" : navigator.userAgent,
);

const HEIGHT = 30;

// Top inset every fixed-position overlay (scrims, slide-in panels,
// modals, dock) must apply so it starts below the custom titlebar on
// Linux and at the very top on macOS / Windows. Source of truth is here;
// App.tsx publishes it as the `--fs-titlebar-h` CSS variable so
// components can compose it via inline styles or `calc()`.
export const TITLEBAR_INSET_PX = IS_LINUX_TITLEBAR ? HEIGHT : 0;

export function TitleBar({}: { mode: ThemeMode }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!IS_LINUX_TITLEBAR) return;
    const w = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    w.isMaximized().then(setMaximized).catch(() => {});
    w.onResized(() => {
      w.isMaximized().then(setMaximized).catch(() => {});
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  if (!IS_LINUX_TITLEBAR) return null;

  const t = useResolvedTheme().tokens;
  const w = getCurrentWindow();

  // Explicit `startDragging()` rather than `data-tauri-drag-region`: the
  // attribute's auto-handler is unreliable on WebKitGTK when decorations
  // are stripped at runtime (the injected listener races with the
  // window's first paint). Direct calls always work. We still skip drag
  // when the click originated inside a control so the buttons stay
  // clickable.
  const onTitleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    void w.startDragging();
  };

  return (
    <div
      onMouseDown={onTitleMouseDown}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        void w.toggleMaximize();
      }}
      style={{
        height: HEIGHT,
        flexShrink: 0,
        display: "flex",
        alignItems: "stretch",
        justifyContent: "space-between",
        background: t.header,
        borderBottom: `1px solid ${t.border}`,
        userSelect: "none",
        WebkitUserSelect: "none",
        fontFamily: FONT_SANS,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          paddingLeft: 12,
          fontSize: FS_SM,
          fontWeight: 600,
          letterSpacing: 0.2,
          color: t.textDim,
        }}
      >
        FerrisScope
      </div>

      <div style={{ display: "flex", alignItems: "stretch" }}>
        <CtlButton
          t={t}
          aria="Minimize"
          onClick={() => {
            void w.minimize();
          }}
        >
          {Icons.windowMin}
        </CtlButton>
        <CtlButton
          t={t}
          aria={maximized ? "Restore" : "Maximize"}
          onClick={() => {
            void w.toggleMaximize();
          }}
        >
          {Icons.windowMax}
        </CtlButton>
        <CtlButton
          t={t}
          aria="Close"
          danger
          onClick={() => {
            void w.close();
          }}
        >
          {Icons.close}
        </CtlButton>
      </div>
    </div>
  );
}

// Invisible window-edge resize handles for Linux. With `set_decorations(false)`
// the WM no longer provides edge-grip zones, so we recreate them: 6px strips
// along each side, 14px corner squares for diagonal grips. Hidden when the
// window is maximized — there's nothing to resize and the strips would
// otherwise eat clicks at the screen edge. Position-fixed + high z-index puts
// them above all app chrome; corner zones overlap with the close button's
// corner but leave most of its 44×30 click target intact.
export function ResizeEdges() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!IS_LINUX_TITLEBAR) return;
    const w = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    w.isMaximized().then(setMaximized).catch(() => {});
    w.onResized(() => {
      w.isMaximized().then(setMaximized).catch(() => {});
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  if (!IS_LINUX_TITLEBAR || maximized) return null;

  const w = getCurrentWindow();
  const start = (dir: ResizeDir) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    void w.startResizeDragging(dir);
  };

  const EDGE = 6;
  const CORNER = 14;
  const Z = 10000;
  const base: React.CSSProperties = { position: "fixed", zIndex: Z };

  return (
    <>
      <div
        onMouseDown={start("North")}
        style={{ ...base, top: 0, left: CORNER, right: CORNER, height: EDGE, cursor: "ns-resize" }}
      />
      <div
        onMouseDown={start("South")}
        style={{ ...base, bottom: 0, left: CORNER, right: CORNER, height: EDGE, cursor: "ns-resize" }}
      />
      <div
        onMouseDown={start("West")}
        style={{ ...base, top: CORNER, bottom: CORNER, left: 0, width: EDGE, cursor: "ew-resize" }}
      />
      <div
        onMouseDown={start("East")}
        style={{ ...base, top: CORNER, bottom: CORNER, right: 0, width: EDGE, cursor: "ew-resize" }}
      />
      <div
        onMouseDown={start("NorthWest")}
        style={{ ...base, top: 0, left: 0, width: CORNER, height: CORNER, cursor: "nwse-resize" }}
      />
      <div
        onMouseDown={start("NorthEast")}
        style={{ ...base, top: 0, right: 0, width: CORNER, height: CORNER, cursor: "nesw-resize" }}
      />
      <div
        onMouseDown={start("SouthWest")}
        style={{ ...base, bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: "nesw-resize" }}
      />
      <div
        onMouseDown={start("SouthEast")}
        style={{ ...base, bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: "nwse-resize" }}
      />
    </>
  );
}

function CtlButton({
  t,
  children,
  aria,
  danger,
  onClick,
}: {
  t: Tokens;
  children: React.ReactNode;
  aria: string;
  danger?: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const bg = hover ? (danger ? t.bad : t.btnHover) : "transparent";
  const fg = hover && danger ? "#fff" : t.textDim;
  return (
    <button
      type="button"
      aria-label={aria}
      title={aria}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 44,
        height: HEIGHT,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: bg,
        color: fg,
        border: "none",
        outline: "none",
        cursor: "pointer",
        transition: "background 80ms linear, color 80ms linear",
      }}
    >
      {children}
    </button>
  );
}
