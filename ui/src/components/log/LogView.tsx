import { logErr } from "../../lib/log";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../../api";
import {
  clusterAccent,
  FF_MONO,
  FS_SM,
  FS_XS,
  hexWithAlpha,
  type Tokens,
} from "../../theme";
import { ErrorBlock, Select } from "../ui";
import { ansiToReact, stripAnsi } from "../../lib/ansi";
import { splitTimestamp } from "../../lib/logFormat";
import { findLogMatches, splitHighlight } from "../../lib/logSearch";
import { latinLetter } from "../../lib/keyboard";
import { toast } from "../../lib/dialog";
import {
  aggregateLogStatus,
  formatLogExport,
  suggestedLogFileName,
  type LogStatus,
  type LogViewSource,
} from "../../lib/logSources";

// Pod-log surface body. All surfaces (`InlineLogTab` — detail-panel Logs
// tab; `LogPanel` — slide-in overlay) render their own chrome around this
// component. Everything below the parent's header — scroll body, gutter,
// pause/auto-scroll/timestamps toggles, status callbacks — lives here so
// all surfaces stay in sync without duplicated streaming logic.
//
// The view streams one backend log stream per entry in `sources` and
// interleaves the lines in arrival order. With more than one source every
// line carries a colored source label (stern-style) and the parent's status
// pill shows the aggregate (see `aggregateLogStatus`).

// Ring-buffer caps the operator can pick in the footer. Default keeps the
// historical 5k; the bigger windows trade memory for history (a 100k-line
// ring at ~200 B/line is ~20 MB — acceptable, not free).
const LINE_CAPS = [5_000, 20_000, 100_000] as const;
const DEFAULT_MAX_LINES: number = LINE_CAPS[0];
// Single-line row height seed for the virtualizer. Wrapped rows get
// re-measured via `measureElement`.
const LOG_ROW_HEIGHT = Math.round(11.5 * 1.65);

// Status union lives in lib/logSources (pure, testable aggregation); kept
// re-exported here so the chrome components keep their import path.
export type { LogStatus, LogViewSource };

export type LogViewState = {
  status: LogStatus;
  paused: boolean;
  // Lines pushed into the ring while paused — surfaced so a parent's
  // status pill can show "paused · N buffered".
  bufferedCount: number;
  lineCount: number;
};

type LineEntry = {
  id: number;
  text: string;
  ts: string | null;
  system: boolean;
  // Index into the active sources array — drives the per-line label/color
  // when more than one source streams into the view.
  src: number;
};

// Ring buffer over a fixed-capacity array. Append is O(1) (overwrites the
// oldest slot when full); `toArray` materialises the visible slice once
// per render. Replaces the prior `[...prev, entry]` + slice pattern that
// allocated a 5000-entry array on every received line.
class LineRing {
  private buf: (LineEntry | undefined)[];
  private start = 0;
  private len = 0;
  constructor(private cap: number) {
    this.buf = new Array(cap);
  }
  push(entry: LineEntry) {
    if (this.len < this.cap) {
      this.buf[(this.start + this.len) % this.cap] = entry;
      this.len += 1;
    } else {
      this.buf[this.start] = entry;
      this.start = (this.start + 1) % this.cap;
    }
  }
  size() {
    return this.len;
  }
  toArray(): LineEntry[] {
    const out: LineEntry[] = new Array(this.len);
    for (let i = 0; i < this.len; i++) {
      out[i] = this.buf[(this.start + i) % this.cap]!;
    }
    return out;
  }
  clear() {
    this.buf = new Array(this.cap);
    this.start = 0;
    this.len = 0;
  }
}

type Props = {
  t: Tokens;
  // The streams to run — one per (cluster, namespace, pod, container)
  // tuple, built by the parent (see `lib/logSources.buildLogSources`).
  // Streams restart whenever the key set changes. Empty while the parent
  // is still resolving (e.g. pod has no containers yet).
  sources: LogViewSource[];
  // Optional state callback. Should be wrapped in `useCallback` by the
  // parent so we don't fire it on every render.
  onStateChange?: (state: LogViewState) => void;
};

