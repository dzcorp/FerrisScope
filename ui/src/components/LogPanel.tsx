import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { api } from "../api";
import { tokens, FONT_MONO, type ThemeMode } from "../theme";
import {
  ErrorBlock,
  Eyebrow,
  IconBtn,
  Icons,
  Select,
  StatusPill,
  Tooltip,
} from "./ui";
import { ansiToReact } from "../lib/ansi";

export type LogTarget = {
  uid: string;
  namespace: string;
  name: string;
  containers: string[];
};

type Status =
  | { kind: "starting" }
  | { kind: "streaming" }
  | { kind: "ended"; reason: string }
  | { kind: "error"; message: string };

type LineEntry = { id: number; text: string; system: boolean };

const MAX_LINES = 5000;

// Single-line row height seed for the virtualizer. Matches the inline
// rendering style (`fontSize: 11.5`, `lineHeight: 1.65`); rows that
// actually wrap (`whiteSpace: pre-wrap`, `wordBreak: break-all`) are
// re-measured via `measureElement`.
const LOG_ROW_HEIGHT = Math.round(11.5 * 1.65);

// Same ring-buffer pattern as InlineLogTab. Replaces `[...prev, entry]`
// + slice on every line, which allocates a fresh 5000-entry array per
// log line on chatty streams. See InlineLogTab.tsx for rationale.
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
  mode: ThemeMode;
  clusterId: string;
  pod: LogTarget;
  // Optional starting container. Falls back to `pod.containers[0]` so the
  // existing call sites that don't preselect keep working.
  defaultContainer?: string | null;
  onClose: () => void;
};

// Logs panel — slides in from the right (R-09 prefers panels over modals).
// Terminal background stays constant per theme; level/timestamp coloring
// matches design/helmsman-v2.jsx LogLine.
export function LogPanel({
  mode,
  clusterId,
  pod,
  defaultContainer,
  onClose,
}: Props) {
  const t = tokens(mode);
  const initialContainer =
    (defaultContainer && pod.containers.includes(defaultContainer)
      ? defaultContainer
      : pod.containers[0]) ?? null;
  const [container, setContainer] = useState<string | null>(initialContainer);
  const [lines, setLines] = useState<LineEntry[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "starting" });
  const [autoScroll, setAutoScroll] = useState(true);

  const lineSeq = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const ringRef = useRef<LineRing>(new LineRing(MAX_LINES));

  // Virtualize the log rows. Without this, a noisy pod (100 lines/sec)
  // pours all 5000 ring-buffer lines into the DOM and scrolling stalls.
  // `measureElement` keeps wrapped lines (long stack traces, JSON dumps)
  // positioned correctly even though most rows hit the single-line seed.
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LOG_ROW_HEIGHT,
    overscan: 12,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let activeStreamId: string | null = null;
    let rafHandle: number | null = null;

    ringRef.current.clear();
    setLines([]);
    setStatus({ kind: "starting" });

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
          pod.namespace,
          pod.name,
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
  }, [clusterId, pod.namespace, pod.name, container]);

  useLayoutEffect(() => {
    if (!autoScroll) return;
    if (lines.length > 0) {
      virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
    }
    // Catch any layout shift after the virtualizer settles (e.g. when the
    // status placeholder above the rows is also present, or when a freshly
    // measured wrapped row pushes the bottom further). One rAF, no loops.
    const raf = requestAnimationFrame(() => {
      if (!autoScroll) return;
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [lines, autoScroll, virtualizer]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    setAutoScroll(atBottom);
  }

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          left: 0,
          background: t.scrim,
          zIndex: 30,
          animation: "fs-fade-in .18s ease",
        }}
      />
      <div
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          width: 680,
          maxWidth: "92vw",
          background: t.surface,
          borderLeft: `1px solid ${t.border}`,
          boxShadow:
            mode === "dark"
              ? "-12px 0 32px rgba(0,0,0,0.4)"
              : "-12px 0 32px rgba(15,20,30,0.12)",
          display: "flex",
          flexDirection: "column",
          zIndex: 31,
          animation: "fs-slide-from-right .22s cubic-bezier(.2,.7,.2,1)",
        }}
      >
        <header
          style={{
            padding: "16px 22px 12px",
            borderBottom: `1px solid ${t.borderSoft}`,
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
              }}
            >
              <Eyebrow t={t}>Pod logs</Eyebrow>
              <span style={{ color: t.textMuted, fontSize: 11 }}>·</span>
              <span
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: 11,
                  color: t.textDim,
                }}
              >
                {pod.namespace}
              </span>
            </div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                fontFamily: FONT_MONO,
                wordBreak: "break-all",
                lineHeight: 1.3,
                color: t.text,
              }}
            >
              {pod.name}
            </div>
            <div
              style={{
                marginTop: 8,
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              {pod.containers.length > 1 ? (
                <Select
                  t={t}
                  fullWidth={false}
                  value={container ?? ""}
                  onChange={(v) => setContainer(v)}
                  options={pod.containers.map((c) => ({ value: c, label: c }))}
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
              <StreamStatus status={status} t={t} mode={mode} />
            </div>
          </div>
          <IconBtn t={t} title="Close (Esc)" onClick={onClose}>
            {Icons.close}
          </IconBtn>
        </header>

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
            <ErrorBlock
              t={t}
              message={status.message}
              kindLabel="pod"
              verb="stream"
              inline
            />
          )}
          {lines.length > 0 && (
            <div
              style={{
                position: "relative",
                height: totalSize,
                width: "100%",
              }}
            >
              {virtualItems.map((vi) => {
                const l = lines[vi.index];
                if (!l) return null;
                return (
                  <div
                    key={l.id}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    <LogLine entry={l} />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <footer
          style={{
            padding: "8px 22px",
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
        </footer>
      </div>
    </>
  );
}

function StreamStatus({
  status,
  t,
  mode,
}: {
  status: Status;
  t: ReturnType<typeof tokens>;
  mode: ThemeMode;
}) {
  if (status.kind === "starting")
    return <StatusPill status="Pending" t={t} mode={mode} dense />;
  if (status.kind === "streaming")
    return <StatusPill status="Running" t={t} mode={mode} dense />;
  if (status.kind === "ended")
    return (
      <Tooltip label={status.reason}>
        <span
          style={{
            fontSize: 11,
            color: t.textMuted,
            fontFamily: FONT_MONO,
          }}
        >
          ended · {status.reason}
        </span>
      </Tooltip>
    );
  return <StatusPill status="Error" t={t} mode={mode} dense />;
}

// Memo per-line so a new tail line doesn't re-render the prior 5000 — the
// `LineEntry` reference is stable in the ring buffer, so a shallow prop
// equality check is enough to short-circuit. `contain: content` isolates
// layout/paint per row, which keeps long logs scrolling smoothly.
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
