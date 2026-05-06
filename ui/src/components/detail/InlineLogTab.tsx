import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../api";
import { tokens, FONT_MONO, type ThemeMode } from "../../theme";
import { Select } from "../ui";
import { ansiToReact } from "../../lib/ansi";

// Inline Pod-logs surface for the detail-panel "Logs" tab. The full-overlay
// version lives in `LogPanel.tsx`; this is the chrome-less variant that
// embeds inside the tab body. Streaming logic intentionally mirrors
// LogPanel — keep them in sync if you change either.

const MAX_LINES = 5000;

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
  mode,
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
  const t = tokens(mode);
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
            style={{
              fontFamily: FONT_MONO,
              fontSize: 11,
              height: 26,
              padding: "3px 28px 3px 8px",
            }}
          />
        ) : (
          <span
            style={{
              fontSize: 11,
              color: t.textMuted,
              fontFamily: FONT_MONO,
            }}
          >
            container: {container ?? "—"}
          </span>
        )}
        <span
          style={{
            fontSize: 11,
            color:
              status.kind === "error"
                ? t.bad
                : status.kind === "streaming"
                  ? t.good
                  : t.textMuted,
            fontFamily: FONT_MONO,
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
          background: mode === "dark" ? "#0a0c10" : "#1a1d23",
          color: "#cbd5e1",
          fontFamily: FONT_MONO,
          fontSize: 11.5,
          lineHeight: 1.65,
          padding: 14,
        }}
      >
        {lines.length === 0 && status.kind === "starting" && (
          <div style={{ color: "#64748b" }}>Connecting to log stream…</div>
        )}
        {lines.length === 0 && status.kind === "streaming" && (
          <div style={{ color: "#64748b" }}>Waiting for output…</div>
        )}
        {status.kind === "error" && (
          <div style={{ color: t.bad }}>{status.message}</div>
        )}
        {lines.map((l) => (
          <LogLine key={l.id} entry={l} />
        ))}
      </div>
      <div
        style={{
          padding: "6px 14px",
          borderTop: `1px solid ${t.borderSoft}`,
          fontSize: 11,
          color: t.textMuted,
          fontFamily: FONT_MONO,
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
const LogLine = memo(function LogLine({ entry }: { entry: LineEntry }) {
  return (
    <div
      style={{
        color: entry.system ? "#fbbf24" : "#cbd5e1",
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        contain: "content",
      }}
    >
      {entry.system ? entry.text : ansiToReact(entry.text)}
    </div>
  );
});
