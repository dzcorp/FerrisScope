import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../../api";
import { useResolvedTheme } from "../../store";
import { FF_MONO, type ThemeMode, FS_SM } from "../../theme";
import { ErrorBlock, Select } from "../ui";
import { ansiToReact } from "../../lib/ansi";

// Inline Pod-logs surface for the detail-panel "Logs" tab. The full-overlay
// version lives in `LogPanel.tsx`; this is the chrome-less variant that
// embeds inside the tab body. Streaming logic intentionally mirrors
// LogPanel — keep them in sync if you change either.

const MAX_LINES = 5000;

// Popover chrome around the label text: 4px outer padding + 10px inner
// padding (×2) + 10px checkmark column + 8px gap + ~14px scrollbar/safety.
const POPOVER_CHROME = 56;

// Lazy canvas for `measureText`. Faster and reflow-free vs. DOM measurement.
let _measureCtx: CanvasRenderingContext2D | null = null;
function measureLabel(text: string, font: string): number {
  if (!_measureCtx && typeof document !== "undefined") {
    _measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (!_measureCtx) return text.length * 7;
  if (_measureCtx.font !== font) _measureCtx.font = font;
  return _measureCtx.measureText(text).width;
}

// Ring buffer over a fixed-capacity array. Append is O(1) (overwrites the
// oldest slot when full); `toArray` materialises the visible slice once per
// render. Replaces the prior `[...prev, entry]` + slice pattern that
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

type LineEntry = { id: number; text: string; system: boolean };

type Status =
  | { kind: "starting" }
  | { kind: "streaming" }
  | { kind: "ended"; reason: string }
  | { kind: "error"; message: string };

export function InlineLogTab({
  clusterId,
  namespace,
  name,
  containers,
  defaultContainer,
}: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string;
  name: string;
  containers: string[];
  defaultContainer?: string | null;
}) {
  const t = useResolvedTheme().tokens;
  const initialContainer =
    (defaultContainer && containers.includes(defaultContainer)
      ? defaultContainer
      : containers[0]) ?? null;
  const [container, setContainer] = useState<string | null>(initialContainer);
  const [lines, setLines] = useState<LineEntry[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "starting" });
  const [autoScroll, setAutoScroll] = useState(true);
  const lineSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<LineRing>(new LineRing(MAX_LINES));

  // Size the popover to the longest container name. Without this the
  // popover inherits the trigger's width (which mirrors the *current*
  // selection), so picking a short name like `csi-resizer` clips longer
  // siblings to "cinder-c…" until the operator picks one to read its
  // full label. Popover labels render at `fontFamily: inherit` /
  // `fontSize: FS_MD` (the trigger's mono override doesn't propagate
  // through the portal); chrome accounts for checkmark, gap, padding,
  // and a scrollbar allowance.
  const popoverMinWidth = useMemo(() => {
    if (containers.length <= 1) return undefined;
    const font = "12.5px system-ui, -apple-system, Segoe UI, sans-serif";
    let widest = 0;
    for (const c of containers) {
      const w = measureLabel(c, font);
      if (w > widest) widest = w;
    }
    return Math.min(480, Math.ceil(widest) + POPOVER_CHROME);
  }, [containers]);

  useEffect(() => {
    if (!container) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let activeStreamId: string | null = null;
    let rafHandle: number | null = null;
    ringRef.current.clear();
    setLines([]);
    setStatus({ kind: "starting" });
    // Coalesce per-line state writes into one render per animation frame.
    // High-volume log streams used to trigger N React renders + N array
    // allocations per second; with the ring buffer + rAF gate it's one
    // fresh array per paint.
    const scheduleFlush = () => {
      if (rafHandle != null) return;
      rafHandle = requestAnimationFrame(() => {
        rafHandle = null;
        if (cancelled) return;
        setLines(ringRef.current.toArray());
      });
    };
    (async () => {
      try {
        const handle = await api.startLogStream(
          clusterId,
          namespace,
          name,
          container,
          (evt) => {
            if (cancelled) return;
            const id = ++lineSeq.current;
            let entry: LineEntry;
            if (evt.kind === "line") {
              entry = { id, text: evt.text, system: false };
            } else if (evt.kind === "lagged") {
              entry = {
                id,
                text: `… ${evt.dropped} lines dropped (frontend lagged)`,
                system: true,
              };
            } else {
              entry = {
                id,
                text: `— stream ended: ${evt.reason}`,
                system: true,
              };
            }
            ringRef.current.push(entry);
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
  }, [clusterId, namespace, name, container]);

  useLayoutEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    setAutoScroll(atBottom);
  }

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "6px 14px",
          borderBottom: `1px solid ${t.borderSoft}`,
          background: t.headerAlt,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        {containers.length > 1 ? (
          <Select
            t={t}
            fullWidth={false}
            value={container ?? ""}
            onChange={(v) => setContainer(v)}
            options={containers.map((c) => ({ value: c, label: c }))}
            popoverMinWidth={popoverMinWidth}
            style={{
              fontFamily: FF_MONO,
              fontSize: FS_SM,
              height: 26,
              padding: "3px 28px 3px 8px",
            }}
          />
        ) : (
          <span
            style={{
              fontSize: FS_SM,
              color: t.textMuted,
              fontFamily: FF_MONO,
            }}
          >
            container: {container ?? "—"}
          </span>
        )}
        <span
          style={{
            fontSize: FS_SM,
            color:
              status.kind === "error"
                ? t.bad
                : status.kind === "streaming"
                  ? t.good
                  : t.textMuted,
            fontFamily: FF_MONO,
          }}
        >
          {status.kind === "starting"
            ? "connecting…"
            : status.kind === "streaming"
              ? "streaming"
              : status.kind === "ended"
                ? `ended · ${status.reason}`
                : `error · ${status.message}`}
        </span>
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="fs-selectable"
        style={{
          flex: 1,
          overflow: "auto",
          // Log surface follows the active palette.
          background: t.surfaceAlt,
          color: t.text,
          fontFamily: FF_MONO,
          fontSize: FS_SM,
          lineHeight: 1.65,
          padding: 14,
        }}
      >
        {lines.length === 0 && status.kind === "starting" && (
          <div style={{ color: t.textMuted }}>Connecting to log stream…</div>
        )}
        {lines.length === 0 && status.kind === "streaming" && (
          <div style={{ color: t.textMuted }}>Waiting for output…</div>
        )}
        {status.kind === "error" && (
          <ErrorBlock
            t={t}
            message={status.message}
            kindLabel="pod"
            verb="stream"
            inline
          />
        )}
        {lines.map((l) => (
          <LogLine
            key={l.id}
            entry={l}
            text={t.text}
            systemColor={t.warn}
          />
        ))}
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
        <span style={{ marginLeft: "auto" }}>
          drops oldest beyond {MAX_LINES.toLocaleString()}
        </span>
      </div>
    </div>
  );
}

// Memo per-line: stable LineEntry refs from the ring buffer let unchanged
// rows skip render when a new tail line arrives. `contain: content`
// isolates per-row layout/paint to keep long logs scrolling smoothly.
// `text` / `systemColor` are stable across renders (memo'd resolved theme),
// so they don't bust LogLine's prop equality.
const LogLine = memo(function LogLine({
  entry,
  text,
  systemColor,
}: {
  entry: LineEntry;
  text: string;
  systemColor: string;
}) {
  return (
    <div
      style={{
        color: entry.system ? systemColor : text,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        contain: "content",
      }}
    >
      {entry.system ? entry.text : ansiToReact(entry.text)}
    </div>
  );
});
