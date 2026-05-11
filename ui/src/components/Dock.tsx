import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import jsYaml from "js-yaml";
import Editor from "@monaco-editor/react";
import { useAppStore, type DockPlacement, type DockTab, useResolvedTheme } from "../store";
import { DockChat } from "./chat/DockChat";
import { FF_MONO, type ThemeMode, R_MD, R_SM, FS_MD, FS_SM, FS_XS } from "../theme";
import { Btn, ErrorBlock, IconBtn, Icons, Select } from "./ui";
import { api } from "../api";
import type { DocApplyResult } from "../types";
import { installClipboardShortcuts } from "../lib/monacoClipboard";
import {
  YAML_TEMPLATES,
  YAML_TEMPLATE_CATEGORIES,
  DEFAULT_YAML_TEMPLATE_ID,
  getYamlTemplate,
} from "../lib/yamlTemplates";

let _seq = 1;

// Terminal tab state. `mode` selects shell vs. pod-exec; the rest is the
// per-mode spawn payload that DockTerminal consumes once on mount.
export type TerminalTabSpec =
  | { mode: "shell"; clusterId: string; namespace: string | null }
  | {
      mode: "exec";
      clusterId: string;
      namespace: string;
      pod: string;
      container: string | null;
      command?: string[];
    }
  | {
      mode: "kubectl";
      clusterId: string;
      namespace: string | null;
      args: string[];
      label: string;
      // Inline JSON for `kubectl debug --custom`. The backend writes it
      // to a temp file and appends `--custom=<path>` to the command —
      // kubectl refuses inline JSON via that flag, the temp-file dance
      // is the supported path. Optional; only node debug uses it today.
      customProfile?: string;
      // Pod the backend should delete when the terminal session ends. Used
      // by node debug — kubectl debug leaves the pod behind otherwise.
      cleanup?: { namespace: string; name: string };
    };

const shortContext = (s: string): string =>
  (s.split(/[\s./]/)[0] ?? s).toLowerCase();

export function makeTerminalTab(
  spec: TerminalTabSpec,
  contextLabel: string,
): DockTab {
  const id = `term-${_seq++}`;
  const title =
    spec.mode === "shell"
      ? `kubectl@${shortContext(contextLabel)}`
      : spec.mode === "exec"
        ? `exec ${spec.pod}${spec.container ? `:${spec.container}` : ""}`
        : spec.label;
  return {
    id,
    kind: "terminal",
    title,
    placement: "bottom",
    state: { spec },
  };
}

export function makeYamlTab(
  clusterId?: string | null,
  templateId: string = DEFAULT_YAML_TEMPLATE_ID,
): DockTab {
  const tpl = getYamlTemplate(templateId);
  return {
    id: `yaml-${_seq++}`,
    kind: "yaml",
    title: "manifest.yaml",
    placement: "bottom",
    state: {
      content: tpl.yaml,
      templateId: tpl.id,
      pristine: true,
      clusterId: clusterId ?? null,
      results: null,
      busy: false,
      validateError: null,
    },
  };
}

// AI chat tab — bound to a cluster at creation, opens in the right-side dock.
// `state.sessionId` and `state.chatId` are filled in by DockChat when it opens
// the live channel. Title is the session title (default "New chat").
export function makeChatTab(
  clusterId: string,
  contextLabel: string,
  sessionId?: string,
): DockTab {
  return {
    id: `chat-${_seq++}`,
    kind: "chat",
    title: `chat@${shortContext(contextLabel)}`,
    placement: "right",
    state: {
      clusterId,
      contextLabel,
      sessionId: sessionId ?? null,
      chatId: null,
    },
  };
}

type Props = {
  mode: ThemeMode;
  clusterName: string;
  clusterId: string | null;
  // Inset from the left so the dock doesn't sit under the rail.
  leftInset: number;
  // Which placement this Dock instance owns. App.tsx mounts <Dock> twice —
  // one per placement — and each instance only sees its own tabs.
  placement: DockPlacement;
};

