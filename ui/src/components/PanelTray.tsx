import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { placementOf, useAppStore, useResolvedTheme, type Drawer, type TrayItem } from "../store";
import { railRank } from "../lib/kindOrder";
import type { ResourceKind } from "../types";
import { FS_SM, FS_XS, R_SM, type Tokens } from "../theme";
import { IconBtn, Icons, resolveKindIcon } from "./ui";
import { dockDefaultSize } from "./Dock";
import { closeDockTabs } from "../lib/dockClose";
import { confirm } from "../lib/dialog";

export type TrayLabel = { title: string; subtitle: string };

/// Row text for a parked drawer: what it is (title) and what kind of view
/// (subtitle).
export function trayLabel(d: Drawer, kinds: ResourceKind[]): TrayLabel {
  switch (d.kind) {
    case "detail": {
      const kind = kinds.find((k) => k.id === d.kindId)?.kind ?? d.kindId;
      return { title: d.name, subtitle: d.namespace ? `${kind} · ${d.namespace}` : kind };
    }
    case "logs": {
      const what = d.initialTab === "metrics" ? "Metrics" : "Logs";
      const first = d.targets[0];
      return d.targets.length === 1 && first
        ? { title: first.name, subtitle: `${what} · ${first.namespace}` }
        : { title: `${d.targets.length} objects`, subtitle: what };
    }
    case "compare":
      return {
        title: `${d.target.a.name} ↔ ${d.target.b.name}`,
        subtitle: `Compare ${d.target.kindLabel}`,
      };
    case "inspect":
      return {
        title: `${d.target.subjects.length} × ${d.target.kindLabel}`,
        subtitle: "Inspect",
      };
  }
}

function drawerKindId(d: Drawer): string {
  switch (d.kind) {
    case "detail":
      return d.kindId;
    case "logs":
      return d.targets[0]?.kindId ?? "";
    case "compare":
    case "inspect":
      return d.target.kindId;
  }
}

const VIEW_ORDER: Record<Drawer["kind"], number> = { detail: 0, logs: 1, compare: 2, inspect: 3 };

/// Tray order mirrors the left rail: by the kind's rail position (groups,
/// then kinds within a group), then view type, then name. Stable regardless
/// of when each panel was hidden, so restoring and re-hiding never shuffles.
/// Kinds the rail doesn't list (another scope's CRD) sort last.
export function sortTray(items: TrayItem[], kinds: ResourceKind[]): TrayItem[] {
  const rank = railRank(kinds);
  const pos = (d: Drawer) => rank.get(drawerKindId(d)) ?? Number.MAX_SAFE_INTEGER;
  return [...items].sort(
    (a, b) =>
      pos(a.drawer) - pos(b.drawer) ||
      VIEW_ORDER[a.drawer.kind] - VIEW_ORDER[b.drawer.kind] ||
      trayLabel(a.drawer, kinds).title.localeCompare(trayLabel(b.drawer, kinds).title) ||
      a.id.localeCompare(b.id),
  );
}

function trayIcon(d: Drawer, kinds: ResourceKind[]): ReactNode {
  switch (d.kind) {
    case "detail": {
      const k = kinds.find((kk) => kk.id === d.kindId);
      return k ? resolveKindIcon(k.kind, k.group, k.category) : Icons.yaml;
    }
    case "logs":
      return d.initialTab === "metrics" ? Icons.gauge : Icons.logs;
    case "compare":
      return Icons.yaml;
    case "inspect":
      return Icons.layers;
  }
}

const COLLAPSED_W = 40;
// Expanded width follows the longest name, within these bounds.
const EXPANDED_MIN_W = 160;
const EXPANDED_MAX_W = 360;
// Everything in a row besides its text: row margins + icon cell + gaps +
// close button + left padding.
const ROW_CHROME_W = 8 + (COLLAPSED_W - 8) + 8 + 8 + 24 + 2;