export function LogView({ t, sources, onStateChange }: Props) {
  const [lines, setLines] = useState<LineEntry[]>([]);
  const [status, setStatus] = useState<LogStatus>({ kind: "starting" });
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const [showTs, setShowTs] = useState(false);
  const [bufferedCount, setBufferedCount] = useState(0);
  const [lineCap, setLineCap] = useState<number>(DEFAULT_MAX_LINES);
  const [downloading, setDownloading] = useState(false);
  const lineSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<LineRing>(new LineRing(DEFAULT_MAX_LINES));
  const capRef = useRef<number>(DEFAULT_MAX_LINES);
  const pausedRef = useRef(false);
  // Per-source stream statuses, keyed by source key. The aggregate is what
  // lands in `status`.
  const statusesRef = useRef<Map<string, LogStatus>>(new Map());
  // Latest sources, readable from stable callbacks (download) and from the
  // stream effect (which keys off the joined source keys, not the array
  // identity, so label-only changes don't restart streams).
  const sourcesRef = useRef<LogViewSource[]>(sources);
  useLayoutEffect(() => {
    sourcesRef.current = sources;
  });
  // Set whenever we issue a programmatic scroll (tail-follow). The
  // resulting `scroll` event would otherwise be observed by
  // `handleScroll` mid-measurement and could flip `autoScroll` off if
  // the virtualizer's totalSize hadn't yet expanded to include freshly
  // wrapped rows. Released one rAF after the scroll so the event has
  // flushed.
  const programmaticScrollRef = useRef(false);
  const releaseRafRef = useRef<number | null>(null);

  // ── Find-in-place (Cmd/Ctrl+F) ──────────────────────────────────────────
  // The root wrapper is focusable (`tabIndex=-1`) and owns the keydown layer.
  // Because the wrapper sits below React's root in the DOM, calling
  // `stopPropagation()` here prevents the app-global Cmd+F (which opens the
  // table filter) from also firing — find applies to the focused pane.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Index *into `matches`*, not into `lines`.
  const [activeMatch, setActiveMatch] = useState(0);

  // Line indices whose visible (ANSI-stripped) text contains the query.
  const matches = useMemo(() => findLogMatches(lines, query), [lines, query]);
  const activeLineIndex =
    matches.length > 0 ? matches[Math.min(activeMatch, matches.length - 1)]! : -1;

  // The app's `color-scheme` follows the theme, not the console, so the UA
  // default text selection can render invisibly on a light theme with the dark
  // console (or vice versa). Publish a console-derived veil for the
  // `.fs-log-body ::selection` rule. Set via `setProperty` because csstype's
  // inline-style type doesn't admit custom properties.
  useEffect(() => {
    scrollRef.current?.style.setProperty(
      "--fs-console-selection",
      hexWithAlpha(t.text, 0.3),
    );
  }, [t.text]);

  // Focus the surface on mount so Cmd/Ctrl+F lands here (the keydown layer is
  // on this wrapper) without the operator clicking in first. Skipped if an
  // input already has focus, so we never steal from the container Select.
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    const inField =
      !!active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable);
    if (!inField) rootRef.current?.focus({ preventScroll: true });
  }, []);

  // Mirror pause into a ref so the IPC handler (created once per stream)
  // can branch on the latest value.
  useLayoutEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Virtualize log rows. Without this, a noisy pod (100 lines/sec)
  // pours all 5000 ring-buffer lines into the DOM and the unmount cost
  // on tab switch freezes the panel.
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LOG_ROW_HEIGHT,
    overscan: 12,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  // Spacer-based flow. Items render in normal block flow between two
  // height spacers so that a freshly-wrapped row (taller than the seed
  // estimate) pushes the next row down naturally instead of overlapping
  // it for the one paint before ResizeObserver updates the virtualizer.
  const firstStart = virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const lastEnd =
    virtualItems.length > 0
      ? virtualItems[virtualItems.length - 1]!.end
      : 0;
  const tailSpacer = Math.max(0, totalSize - lastEnd);

  // Notify the parent on every state-relevant change.
  useEffect(() => {
    if (!onStateChange) return;
    onStateChange({
      status,
      paused,
      bufferedCount,
      lineCount: lines.length,
    });
  }, [status, paused, bufferedCount, lines.length, onStateChange]);

  // One backend stream per source. Restarts only when the *key set*
  // changes — the NUL join is the same effect-key pattern the multi-cluster
  // table subscriptions use.
  const sourcesEffectKey = sources.map((s) => s.key).join("\u0000");
  useEffect(() => {
    const active = sourcesRef.current;
    if (active.length === 0) return;
    let cancelled = false;
    const handles: { streamId: string; close: () => void }[] = [];
    let rafHandle: number | null = null;
    ringRef.current.clear();
    setLines([]);
    statusesRef.current = new Map(
      active.map((s) => [s.key, { kind: "starting" } as LogStatus]),
    );
    setStatus({ kind: "starting" });
    setBufferedCount(0);
    setPaused(false);
    pausedRef.current = false;
    const multi = active.length > 1;
    const updateStatus = (key: string, st: LogStatus) => {
      statusesRef.current.set(key, st);
      setStatus(aggregateLogStatus([...statusesRef.current.values()]));
    };
    // Coalesce per-line state writes into one render per animation
    // frame. High-volume log streams used to trigger N React renders +
    // N array allocations per second; with the ring buffer + rAF gate
    // it's one fresh array per paint. While paused the rAF still fires
    // but skips `setLines` — the ring keeps filling so resume shows
    // everything in one go.
    const scheduleFlush = () => {
      if (rafHandle != null) return;
      rafHandle = requestAnimationFrame(() => {
        rafHandle = null;
        if (cancelled) return;
        if (pausedRef.current) return;
        setLines(ringRef.current.toArray());
      });
    };
    const pushSystem = (srcIdx: number, text: string) => {
      ringRef.current.push({
        id: ++lineSeq.current,
        text,
        ts: null,
        system: true,
        src: srcIdx,
      });
    };
    active.forEach((src, srcIdx) => {
      // System-line prefix so per-source lifecycle markers stay
      // attributable in an aggregated view; redundant for a lone source.
      const sysLabel = multi && src.label ? `[${src.label}] ` : "";
      (async () => {
        try {
          const handle = await api.startLogStream(
            src.clusterId,
            src.namespace,
            src.pod,
            src.container,
            (evt) => {
              if (cancelled) return;
              // `waiting` carries no line — the container just isn't up
              // yet. Reflect it in the status only; the backend keeps the
              // stream live and switches to `line`/`batch` once it starts.
              if (evt.kind === "waiting") {
                updateStatus(src.key, { kind: "waiting", reason: evt.reason });
                return;
              }
              // First real output after a `waiting` (or the initial
              // optimistic `streaming`): pin this source to streaming.
              const markStreaming = () => {
                const cur = statusesRef.current.get(src.key);
                if (!cur || cur.kind === "waiting" || cur.kind === "starting") {
                  updateStatus(src.key, { kind: "streaming" });
                }
              };
              if (evt.kind === "batch") {
                for (const raw of evt.lines) {
                  const { ts, text } = splitTimestamp(raw);
                  ringRef.current.push({
                    id: ++lineSeq.current,
                    text,
                    ts,
                    system: false,
                    src: srcIdx,
                  });
                }
                if (pausedRef.current) {
                  setBufferedCount((c) =>
                    Math.min(capRef.current, c + evt.lines.length),
                  );
                }
                markStreaming();
                scheduleFlush();
                return;
              }
              if (evt.kind === "line") {
                const { ts, text } = splitTimestamp(evt.text);
                ringRef.current.push({
                  id: ++lineSeq.current,
                  text,
                  ts,
                  system: false,
                  src: srcIdx,
                });
                markStreaming();
                if (pausedRef.current) {
                  setBufferedCount((c) => Math.min(capRef.current, c + 1));
                }
              } else if (evt.kind === "lagged") {
                pushSystem(
                  srcIdx,
                  `… ${sysLabel}${evt.dropped} lines dropped (frontend lagged)`,
                );
              } else {
                pushSystem(srcIdx, `— ${sysLabel}stream ended: ${evt.reason}`);
              }
              scheduleFlush();
              if (evt.kind === "ended") {
                updateStatus(src.key, { kind: "ended", reason: evt.reason });
              }
            },
          );
          if (cancelled) {
            handle.close();
            api.stopLogStream(handle.streamId).catch(logErr("logs"));
            return;
          }
          handles.push(handle);
          const cur = statusesRef.current.get(src.key);
          if (cur && cur.kind === "starting") {
            updateStatus(src.key, { kind: "streaming" });
          }
        } catch (e) {
          if (cancelled) return;
          updateStatus(src.key, { kind: "error", message: String(e) });
          // In an aggregated view a single failed stream must be visible in
          // the body, not just averaged into the status pill.
          if (multi) {
            pushSystem(srcIdx, `— ${sysLabel}stream failed: ${String(e)}`);
            scheduleFlush();
          }
        }
      })();
    });
    return () => {
      cancelled = true;
      if (rafHandle != null) cancelAnimationFrame(rafHandle);
      for (const h of handles) {
        h.close();
        api.stopLogStream(h.streamId).catch(logErr("logs"));
      }
    };
  }, [sourcesEffectKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    if (!autoScroll) return;
    programmaticScrollRef.current = true;
    if (lines.length > 0) {
      virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
    }
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      const releaseRaf = requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
      releaseRafRef.current = releaseRaf;
    });
    return () => {
      cancelAnimationFrame(raf);
      if (releaseRafRef.current != null) {
        cancelAnimationFrame(releaseRafRef.current);
        releaseRafRef.current = null;
      }
      programmaticScrollRef.current = false;
    };
  }, [lines, autoScroll, virtualizer]);

  function handleScroll() {
    if (programmaticScrollRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    setAutoScroll(atBottom);
  }

  const togglePause = useCallback(() => {
    setPaused((p) => {
      if (p) {
        setLines(ringRef.current.toArray());
        setBufferedCount(0);
      }
      return !p;
    });
  }, []);

  // Swap the ring for one of the new capacity, preserving the newest lines.
  // Shrinking drops the oldest overflow — same semantics as normal rollover.
  const changeLineCap = useCallback((next: number) => {
    if (next === capRef.current) return;
    const old = ringRef.current.toArray();
    const ring = new LineRing(next);
    for (const e of old.slice(-next)) ring.push(e);
    ringRef.current = ring;
    capRef.current = next;
    setLineCap(next);
    setLines(ring.toArray());
  }, []);

  // Export the buffered lines (all of them, paused or not) to a user-chosen
  // file. The path always comes from the OS save dialog.
  const onDownload = useCallback(async () => {
    const entries = ringRef.current.toArray();
    if (entries.length === 0) return;
    setDownloading(true);
    try {
      const path = await saveDialog({
        defaultPath: suggestedLogFileName(sourcesRef.current, new Date()),
      });
      if (!path) return;
      await api.saveTextFile(path, formatLogExport(entries, sourcesRef.current));
      toast.ok(`Saved ${entries.length.toLocaleString()} log lines`);
    } catch (e) {
      toast.bad(`Saving logs failed: ${String(e)}`);
    } finally {
      setDownloading(false);
    }
  }, []);

  const openFind = useCallback(() => {
    setFindOpen(true);
    // Tail-follow would yank the viewport off a match the moment a new line
    // arrives. Park it while searching; the operator can re-enable it.
    setAutoScroll(false);
    // Focus + select after the input mounts so reopening over an existing
    // query lets the operator type a replacement immediately.
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setQuery("");
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const gotoMatch = useCallback(
    (dir: 1 | -1) => {
      setActiveMatch((m) => {
        if (matches.length === 0) return 0;
        return (m + dir + matches.length) % matches.length;
      });
    },
    [matches.length],
  );

  // Keep the active pointer in range as the match set shrinks/grows while typing.
  useEffect(() => {
    setActiveMatch((m) =>
      matches.length === 0 ? 0 : Math.min(m, matches.length - 1),
    );
  }, [matches.length]);

  // Scroll the active match into view (also fires as matches change while
  // typing, jumping to the first hit). Marked programmatic so `handleScroll`
  // doesn't misread it as the user scrolling away from the tail.
  useEffect(() => {
    if (!findOpen || activeLineIndex < 0) return;
    programmaticScrollRef.current = true;
    virtualizer.scrollToIndex(activeLineIndex, { align: "center" });
    const raf = requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
    return () => cancelAnimationFrame(raf);
  }, [findOpen, activeLineIndex, virtualizer]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const meta = e.metaKey || e.ctrlKey;
      const letter = latinLetter(e);
      if (meta && letter === "f") {
        e.preventDefault();
        // Stop the app-global Cmd+F (table filter) from also firing.
        e.stopPropagation();
        openFind();
        return;
      }
      if (!findOpen) return;
      if (e.key === "Escape") {
        e.preventDefault();
        // Stop the app-global Esc from closing the whole log panel — first
        // Esc dismisses the find bar only.
        e.stopPropagation();
        closeFind();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        gotoMatch(e.shiftKey ? -1 : 1);
        return;
      }
      // Cmd/Ctrl+G — next / prev match (macOS find convention).
      if (meta && letter === "g") {
        e.preventDefault();
        e.stopPropagation();
        gotoMatch(e.shiftKey ? -1 : 1);
      }
    },
    [findOpen, openFind, closeFind, gotoMatch],
  );

  // Highlight tints, derived once per render from the console palette so the
  // memoised rows compare equal across unrelated re-renders.
  const matchBg = hexWithAlpha(t.warn, 0.38);
  const activeMatchBg = hexWithAlpha(t.accent, 0.55);
  const activeRowBg = hexWithAlpha(t.accent, 0.12);
  const multiSource = sources.length > 1;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        outline: "none",
      }}
    >
      {findOpen && (
        <LogFindBar
          t={t}
          inputRef={findInputRef}
          query={query}
          onQueryChange={(v) => {
            setQuery(v);
            setActiveMatch(0);
          }}
          matchCount={matches.length}
          activeMatch={activeMatch}
          onPrev={() => gotoMatch(-1)}
          onNext={() => gotoMatch(1)}
          onClose={closeFind}
        />
      )}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="fs-selectable fs-log-body"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          background: t.surfaceAlt,
          color: t.text,
          fontFamily: FF_MONO,
          fontSize: FS_SM,
          lineHeight: 1.65,
          padding: "14px 0",
        }}
      >
        {lines.length === 0 && status.kind === "starting" && (
          <div style={{ color: t.textMuted, padding: "0 14px" }}>
            Connecting to log stream…
          </div>
        )}
        {lines.length === 0 && status.kind === "streaming" && (
          <div style={{ color: t.textMuted, padding: "0 14px" }}>
            Waiting for output…
          </div>
        )}
        {lines.length === 0 && status.kind === "waiting" && (
          <div style={{ padding: "0 14px", color: t.textMuted }}>
            <div style={{ color: t.warn }}>
              Waiting for container to start…
            </div>
            <div style={{ marginTop: 4, wordBreak: "break-all" }}>
              {status.reason}
            </div>
          </div>
        )}
        {status.kind === "error" && (
          <div style={{ padding: "0 14px" }}>
            <ErrorBlock
              t={t}
              message={status.message}
              kindLabel="pod"
              verb="stream"
              inline
            />
          </div>
        )}
        {lines.length > 0 && (
          <>
            {firstStart > 0 && <div style={{ height: firstStart }} />}
            {virtualItems.map((vi) => {
              const l = lines[vi.index];
              if (!l) return null;
              const src = multiSource ? sources[l.src] : undefined;
              return (
                <div
                  key={l.id}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                >
                  <LogLine
                    entry={l}
                    text={t.text}
                    systemColor={t.warn}
                    gutter={t.textMuted}
                    gutterDim={t.textDim}
                    divider={t.borderSoft}
                    showTs={showTs}
                    srcLabel={src && !l.system ? src.label : null}
                    srcColor={src ? clusterAccent(src.colorIdx) : ""}
                    query={findOpen ? query : ""}
                    active={findOpen && vi.index === activeLineIndex}
                    matchBg={matchBg}
                    activeMatchBg={activeMatchBg}
                    activeRowBg={activeRowBg}
                  />
                </div>
              );
            })}
            {tailSpacer > 0 && <div style={{ height: tailSpacer }} />}
          </>
        )}
      </div>
      <div
        style={{
          padding: "6px 14px",
          borderTop: `1px solid ${t.borderSoft}`,
          fontSize: FS_SM,
          color: t.textMuted,
          fontFamily: FF_MONO,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexShrink: 0,
        }}
      >
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          {lines.length} lines
        </span>
        <button
          type="button"
          onClick={togglePause}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 10px",
            border: `1px solid ${t.border}`,
            borderRadius: 4,
            background: paused ? t.warn : t.surface,
            color: paused ? t.bg : t.text,
            fontFamily: FF_MONO,
            fontSize: FS_SM,
            cursor: "pointer",
          }}
          title={paused ? "Resume streaming" : "Pause streaming"}
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            style={{ accentColor: t.accent }}
          />
          auto-scroll
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={showTs}
            onChange={(e) => setShowTs(e.target.checked)}
            style={{ accentColor: t.accent }}
          />
          timestamps
        </label>
        <button
          type="button"
          onClick={() => (findOpen ? closeFind() : openFind())}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 10px",
            border: `1px solid ${t.border}`,
            borderRadius: 4,
            background: findOpen ? t.accentSoft : t.surface,
            color: findOpen ? t.accent : t.text,
            fontFamily: FF_MONO,
            fontSize: FS_SM,
            cursor: "pointer",
          }}
          title="Find in logs (Ctrl/⌘+F)"
        >
          Find
        </button>
        <button
          type="button"
          onClick={() => void onDownload()}
          disabled={lines.length === 0 || downloading}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 10px",
            border: `1px solid ${t.border}`,
            borderRadius: 4,
            background: t.surface,
            color: lines.length === 0 || downloading ? t.textMuted : t.text,
            fontFamily: FF_MONO,
            fontSize: FS_SM,
            cursor: lines.length === 0 || downloading ? "default" : "pointer",
          }}
          title="Save the buffered lines to one file"
        >
          {downloading ? "Saving…" : "Download"}
        </button>
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          keep
          <Select
            t={t}
            fullWidth={false}
            value={String(lineCap)}
            onChange={(v) => changeLineCap(Number(v))}
            options={LINE_CAPS.map((c) => ({
              value: String(c),
              label: `${(c / 1000).toLocaleString()}k lines`,
            }))}
            style={{
              fontFamily: FF_MONO,
              fontSize: FS_SM,
              height: 22,
              padding: "1px 24px 1px 8px",
            }}
          />
        </span>
      </div>
    </div>
  );
}

