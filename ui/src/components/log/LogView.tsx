import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "../../api";
import { FF_MONO, FS_SM, FS_XS, type Tokens } from "../../theme";
import { ErrorBlock } from "../ui";
import { ansiToReact } from "../../lib/ansi";
import { splitTimestamp } from "../../lib/logFormat";

// Pod-log surface body. Both surfaces (`InlineLogTab` — detail-panel Logs
// tab; `LogPanel` — slide-in overlay) render their own chrome around this
// component. Everything below the parent's header — scroll body, gutter,
// pause/auto-scroll/timestamps toggles, status callbacks — lives here so
// both surfaces stay in sync without duplicated streaming logic.

const MAX_LINES = 5000;
// Single-line row height seed for the virtualizer. Wrapped rows get
// re-measured via `measureElement`.
const LOG_ROW_HEIGHT = Math.round(11.5 * 1.65);

export type LogStatus =
  | { kind: "starting" }
  | { kind: "streaming" }
  | { kind: "ended"; reason: string }
  | { kind: "error"; message: string };

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
  clusterId: string;
  namespace: string;
  pod: string;
  // Active container — selected by the parent's chrome (Select). The
  // stream restarts on every change. Null when there are no containers
  // (e.g. pod still pending).
  container: string | null;
  // Optional state callback. Should be wrapped in `useCallback` by the
  // parent so we don't fire it on every render.
  onStateChange?: (state: LogViewState) => void;
};

export function LogView({
  t,
  clusterId,
  namespace,
  pod,
  container,
  onStateChange,
}: Props) {
  const [lines, setLines] = useState<LineEntry[]>([]);
  const [status, setStatus] = useState<LogStatus>({ kind: "starting" });
  const [autoScroll, setAutoScroll] = useState(true);
  const [paused, setPaused] = useState(false);
  const [showTs, setShowTs] = useState(false);
  const [bufferedCount, setBufferedCount] = useState(0);
  const lineSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<LineRing>(new LineRing(MAX_LINES));
  const pausedRef = useRef(false);
  // Set whenever we issue a programmatic scroll (tail-follow). The
  // resulting `scroll` event would otherwise be observed by
  // `handleScroll` mid-measurement and could flip `autoScroll` off if
  // the virtualizer's totalSize hadn't yet expanded to include freshly
  // wrapped rows. Released one rAF after the scroll so the event has
  // flushed.
  const programmaticScrollRef = useRef(false);
  const releaseRafRef = useRef<number | null>(null);

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

  useEffect(() => {
    if (!container) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let activeStreamId: string | null = null;
    let rafHandle: number | null = null;
    ringRef.current.clear();
    setLines([]);
    setStatus({ kind: "starting" });
    setBufferedCount(0);
    setPaused(false);
    pausedRef.current = false;
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
    (async () => {
      try {
        const handle = await api.startLogStream(
          clusterId,
          namespace,
          pod,
          container,
          (evt) => {
            if (cancelled) return;
            if (evt.kind === "batch") {
              for (const raw of evt.lines) {
                const { ts, text } = splitTimestamp(raw);
                ringRef.current.push({
                  id: ++lineSeq.current,
                  text,
                  ts,
                  system: false,
                });
              }
              if (pausedRef.current) {
                setBufferedCount((c) =>
                  Math.min(MAX_LINES, c + evt.lines.length),
                );
              }
              scheduleFlush();
              return;
            }
            const id = ++lineSeq.current;
            let entry: LineEntry;
            if (evt.kind === "line") {
              const { ts, text } = splitTimestamp(evt.text);
              entry = { id, text, ts, system: false };
            } else if (evt.kind === "lagged") {
              entry = {
                id,
                text: `… ${evt.dropped} lines dropped (frontend lagged)`,
                ts: null,
                system: true,
              };
            } else {
              entry = {
                id,
                text: `— stream ended: ${evt.reason}`,
                ts: null,
                system: true,
              };
            }
            ringRef.current.push(entry);
            if (pausedRef.current && evt.kind === "line") {
              setBufferedCount((c) => Math.min(MAX_LINES, c + 1));
            }
            scheduleFlush();
            if (evt.kind === "ended") {
              setStatus({ kind: "ended", reason: evt.reason });
            }
          },
        );
        if (cancelled) {
          handle.close();
          api.stopLogStream(handle.streamId).catch(() => {});
          return;
        }
        activeStreamId = handle.streamId;
        unlisten = handle.close;
        setStatus({ kind: "streaming" });
      } catch (e) {
        if (!cancelled) setStatus({ kind: "error", message: String(e) });
      }
    })();
    return () => {
      cancelled = true;
      if (rafHandle != null) cancelAnimationFrame(rafHandle);
      if (unlisten) unlisten();
      if (activeStreamId) {
        api.stopLogStream(activeStreamId).catch(() => {});
      }
    };
  }, [clusterId, namespace, pod, container]);

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

  return (
    <>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="fs-selectable"
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
        <span style={{ marginLeft: "auto" }}>
          drops oldest beyond {MAX_LINES.toLocaleString()}
        </span>
      </div>
    </>
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
}: {
  entry: LineEntry;
  text: string;
  systemColor: string;
  gutter: string;
  gutterDim: string;
  divider: string;
  showTs: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        contain: "content",
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
        {entry.system ? entry.text : ansiToReact(entry.text)}
      </div>
    </div>
  );
});