export function expandedWidth(textWidths: number[]): number {
  const text = textWidths.length ? Math.max(...textWidths) : 0;
  return Math.min(EXPANDED_MAX_W, Math.max(EXPANDED_MIN_W, Math.ceil(text) + ROW_CHROME_W));
}
// How long the expanded list lingers before folding back to icons — after
// the pointer (or keyboard focus) leaves, and after hiding a panel, so the
// operator sees where it went. Re-entering within it keeps the list open.
const COLLAPSE_DELAY_MS = 1000;
const PEEK_MS = COLLAPSE_DELAY_MS;
// Just past the width transition (.18s).
const ARM_DELAY_MS = 220;
const CONTROLS_FADE = ".12s ease";

/// Close every hidden panel (and minimised chats) after one confirmation.
async function closeAll(chatIds: string[], drawers: number): Promise<void> {
  const parts: string[] = [];
  if (drawers > 0) parts.push(`${drawers} panel${drawers === 1 ? "" : "s"}`);
  if (chatIds.length > 0) parts.push(`${chatIds.length} chat${chatIds.length === 1 ? "" : "s"}`);
  const ok = await confirm({
    title: "Close all hidden panels?",
    body: `This closes ${parts.join(" and ")}.${chatIds.length > 0 ? " Chat sessions end." : ""}`,
    confirmLabel: "Close all",
    cancelLabel: "Keep",
    tone: "danger",
  });
  if (!ok) return;
  const s = useAppStore.getState();
  s.closeAllTrayItems();
  for (const id of chatIds) s.closeDockTab(id);
}

// Whether the most recent input came from the keyboard: focus only expands
// the tray when the operator tabbed into it, never after a click.
let keyboardModality = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => (keyboardModality = true), true);
  window.addEventListener("pointerdown", () => (keyboardModality = false), true);
}

type Row = {
  key: string;
  icon: ReactNode;
  title: string;
  subtitle: string;
  onRestore: () => void;
  onClose: () => void;
  closeTitle: string;
};