// IDE-style log row. Gutter sits flush against the left edge of the
// scroll surface, left-aligned line number anchored to the edge, thin
// vertical divider, then the body. Line number + timestamp render as
// `::before` content from `data-` attributes (see `index.css`) so
// they're decorative pseudo-element content — never part of a text
// selection, never copied.
//
// Memo per-line: stable LineEntry refs from the ring let unchanged rows
// skip render when a new tail arrives.
const LogLine = memo(function LogLine({
  entry,
  text,
  systemColor,
  gutter,
  gutterDim,
  divider,
  showTs,
  srcLabel,
  srcColor,
  query,
  active,
  matchBg,
  activeMatchBg,
  activeRowBg,
}: {
  entry: LineEntry;
  text: string;
  systemColor: string;
  gutter: string;
  gutterDim: string;
  divider: string;
  showTs: boolean;
  // Source label rendered inline before the body (stern-style) when the
  // view aggregates several streams; null hides the prefix entirely.
  srcLabel: string | null;
  srcColor: string;
  // Active find query ("" when the find bar is closed). Highlighting only
  // kicks in for a non-empty query.
  query: string;
  // This row is the current find result (scrolled to, brighter highlight).
  active: boolean;
  matchBg: string;
  activeMatchBg: string;
  activeRowBg: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        contain: "content",
        background: active ? activeRowBg : undefined,
      }}
    >
      <span
        className="fs-log-gutter fs-log-gutter--no"
        data-line-no={entry.id}
        style={{
          flexShrink: 0,
          // Left-aligned, anchored to the panel edge. `min-width` keeps
          // 1–4-digit ids visually steady; once the stream rolls past
          // 9999 the column just widens.
          minWidth: "5ch",
          paddingLeft: 8,
          paddingRight: 10,
          textAlign: "left",
          color: gutter,
          fontFamily: FF_MONO,
          fontSize: FS_XS,
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1.65,
          // Stretch so the divider runs the full height of wrapped rows.
          alignSelf: "stretch",
          borderRight: `1px solid ${divider}`,
        }}
      />
      {showTs && (
        <span
          className="fs-log-gutter fs-log-gutter--ts"
          data-ts={entry.ts ?? "—"}
          style={{
            flexShrink: 0,
            width: 96,
            paddingLeft: 10,
            paddingRight: 10,
            color: gutterDim,
            fontFamily: FF_MONO,
            fontSize: FS_XS,
            fontVariantNumeric: "tabular-nums",
            lineHeight: 1.65,
            alignSelf: "flex-start",
          }}
        />
      )}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          paddingLeft: showTs ? 0 : 12,
          paddingRight: 14,
          color: entry.system ? systemColor : text,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {srcLabel != null && srcLabel.length > 0 && (
          <span
            className="fs-log-src"
            style={{ color: srcColor, fontWeight: 600 }}
          >
            {srcLabel}{" "}
          </span>
        )}
        {renderLineBody(entry, query, active, matchBg, activeMatchBg)}
      </div>
    </div>
  );
});