// HV2Dock — tabbed panel hosting terminal scratchpads, YAML editors, and AI
// chats. Two placements share this primitive: "bottom" is the original
// full-width strip resized from the top edge; "right" is the side panel
// resized from the left edge. Each placement owns its own minimise state.
export function Dock({
  mode,
  clusterName,
  clusterId,
  leftInset,
  placement,
}: Props) {
  const t = useResolvedTheme().tokens;
  const allTabs = useAppStore((s) => s.dockTabs);
  const activeTabId = useAppStore((s) => s.dockActiveId);
  const dockMin = useAppStore((s) => s.dockMin);
  const setDockMin = useAppStore((s) => s.setDockMin);
  const setActiveId = useAppStore((s) => s.setDockActiveId);
  const closeTab = useAppStore((s) => s.closeDockTab);
  const closeAllPlacement = useAppStore((s) => s.closeDockTabsByPlacement);
  const addTab = useAppStore((s) => s.addDockTab);
  const patchState = useAppStore((s) => s.patchDockTabState);

  const tabs = useMemo(
    () => allTabs.filter((tt) => (tt.placement ?? "bottom") === placement),
    [allTabs, placement],
  );

  const isMin = dockMin[placement];
  const horizontal = placement === "right";

  // Vertical placements size by width (resized from left edge); the bottom
  // placement sizes by height (resized from top edge). Persisted via prefs:
  // `dockSize[placement]` is `null` until the operator drags or until prefs
  // hydrate. We fall back to a viewport-relative default so first-launch
  // looks reasonable on every screen size.
  const persistedSize = useAppStore((s) => s.dockSize[placement]);
  const setPersistedSize = useAppStore((s) => s.setDockSize);
  const defaultSize = horizontal
    ? Math.max(320, Math.min(480, window.innerWidth - 280))
    : Math.max(180, Math.min(320, window.innerHeight - 200));
  const size = persistedSize ?? defaultSize;
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const start = horizontal ? e.clientX : e.clientY;
    const startSize = size;
    const onMove = (ev: MouseEvent) => {
      const delta = horizontal
        ? start - ev.clientX
        : start - ev.clientY;
      const next = horizontal
        ? Math.max(320, Math.min(window.innerWidth - 280, startSize + delta))
        : Math.max(180, Math.min(window.innerHeight - 200, startSize + delta));
      setPersistedSize(placement, next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (tabs.length === 0) return null;

  // The right-placement minimised strip parks against the right edge as a
  // narrow vertical pill so it doesn't fight the bottom strip for screen real
  // estate. Bottom keeps its original full-width behaviour.
  //
  // CRITICAL: when minimised we still render the main panel below (with
  // `display: none`) so React keeps every tab's component tree mounted.
  // Unmounting tears down a chat's `Channel<ChatEvent>` and its native-tool
  // lifecycle (debug pods, etc. — see `agent_native::on_chat_close`), which
  // the operator emphatically does NOT want when they only hid the dock.
  // Same reason terminals stay mounted on tab switch (line 608 below).
  const minimisedStrip = !isMin
    ? null
    : horizontal
    ? (
        <div
          style={{
            position: "fixed",
            top: "calc(60px + var(--fs-titlebar-h, 0px))",
            right: 0,
            background: t.headerAlt,
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
            {tabs.length} chat{tabs.length === 1 ? "" : "s"}
          </span>
          <IconBtn
            t={t}
            title="Restore"
            onClick={() => setDockMin(placement, false)}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            >
              <path d="M3 6h6M6 3v6" />
            </svg>
          </IconBtn>
          <IconBtn
            t={t}
            title="Close all chats"
            onClick={() => closeAllPlacement(placement)}
          >
            {Icons.close}
          </IconBtn>
        </div>
      )
    : (
        <div
          style={{
            position: "fixed",
            left: leftInset,
            right: 0,
            bottom: 0,
            background: t.headerAlt,
            borderTop: `1px solid ${t.border}`,
            padding: "6px 14px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            zIndex: 25,
            fontSize: FS_MD,
          }}
        >
          <span style={{ color: t.textDim, display: "inline-flex" }}>
            {Icons.shell}
          </span>
          <span style={{ color: t.textDim, fontWeight: 500 }}>Dock</span>
          <span style={{ color: t.textMuted }}>·</span>
          <span style={{ color: t.textMuted }}>
            {tabs.length} tab{tabs.length === 1 ? "" : "s"}
          </span>
          <div style={{ flex: 1 }} />
          <Btn
            t={t}
            variant="secondary"
            size="sm"
            onClick={() => setDockMin(placement, false)}
          >
            Restore
          </Btn>
          <IconBtn t={t} title="Close dock" onClick={() => closeAllPlacement(placement)}>
            {Icons.close}
          </IconBtn>
        </div>
      );

  const activeInPlacement =
    tabs.find((tt) => tt.id === activeTabId) ?? tabs[0];

  // When minimised, swap the panel to `display: none` rather than skipping
  // the render. React keeps every tab's component tree (DockChat, DockTerminal)
  // mounted, so chats keep streaming, debug pods stay alive, and PTYs don't die.
  // The strip rendered alongside is what the operator interacts with.
  const panelStyle: React.CSSProperties = horizontal
    ? {
        position: "fixed",
        top: "var(--fs-titlebar-h, 0px)",
        right: 0,
        bottom: 0,
        width: size,
        display: isMin ? "none" : "flex",
        flexDirection: "column",
        background: t.surface,
        borderLeft: `1px solid ${t.border}`,
        boxShadow:
          mode === "dark"
            ? "-8px 0 24px rgba(0,0,0,0.4)"
            : "-8px 0 24px rgba(15,20,30,0.08)",
        zIndex: 25,
      }
    : {
        position: "fixed",
        left: leftInset,
        right: 0,
        bottom: 0,
        height: size,
        display: isMin ? "none" : "flex",
        flexDirection: "column",
        background: t.surface,
        borderTop: `1px solid ${t.border}`,
        boxShadow:
          mode === "dark"
            ? "0 -8px 24px rgba(0,0,0,0.4)"
            : "0 -8px 24px rgba(15,20,30,0.08)",
        zIndex: 25,
      };

  return (
    <>
      {minimisedStrip}
      <div style={panelStyle}>
      <div
        onMouseDown={onDragStart}
        style={
          horizontal
            ? {
                width: 6,
                marginLeft: -3,
                cursor: "ew-resize",
                position: "absolute",
                top: 0,
                bottom: 0,
                left: 0,
                zIndex: 2,
              }
            : {
                height: 6,
                marginTop: -3,
                cursor: "ns-resize",
                position: "absolute",
                left: 0,
                right: 0,
                top: 0,
                zIndex: 2,
              }
        }
      />

      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          background: t.headerAlt,
          borderBottom: `1px solid ${t.border}`,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            flex: 1,
            minWidth: 0,
            overflowX: "auto",
          }}
        >
          {/*
            Right-placement chat dock with a single tab: skip the tab strip
            entirely. The "AI chat" menu is idempotent (one chat tab per
            cluster), so a single-tab right dock is the steady state — the
            header chip already names the bound cluster, and the title row
            below it (in DockChat's own header) shows the active session.
            Repeating that as a tab pill is just chrome. Multi-tab right
            docks (more than one cluster's chat open at once) still get the
            strip back so tabs can be navigated and closed.
          */}
          {!(horizontal && tabs.length === 1) && tabs.map((tab) => {
            const isActive = tab.id === activeInPlacement?.id;
            return (
              <div
                key={tab.id}
                onClick={() => setActiveId(tab.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "0 10px 0 12px",
                  height: 34,
                  borderRight: `1px solid ${t.borderSoft}`,
                  background: isActive ? t.surface : "transparent",
                  borderBottom: `2px solid ${
                    isActive ? t.accent : "transparent"
                  }`,
                  marginBottom: -1,
                  cursor: "pointer",
                  minWidth: 0,
                  fontSize: FS_SM,
                  color: isActive ? t.text : t.textDim,
                  fontWeight: isActive ? 600 : 500,
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    color: isActive ? t.accent : t.textMuted,
                  }}
                >
                  {tab.kind === "terminal"
                    ? Icons.shell
                    : tab.kind === "yaml"
                      ? Icons.yaml
                      : Icons.chat}
                </span>
                <span
                  style={{
                    fontFamily: FF_MONO,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 180,
                  }}
                >
                  {tab.title}
                </span>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    title="Close tab"
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = t.hover)
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background = "transparent")
                    }
                    style={{
                      border: "none",
                      background: "transparent",
                      padding: 2,
                      marginLeft: 2,
                      cursor: "pointer",
                      color: t.textMuted,
                      display: "flex",
                      borderRadius: R_SM,
                    }}
                  >
                    <svg
                      width="9"
                      height="9"
                      viewBox="0 0 10 10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    >
                      <path d="M2 2l6 6M8 2l-6 6" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "0 8px 0 6px",
            borderLeft: `1px solid ${t.borderSoft}`,
            flexShrink: 0,
          }}
        >
          {!horizontal && (
            <>
              <IconBtn
                t={t}
                title="New terminal"
                onClick={() => {
                  if (!clusterId) return;
                  addTab(
                    makeTerminalTab(
                      { mode: "shell", clusterId, namespace: null },
                      clusterName,
                    ),
                  );
                }}
              >
                {Icons.shell}
              </IconBtn>
              <IconBtn
                t={t}
                title="New YAML"
                onClick={() => addTab(makeYamlTab(clusterId))}
              >
                {Icons.yaml}
              </IconBtn>
              <div
                style={{
                  width: 1,
                  height: 16,
                  background: t.borderSoft,
                  margin: "0 3px",
                }}
              />
            </>
          )}
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 8px",
              borderRadius: R_MD,
              background: t.chip,
              fontSize: FS_XS,
              color: t.textDim,
              fontFamily: FF_MONO,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: t.good,
                display: "inline-block",
              }}
            />
            {clusterName}
          </div>
          <div
            style={{
              width: 1,
              height: 16,
              background: t.borderSoft,
              margin: "0 3px",
            }}
          />
          <IconBtn
            t={t}
            title="Minimize"
            onClick={() => setDockMin(placement, true)}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            >
              <path d="M2 9h8" />
            </svg>
          </IconBtn>
          <IconBtn
            t={t}
            title={horizontal ? "Close all chats" : "Close dock"}
            onClick={() => closeAllPlacement(placement)}
          >
            {Icons.close}
          </IconBtn>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {tabs.map((tab) => {
          const visible = tab.id === activeInPlacement?.id;
          // Keep every tab mounted but hidden — terminals own a live PTY
          // session, so unmounting on tab switch would tear it down. Chat
          // tabs likewise own a live event channel.
          return (
            <div
              key={tab.id}
              style={{
                position: "absolute",
                inset: 0,
                visibility: visible ? "visible" : "hidden",
              }}
            >
              {tab.kind === "terminal" ? (
                <DockTerminal mode={mode} tab={tab} visible={visible} />
              ) : tab.kind === "yaml" ? (
                <DockYaml
                  mode={mode}
                  tab={tab}
                  onPatch={(p) => patchState(tab.id, p)}
                />
              ) : (
                <DockChat mode={mode} tab={tab} visible={visible} />
              )}
            </div>
          );
        })}
      </div>
      </div>
    </>
  );
}