/// Right-edge tray of hidden panels for the active cluster tab: the chat
/// dock plus parked drawers. A column of icons at rest; hovering or focusing
/// it widens into a list with names (the rail's peek pattern, mirrored).
/// Docks against the open drawer's or chat dock's left edge.
export function PanelTray() {
  const t = useResolvedTheme().tokens;
  const tray = useAppStore((s) => s.tray);
  const kinds = useAppStore((s) => s.kinds);
  const drawerOpen = useAppStore((s) => s.drawer !== null);
  const drawerId = useAppStore((s) => s.drawerId);
  // A count, not the tabs: dock tabs change on every YAML keystroke.
  const chatCount = useAppStore((s) =>
    s.dockTabs.reduce((n, d) => (placementOf(d) === "right" ? n + 1 : n), 0),
  );
  const chatMin = useAppStore((s) => s.dockMin.right);
  const dockWidth = useAppStore((s) => s.dockSize.right);
  const setDockMin = useAppStore((s) => s.setDockMin);
  const restore = useAppStore((s) => s.restoreTrayItem);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const close = useAppStore((s) => s.closeTrayItem);
  const [open, setOpen] = useState(false);
  // Close buttons stay inert until the expand finishes: the pointer that
  // opened the tray must never land a click on one.
  const [armed, setArmed] = useState(false);
  // The operator is using the list (pointer over it, or tabbed in) — as
  // opposed to the brief preview after hiding a panel. Close controls exist
  // only while engaged, and vanish before the tray folds up.
  const [engaged, setEngaged] = useState(false);
  useEffect(() => {
    if (!open) {
      setArmed(false);
      return;
    }
    const id = window.setTimeout(() => setArmed(true), ARM_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [open]);
  const timer = useRef<number | null>(null);
  const hoverRef = useRef(false);
  const collapseIn = (delay: number) => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(false), delay);
  };
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );

  const sorted = useMemo(() => sortTray(tray, kinds), [tray, kinds]);
  const rows: Row[] = [];
  // Only a hidden chat is in the tray; an open one is not the tray's to close.
  const hiddenChatIds = () =>
    chatMin ? useAppStore.getState().dockTabs.filter((d) => placementOf(d) === "right").map((d) => d.id) : [];
  if (chatCount > 0 && chatMin) {
    rows.push({
      key: "chat",
      icon: Icons.chat,
      title: chatCount === 1 ? "Chat" : `${chatCount} chats`,
      subtitle: "AI assistant",
      onRestore: () => setDockMin("right", false),
      onClose: () => void closeDockTabs(hiddenChatIds()),
      closeTitle: chatCount === 1 ? "Close chat" : "Close all chats",
    });
  }
  // Chat first, then parked drawers in rail order.
  for (const item of sorted) {
    const { title, subtitle } = trayLabel(item.drawer, kinds);
    rows.push({
      key: item.id,
      icon: trayIcon(item.drawer, kinds),
      title,
      subtitle,
      onRestore: () => restore(item.id),
      onClose: () => close(item.id),
      closeTitle: `Close ${title}`,
    });
  }
  // Natural width of the longest title/subtitle (scrollWidth ignores the
  // clipping), re-measured when the set of names changes.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [expandedW, setExpandedW] = useState(EXPANDED_MIN_W);
  const textKey = rows.map((r) => `${r.title}\u0000${r.subtitle}`).join("\u0001");
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const widths = Array.from(el.querySelectorAll<HTMLElement>("[data-tray-text]"), (n) => n.scrollWidth);
    setExpandedW(expandedWidth(widths));
  }, [textKey]);

  // The tray docks against whatever is open on the right, so opening,
  // swapping or hiding a panel (or the chat) moves it out from under a
  // still pointer — and browsers send no mouseleave for that. Drop the hover
  // and fold. Declared before the preview effect so a hide still previews.
  const placementKey = `${drawerOpen ? (drawerId ?? "drawer") : ""}|${chatCount > 0 && !chatMin}`;
  const placedRef = useRef(placementKey);
  useEffect(() => {
    if (placedRef.current === placementKey) return;
    placedRef.current = placementKey;
    hoverRef.current = false;
    setEngaged(false);
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  }, [placementKey]);

  // Briefly show a newly hidden panel's row, then fold back to icons. Not on
  // first mount or a cluster-tab switch: those show an existing tray.
  const rowKeys = rows.map((r) => r.key).join("\u0000");
  const seenRef = useRef<{ tab: string | null; keys: Set<string> } | null>(null);
  useEffect(() => {
    const keys = new Set(rowKeys ? rowKeys.split("\u0000") : []);
    const prev = seenRef.current;
    seenRef.current = { tab: activeTabId, keys };
    if (!prev || prev.tab !== activeTabId || hoverRef.current) return;
    if ([...keys].some((k) => !prev.keys.has(k))) {
      setOpen(true);
      collapseIn(PEEK_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowKeys, activeTabId]);

  if (rows.length === 0) return null;

  // Close all only while the operator is using the list (never during the
  // preview), leaving the moment the pointer does. Row × follow the labels.
  const controls = engaged && open && armed;

  const show = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    setOpen(true);
  };

  const chatOpen = chatCount > 0 && !chatMin;
  const edge = chatOpen ? `${dockWidth ?? dockDefaultSize("right")}px` : "0px";

  return (
    <div
      ref={listRef}
      role="list"
      aria-label="Hidden panels"
      data-testid="panel-tray"
      data-open={open ? "true" : "false"}
      onMouseEnter={() => {
        hoverRef.current = true;
        setEngaged(true);
        show();
      }}
      onMouseLeave={() => {
        hoverRef.current = false;
        setEngaged(false);
        collapseIn(COLLAPSE_DELAY_MS);
      }}
      // Keyboard focus only: a clicked row keeps focus, and that must not
      // hold the tray open once the pointer has gone.
      onFocus={() => {
        if (keyboardModality) {
          setEngaged(true);
          show();
        }
      }}
      onBlur={(e) => {
        if (!hoverRef.current && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setEngaged(false);
          collapseIn(COLLAPSE_DELAY_MS);
        }
      }}
      style={{
        position: "fixed",
        // Level with the table body, under the header row and its column
        // picker; falls back below the chrome when no table is mounted.
        top: "calc(var(--fs-table-body-top, calc(60px + var(--fs-titlebar-h, 0px))) + 4px)",
        right: `var(--fs-drawer-w, ${edge})`,
        width: open ? expandedW : COLLAPSED_W,
        maxHeight: "calc(100vh - 20px - var(--fs-table-body-top, calc(60px + var(--fs-titlebar-h, 0px))))",
        overflowX: "hidden",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "4px 0",
        background: t.headerAlt,
        border: `1px solid ${t.border}`,
        borderRight: "none",
        borderTopLeftRadius: 8,
        borderBottomLeftRadius: 8,
        boxShadow: open ? "-4px 0 16px rgba(15,20,30,0.12)" : "none",
        transition: "width .18s cubic-bezier(.2,.7,.2,1), box-shadow .18s",
        // Above the drawer scrim so hidden panels stay reachable.
        zIndex: drawerOpen ? 32 : 26,
      }}
    >
      {rows.map((r) => (
        <TrayRow key={r.key} t={t} row={r} open={open} armed={armed} />
      ))}
      {rows.length > 1 && (
        // Height eases via grid rows so the list never jumps; fades with
        // the row controls.
        <div
          style={{
            display: "grid",
            gridTemplateRows: controls ? "1fr" : "0fr",
            opacity: controls ? 1 : 0,
            transition: `grid-template-rows ${CONTROLS_FADE}, opacity ${CONTROLS_FADE}`,
          }}
        >
          <div style={{ overflow: "hidden", minHeight: 0 }}>
            <button
              type="button"
              data-testid="tray-close-all"
              tabIndex={controls ? 0 : -1}
              aria-hidden={!controls}
              onClick={() => void closeAll(hiddenChatIds(), tray.length)}
              style={{
                display: "block",
                width: "calc(100% - 8px)",
                margin: "4px 4px 2px",
                padding: "6px 10px",
                border: "none",
                borderTop: `1px solid ${t.borderSoft}`,
                background: "transparent",
                color: t.textDim,
                fontSize: FS_XS,
                textAlign: "left",
                whiteSpace: "nowrap",
                cursor: "pointer",
                pointerEvents: controls ? undefined : "none",
              }}
            >
              Close all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Mirrored rail row: the icon sits on the tray's fixed right edge, under the
// pointer that opened it; name and close extend leftwards, close furthest away.
function TrayRow({ t, row, open, armed }: { t: Tokens; row: Row; open: boolean; armed: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      role="listitem"
      tabIndex={0}
      aria-label={`Restore ${row.title} — ${row.subtitle}`}
      onClick={(e) => {
        e.currentTarget.blur();
        row.onRestore();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          row.onRestore();
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          row.onClose();
        }
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        row.onClose();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        flexDirection: "row-reverse",
        alignItems: "center",
        gap: 8,
        height: 36,
        margin: "0 4px",
        paddingLeft: 2,
        borderRadius: R_SM,
        background: hover ? t.hover : "transparent",
        cursor: "pointer",
        transition: "background .12s",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: COLLAPSED_W - 8,
          flexShrink: 0,
          display: "flex",
          justifyContent: "center",
          color: hover ? t.text : t.textDim,
        }}
      >
        {row.icon}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          opacity: open ? 1 : 0,
          transition: "opacity .15s",
          whiteSpace: "nowrap",
        }}
      >
        <span
          style={{
            fontSize: FS_SM,
            fontWeight: 500,
            color: t.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: "100%",
          }}
          data-tray-text
        >
          {row.title}
        </span>
        <span
          style={{
            fontSize: FS_XS,
            color: t.textMuted,
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: "100%",
          }}
          data-tray-text
        >
          {row.subtitle}
        </span>
      </span>
      {/* Always mounted (clipped while collapsed) and fading with the
          labels. Clicks wait for the expand to finish, so the pointer that
          opened the tray can't close anything. */}
      <span
        onClick={(e) => e.stopPropagation()}
        data-armed={open && armed ? "true" : "false"}
        aria-hidden={!open}
        style={{
          display: "flex",
          flexShrink: 0,
          opacity: open ? 1 : 0,
          transition: "opacity .15s",
          pointerEvents: open && armed ? undefined : "none",
        }}
      >
        <IconBtn t={t} title={row.closeTitle} onClick={row.onClose}>
          {Icons.close}
        </IconBtn>
      </span>
    </div>
  );
}