// Render a line's body. With no active query we keep the fast path: system
// lines render plain, everything else through `ansiToReact`. While searching,
// only the lines that actually contain the query are re-rendered with
// <mark>-style highlights over their ANSI-stripped text — non-matching lines
// keep their colours untouched, so the matches stand out.
function renderLineBody(
  entry: LineEntry,
  query: string,
  active: boolean,
  matchBg: string,
  activeMatchBg: string,
) {
  if (query.length === 0) {
    return entry.system ? entry.text : ansiToReact(entry.text);
  }
  const visible = entry.system ? entry.text : stripAnsi(entry.text);
  const segments = splitHighlight(visible, query);
  // No hit on this line → leave the original rendering (and ANSI colours) be.
  if (segments.length === 1 && !segments[0]!.match) {
    return entry.system ? entry.text : ansiToReact(entry.text);
  }
  return segments.map((seg, i) =>
    seg.match ? (
      <mark
        key={i}
        style={{
          background: active ? activeMatchBg : matchBg,
          color: "inherit",
          borderRadius: 2,
        }}
      >
        {seg.text}
      </mark>
    ) : (
      <span key={i}>{seg.text}</span>
    ),
  );
}

// Floating find bar pinned to the top-right of the log surface. Styled with
// the console palette so it sits on the dark body. Keyboard (Enter / Esc /
// Cmd+G) is handled by the parent's root `onKeyDown`; the buttons are the
// pointer affordances for the same actions.
function LogFindBar({
  t,
  inputRef,
  query,
  onQueryChange,
  matchCount,
  activeMatch,
  onPrev,
  onNext,
  onClose,
}: {
  t: Tokens;
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (v: string) => void;
  matchCount: number;
  activeMatch: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const counter =
    query.length === 0
      ? ""
      : matchCount === 0
        ? "0/0"
        : `${Math.min(activeMatch, matchCount - 1) + 1}/${matchCount}`;
  const navBtn = (
    label: string,
    onClick: () => void,
    title: string,
  ) => (
    <button
      type="button"
      onClick={onClick}
      disabled={matchCount === 0}
      title={title}
      style={{
        border: "none",
        background: "transparent",
        color: matchCount === 0 ? t.textMuted : t.textDim,
        cursor: matchCount === 0 ? "default" : "pointer",
        fontFamily: FF_MONO,
        fontSize: FS_SM,
        padding: "2px 4px",
        lineHeight: 1,
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 16,
        zIndex: 5,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 6px",
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
      }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Find"
        spellCheck={false}
        style={{
          width: 180,
          border: "none",
          outline: "none",
          background: "transparent",
          color: t.text,
          fontFamily: FF_MONO,
          fontSize: FS_SM,
        }}
      />
      <span
        style={{
          minWidth: 36,
          textAlign: "right",
          color: query.length > 0 && matchCount === 0 ? t.bad : t.textMuted,
          fontFamily: FF_MONO,
          fontSize: FS_XS,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {counter}
      </span>
      {navBtn("↑", onPrev, "Previous match (Shift+Enter)")}
      {navBtn("↓", onNext, "Next match (Enter)")}
      <button
        type="button"
        onClick={onClose}
        title="Close (Esc)"
        style={{
          border: "none",
          background: "transparent",
          color: t.textDim,
          cursor: "pointer",
          fontFamily: FF_MONO,
          fontSize: FS_SM,
          padding: "2px 4px",
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  );
}