// ── Terminal tab ───────────────────────────────────────────────────────────

function DockTerminal({
  tab,
  visible,
}: {
  mode: ThemeMode;
  tab: DockTab;
  visible: boolean;
}) {
  const resolved = useResolvedTheme();
  const t = resolved.tokens;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<
    "starting" | "ready" | "exited" | "error"
  >("starting");
  const [error, setError] = useState<string | null>(null);

  const spec = tab.state.spec as TerminalTabSpec | undefined;

  // One-time: open the PTY session, mount xterm, wire bidirectional pipes.
  useEffect(() => {
    if (!hostRef.current || !spec) return;
    const host = hostRef.current;

    // Channel-based detach: `terminalOpen*` returns a `close` that drops further
    // messages — replaces the prior `unlisten()` pair from the listen()-based
    // event API.
    let detachChannel: (() => void) | null = null;
    let cancelled = false;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let fitRaf = 0;

    // Fit pipeline (cribbed from thermic's terminal.js):
    //   1. Bail if the host isn't visible yet — fit() against a hidden
    //      container measures 0×0 and locks xterm to 1 row, leaving the
    //      cursor stuck at the top after the host is finally shown.
    //   2. Force a sync reflow (`offsetHeight`) so clientWidth/clientHeight
    //      are fresh after a parent flex change.
    //   3. Use proposeDimensions to pick cols/rows; resize the term first
    //      to those values, THEN call fit(). Single-pass fit() can leave a
    //      sub-pixel mismatch where xterm renders one more row than the
    //      visible area — that's the "cursor cut in half at the bottom"
    //      symptom. The two-step settles the renderer cleanly.
    const isVisible = (el: HTMLElement): boolean => {
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const fitNow = () => {
      const f = fitRef.current;
      const t = termRef.current;
      if (!f || !t) return;
      if (!isVisible(host)) return;
      // Force layout flush before measuring.
      void host.offsetHeight;
      try {
        const proposed = f.proposeDimensions();
        if (
          proposed &&
          proposed.cols > 0 &&
          proposed.rows > 0 &&
          (proposed.cols !== t.cols || proposed.rows !== t.rows)
        ) {
          t.resize(proposed.cols, proposed.rows);
        }
        f.fit();
      } catch {
        /* host not measurable yet */
      }
    };
    // Coalesce bursts (RO during a drag, window resize) onto the next frame.
    const scheduleFit = () => {
      if (fitRaf) return;
      fitRaf = requestAnimationFrame(() => {
        fitRaf = 0;
        fitNow();
      });
    };

    const start = async () => {
      try {
        // Wait for the monospace font to actually load before mounting
        // xterm. xterm measures cell width once at `term.open(host)` time
        // by writing a hidden glyph and reading its bounding box. If the
        // configured font hasn't loaded yet the browser substitutes a
        // *much* wider system fallback, xterm caches that wide cell, and
        // the terminal opens at ~half the host width with the right side
        // black — exactly the "half wide on init" symptom. fit() can't
        // fix this after the fact: cell width is sticky.
        if (typeof document !== "undefined" && document.fonts?.ready) {
          try {
            await document.fonts.ready;
          } catch {
            /* older WebKitGTK without the FontFaceSet API — proceed */
          }
        }
        // Layout settle so host has its real size before xterm measures.
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (cancelled) return;

        term = new Terminal({
          // xterm wants a literal font string and a numeric size — CSS
          // custom properties don't apply inside the canvas-rendered grid.
          // `typography.fontMono` is a literal per-theme stack (e.g.
          // VS Code's Cascadia, Default's JetBrains), so we can pass it
          // through.
          fontFamily: resolved.typography.fontMono,
          fontSize: 13,
          lineHeight: 1.2,
          cursorBlink: true,
          convertEol: true,
          allowProposedApi: true,
          theme: {
            // xterm reads literal colors at construction time — it doesn't
            // respond to subsequent token changes. The active palette's
            // surface + text flow through here so light themes get a
            // light-paper terminal (IDE-style) and dark themes stay dark.
            // ANSI colors emitted by the shell aren't remapped — that's
            // the program's choice.
            background: t.surfaceAlt,
            foreground: t.text,
            cursor: t.good,
          },
        });
        fit = new FitAddon();
        term.loadAddon(fit);
        term.loadAddon(new WebLinksAddon());
        term.open(host);
        // Auto-copy on selection (terminal-style UX): the moment the
        // operator finishes a drag-select / shift-arrow extension, the
        // selected text lands on the system clipboard. xterm fires
        // `onSelectionChange` for every extension *and* every clear, so
        // we coalesce onto one rAF (avoid spamming clipboard.writeText
        // mid-drag) and skip empty strings (clears shouldn't wipe the
        // clipboard). Paste path is unchanged — Ctrl/Cmd+V still routes
        // through xterm's default paste handler into the PTY.
        let copyRaf = 0;
        term.onSelectionChange(() => {
          if (copyRaf) return;
          copyRaf = requestAnimationFrame(() => {
            copyRaf = 0;
            const sel = termRef.current?.getSelection();
            if (!sel) return;
            // xterm returns multi-row selections with `\r\n` between rows;
            // some paste targets (chat apps, GitHub markdown editors, …)
            // treat the `\r` as part of the line and render the `\n`
            // away, so multi-line copies arrive as one blob with spaces.
            // Normalise to plain `\n` so paste matches the visual rows.
            const normalised = sel.replace(/\r\n?/g, "\n");
            navigator.clipboard?.writeText(normalised).catch(() => {
              /* permission denied / non-secure context */
            });
          });
        });
        // WebGL renderer was previously loaded here for GPU-accelerated
        // compositing. Removed: addon-webgl@0.19 references
        // `Terminal._core._store` which only exists on xterm 6.x; on 5.5
        // it throws asynchronously from a buffer-change listener and
        // unmounts the dock.
        termRef.current = term;
        fitRef.current = fit;

        // Pre-IPC fit so the terminal renders at full width while we
        // wait for the backend to spawn the PTY. Otherwise the user
        // stares at an 80-col strip for 50–200 ms of round-trip time.
        fitNow();

        // PTY output flows over a Tauri IPC Channel. The handlers are bound
        // at open time, so there's no listen()/unlisten() round-trip per
        // session; `close()` (returned by the wrapper) detaches further
        // messages so a chunk arriving after unmount can't reach a stale
        // `term`.
        const onData = (b64: string) => {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          term?.write(bytes);
        };
        const onExit = (code: number) => {
          term?.writeln(
            `\r\n\x1b[2;37m[FerrisScope] session ended (code ${code})\x1b[0m`,
          );
          setStatus("exited");
        };

        const opened =
          spec.mode === "shell"
            ? await api.terminalOpenShell(
                spec.clusterId,
                spec.namespace,
                onData,
                onExit,
              )
            : spec.mode === "exec"
              ? await api.terminalOpenExec(
                  spec.clusterId,
                  spec.namespace,
                  spec.pod,
                  spec.container,
                  spec.command ?? null,
                  onData,
                  onExit,
                )
              : await api.terminalOpenKubectl(
                  spec.clusterId,
                  spec.namespace,
                  spec.args,
                  spec.customProfile ?? null,
                  spec.cleanup
                    ? {
                        clusterId: spec.clusterId,
                        namespace: spec.cleanup.namespace,
                        name: spec.cleanup.name,
                      }
                    : null,
                  onData,
                  onExit,
                );
        const id = opened.sessionId;
        if (cancelled) {
          opened.close();
          api.terminalClose(id).catch(() => {});
          return;
        }
        sessionIdRef.current = id;
        detachChannel = opened.close;

        term.onData((data) => {
          // xterm emits already-decoded strings; we re-encode to bytes.
          const enc = new TextEncoder().encode(data);
          let bin = "";
          for (let i = 0; i < enc.length; i++)
            bin += String.fromCharCode(enc[i]!);
          api.terminalWrite(id, btoa(bin)).catch(() => {});
        });
        term.onResize(({ cols, rows }) => {
          api.terminalResize(id, cols, rows).catch(() => {});
        });

        // Final fit after a layout settle — picks up any size changes
        // that landed during the IPC await (the dock body finishing its
        // first flex pass, scrollbar gutters appearing, etc.). Push the
        // resulting size to the PTY so the shell's $COLUMNS/$LINES are
        // correct *before* the prompt prints.
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        await new Promise<void>((r) => setTimeout(r, 10));
        fitNow();
        if (term) {
          api.terminalResize(id, term.cols, term.rows).catch(() => {});
          term.refresh(0, term.rows - 1);
        }
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        setError(String(e));
        setStatus("error");
      }
    };
    start();

    const ro = new ResizeObserver(() => scheduleFit());
    ro.observe(host);
    // Window resize doesn't necessarily change the host's content rect (the
    // dock is `position: fixed` with a constant height), but it can —
    // e.g. when the Tauri window shrinks below the dock's height the flex
    // parent reshuffles. Catch both to be safe.
    window.addEventListener("resize", scheduleFit);

    return () => {
      cancelled = true;
      if (fitRaf) cancelAnimationFrame(fitRaf);
      window.removeEventListener("resize", scheduleFit);
      ro.disconnect();
      detachChannel?.();
      const id = sessionIdRef.current;
      if (id) api.terminalClose(id).catch(() => {});
      // term may be null if cleanup ran before `start()` finished mounting
      // xterm (e.g. tab closed during the fonts.ready / IPC await window).
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // Spec is captured once at mount on purpose — the tab state doesn't change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When this tab becomes visible after a switch, re-fit (xterm size goes
  // stale while hidden) and refocus. Two rAFs + a tick mirrors the mount
  // path so the first measurement after `visibility: visible` flips isn't
  // taken against the hidden 0×0 size.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => setTimeout(r, 10));
      if (cancelled) return;
      const f = fitRef.current;
      const t = termRef.current;
      const host = hostRef.current;
      if (!f || !t || !host) return;
      void host.offsetHeight;
      try {
        const proposed = f.proposeDimensions();
        if (
          proposed &&
          proposed.cols > 0 &&
          proposed.rows > 0 &&
          (proposed.cols !== t.cols || proposed.rows !== t.rows)
        ) {
          t.resize(proposed.cols, proposed.rows);
        }
        f.fit();
      } catch {
        /* */
      }
      t.focus();
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        // Matches the xterm theme background so the surrounding chrome
        // doesn't peek through during fit-resizes.
        background: t.surfaceAlt,
        display: "flex",
        flexDirection: "column",
        // Padding belongs on the outer wrapper, not the host. xterm's inner
        // viewport is `position: absolute; inset: 0` against the host, so
        // padding on the host shrinks the cell box but xterm renders into
        // the padding region anyway — last row gets clipped by the padding
        // edge ("cursor cut in half" symptom).
        padding: 8,
      }}
    >
      <div
        ref={hostRef}
        style={{ flex: 1, minHeight: 0 }}
        onClick={() => termRef.current?.focus()}
      />
      {status === "error" && (
        <div
          style={{
            padding: "6px 10px",
            background: t.bad + "22",
            borderTop: `1px solid ${t.border}`,
          }}
        >
          <ErrorBlock
            t={t}
            message={error ?? "failed to start session"}
            kindLabel="terminal session"
            inline
          />
        </div>
      )}
    </div>
  );
}

// ── YAML scratchpad tab ─────────────────────────────────────────────────────

type YamlTabState = {
  content: string;
  // Id of the starter template the buffer was seeded from. Drives the
  // template picker's selected value and the safe-swap check.
  templateId: string;
  // True until the user types into the editor or appends another doc.
  // Once dirty, switching the *base* template prompts before clobbering;
  // appending is always additive, so it doesn't toggle this.
  pristine: boolean;
  clusterId: string | null;
  results: DocApplyResult[] | null;
  busy: boolean;
  validateError: string | null;
};

const ADD_RESOURCE_VALUE = "__add_resource__";

// Append a manifest as a new YAML doc, separated by `---`. Trims trailing
// blank lines off the existing buffer so the document boundary lands on a
// clean separator regardless of whether the prior buffer ended with a
// newline.
function appendYamlDoc(prev: string, next: string): string {
  const trimmedPrev = prev.replace(/\s+$/, "");
  const trimmedNext = next.replace(/^\s+|\s+$/g, "");
  if (!trimmedPrev) return `${trimmedNext}\n`;
  return `${trimmedPrev}\n---\n${trimmedNext}\n`;
}

function DockYaml({
  mode,
  tab,
  onPatch,
}: {
  mode: ThemeMode;
  tab: DockTab;
  onPatch: (p: Partial<YamlTabState>) => void;
}) {
  const resolved = useResolvedTheme();
  const t = resolved.tokens;
  const st = tab.state as Partial<YamlTabState>;
  const content = st.content ?? "";
  const templateId = st.templateId ?? DEFAULT_YAML_TEMPLATE_ID;
  const pristine = st.pristine ?? false;
  const clusterId = st.clusterId ?? null;
  const results = st.results ?? null;
  const busy = !!st.busy;
  const validateError = st.validateError ?? null;

  // Template picker options grouped by category. The Select atom is flat,
  // so we prepend a non-selectable header row per category by encoding it
  // as an option whose value matches itself — the onChange handler ignores
  // category sentinels and keeps the previous selection.
  const templateOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (const cat of YAML_TEMPLATE_CATEGORIES) {
      const items = YAML_TEMPLATES.filter((tpl) => tpl.category === cat);
      if (items.length === 0) continue;
      opts.push({ value: `__cat_${cat}`, label: `── ${cat} ──` });
      for (const tpl of items) {
        opts.push({ value: tpl.id, label: tpl.label });
      }
    }
    return opts;
  }, []);

  const onPickTemplate = (id: string) => {
    if (id.startsWith("__cat_")) return;
    if (id === templateId) return;
    const tpl = getYamlTemplate(id);
    if (!pristine) {
      const ok = window.confirm(
        `Replace the current YAML buffer with the ${tpl.label} template? Your edits will be lost.`,
      );
      if (!ok) return;
    }
    onPatch({
      content: tpl.yaml,
      templateId: tpl.id,
      pristine: true,
      results: null,
      validateError: null,
    });
  };

  // Builder mode: append a template as a new YAML doc separated by `---`.
  // Doesn't touch templateId — that still tracks the *base* template the
  // buffer was seeded from. The buffer becomes non-pristine once any doc
  // has been appended, so a subsequent base-template swap will prompt.
  const appendOptions = useMemo(
    () => [
      { value: ADD_RESOURCE_VALUE, label: "+ Add resource" },
      ...templateOptions,
    ],
    [templateOptions],
  );

  const onAppendTemplate = (id: string) => {
    if (id === ADD_RESOURCE_VALUE) return;
    if (id.startsWith("__cat_")) return;
    const tpl = getYamlTemplate(id);
    onPatch({
      content: appendYamlDoc(content, tpl.yaml),
      pristine: false,
      results: null,
      validateError: null,
    });
  };

  // Conflict roll-up (any doc came back with status=conflict). Drives the
  // "Force takeover" button visibility.
  const hasConflict = useMemo(
    () => !!results && results.some((r) => r.status === "conflict"),
    [results],
  );

  const onValidate = () => {
    try {
      // Iterate every doc; jsYaml.loadAll throws on first parse error.
      jsYaml.loadAll(content);
      onPatch({ validateError: null, results: null });
    } catch (e) {
      onPatch({ validateError: String(e), results: null });
    }
  };

  const run = async (dryRun: boolean, force: boolean) => {
    if (!clusterId) {
      onPatch({
        results: [
          {
            status: "error",
            kind: "",
            api_version: "",
            name: "",
            namespace: null,
            message: "no cluster selected — open this YAML tab from a connected context",
          },
        ],
      });
      return;
    }
    onPatch({ busy: true, validateError: null });
    try {
      const out = await api.applyYaml(clusterId, content, dryRun, force);
      onPatch({ results: out, busy: false });
    } catch (e) {
      onPatch({
        results: [
          {
            status: "error",
            kind: "",
            api_version: "",
            name: "",
            namespace: null,
            message: String(e),
          },
        ],
        busy: false,
      });
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          language="yaml"
          theme={mode === "dark" ? "vs-dark" : "light"}
          value={content}
          onChange={(next) =>
            onPatch({
              content: next ?? "",
              pristine: false,
              results: null,
            })
          }
          onMount={installClipboardShortcuts}
          options={{
            minimap: { enabled: false },
            // Monaco wants literal font + numeric size — CSS vars don't
            // apply inside the canvas-rendered editor. Pull the literal
            // mono stack from the active theme so VS Code's Cascadia
            // shows up here too.
            fontSize: 12.5,
            fontFamily: resolved.typography.fontMono,
            wordWrap: "on",
            scrollBeyondLastLine: false,
            renderLineHighlight: "none",
            folding: true,
            tabSize: 2,
          }}
        />
      </div>
      {(results || validateError) && (
        <div
          style={{
            maxHeight: 160,
            overflow: "auto",
            padding: "8px 14px",
            borderTop: `1px solid ${t.borderSoft}`,
            background: t.surfaceAlt,
            fontFamily: FF_MONO,
            fontSize: FS_SM,
          }}
        >
          {validateError && (
            <ErrorBlock
              t={t}
              message={validateError}
              kindLabel="manifest"
              verb="save"
              inline
            />
          )}
          {results?.map((r, i) => (
            <ResultLine key={i} mode={mode} r={r} />
          ))}
        </div>
      )}
      <div
        style={{
          padding: "8px 14px",
          borderTop: `1px solid ${t.borderSoft}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: t.surfaceAlt,
        }}
      >
        <span style={{ color: t.textMuted, fontSize: FS_SM }}>Template</span>
        <div style={{ width: 220 }}>
          <Select
            t={t}
            value={templateId}
            onChange={onPickTemplate}
            options={templateOptions}
          />
        </div>
        <div style={{ width: 180 }}>
          <Select
            t={t}
            value={ADD_RESOURCE_VALUE}
            onChange={onAppendTemplate}
            options={appendOptions}
          />
        </div>
        <div
          style={{
            width: 1,
            height: 18,
            background: t.borderSoft,
            margin: "0 2px",
          }}
        />
        <Btn t={t} variant="ghost" size="sm" onClick={onValidate}>
          Validate
        </Btn>
        <Btn
          t={t}
          variant="ghost"
          size="sm"
          onClick={() => run(true, false)}
          disabled={busy || !clusterId}
        >
          Dry-run
        </Btn>
        <div style={{ flex: 1 }} />
        {hasConflict && (
          <Btn
            t={t}
            variant="secondary"
            size="sm"
            onClick={() => run(false, true)}
            disabled={busy}
          >
            Force takeover
          </Btn>
        )}
        <Btn
          t={t}
          variant="primary"
          size="sm"
          onClick={() => run(false, false)}
          disabled={busy || !clusterId}
        >
          {busy ? "Applying…" : "Apply"}
        </Btn>
      </div>
    </div>
  );
}

function ResultLine({
  
  r,
}: {
  mode: ThemeMode;
  r: DocApplyResult;
}) {
  const t = useResolvedTheme().tokens;
  const tone: CSSProperties =
    r.status === "applied"
      ? { color: t.good }
      : r.status === "conflict"
        ? { color: t.warn }
        : { color: t.bad };
  const head =
    r.kind || r.api_version || r.name
      ? `${r.kind || "?"} ${r.namespace ? `${r.namespace}/` : ""}${r.name || "?"}`
      : "(doc)";
  if (r.status === "applied") {
    return (
      <div style={tone}>
        ✓ {head} applied{r.dry_run ? " (dry-run)" : ""}
        {r.resource_version ? ` · rv ${r.resource_version}` : ""}
      </div>
    );
  }
  if (r.status === "conflict") {
    return (
      <div style={tone}>
        ⚠ {head} conflict
        {r.managers.length ? ` with ${r.managers.join(", ")}` : ""}
        {r.fields.length ? ` on ${r.fields.join(", ")}` : ""}
        {" — "}
        <span style={{ color: t.textDim }}>{r.message}</span>
      </div>
    );
  }
  return (
    <div style={tone}>
      ✗ {head}: {r.message}
    </div>
  );
}

