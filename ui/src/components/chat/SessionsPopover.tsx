import { useEffect, useMemo, useRef, useState } from "react";
import { useResolvedTheme } from "../../store";
import { tokens, FF_MONO, FONT_SANS, type ThemeMode, R_LG, R_MD, FS_MD, FS_SM, FS_XS } from "../../theme";
import { Btn, Icons } from "../ui";
import type { SessionMeta } from "../../types";

/// Per-session live runtime hint. Only includes sessions that are
/// currently open in the parent's chat tab — flat sessions are absent
/// from the map and rendered with no status indicator.
export type SessionLiveState = {
  /// Backend is mid-turn (between `assistant_start` and `assistant_end`).
  streaming: boolean;
  /// Outstanding tool-call approvals waiting on the operator. Drives
  /// the amber "needs attention" dot — a session with a pending
  /// approval can't make progress until the operator returns to it.
  pendingApprovals: number;
};

type Props = {
  mode: ThemeMode;
  sessions: SessionMeta[];
  currentSessionId: string | null;
  /// Live state for sessions currently open in this tab. Sessions
  /// absent from the record are treated as idle.
  liveStates: Record<string, SessionLiveState>;
  busy: boolean;
  onPick: (sessionId: string) => void;
  onCreate: () => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
  onDeleteAll: () => void;
  onClose: () => void;
};

// SessionsPopover — dropdown anchored under the ChatHeader. Lets the
// operator pick a different session for the bound cluster, start a new
// one, rename, or delete. Sorted newest-first by `updated_at_unix_ms`
// and grouped under Today / Yesterday / This week / Older so even long
// session histories stay scannable. Search input narrows by title or
// model id.
export function SessionsPopover({
  
  sessions,
  currentSessionId,
  liveStates,
  busy,
  onPick,
  onCreate,
  onRename,
  onDelete,
  onDeleteAll,
  onClose,
}: Props) {
  const t = useResolvedTheme().tokens;
  const ref = useRef<HTMLDivElement | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [query, setQuery] = useState("");

  // Close on outside click + Esc. Same pattern as Select in atoms.tsx.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Filter + sort + group. Sorting first means each bucket already
  // arrives newest-first, so we just walk the sorted array and emit
  // group breaks where the bucket changes.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? sessions.filter((s) => {
          const title = (s.title || "").toLowerCase();
          const model = (s.model || "").toLowerCase();
          return title.includes(q) || model.includes(q);
        })
      : sessions;
    const sorted = [...filtered].sort(
      (a, b) => b.updated_at_unix_ms - a.updated_at_unix_ms,
    );
    const buckets: Record<BucketId, SessionMeta[]> = {
      today: [],
      yesterday: [],
      thisWeek: [],
      older: [],
    };
    for (const s of sorted) {
      buckets[bucketOf(s.updated_at_unix_ms)].push(s);
    }
    return BUCKET_ORDER
      .map((id) => ({ id, label: BUCKET_LABEL[id], rows: buckets[id] }))
      .filter((g) => g.rows.length > 0);
  }, [sessions, query]);

  const totalShown = groups.reduce((n, g) => n + g.rows.length, 0);

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        top: "100%",
        left: 8,
        right: 8,
        zIndex: 50,
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: R_LG,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        marginTop: 4,
        maxHeight: 420,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        fontFamily: FONT_SANS,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          borderBottom: `1px solid ${t.borderSoft}`,
          background: t.surfaceAlt,
        }}
      >
        <div
          style={{
            flex: 1,
            color: t.textMuted,
            fontSize: FS_SM,
            fontFamily: FF_MONO,
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          Sessions
        </div>
        {sessions.length > 0 && (
          <Btn
            t={t}
            variant="danger"
            size="sm"
            onClick={() => {
              if (
                confirm(
                  `Delete all ${sessions.length} session${sessions.length === 1 ? "" : "s"} for this cluster? This cannot be undone.`,
                )
              ) {
                onDeleteAll();
              }
            }}
            disabled={busy}
            icon={Icons.trash}
            title="Delete all sessions for this cluster"
          >
            Remove all
          </Btn>
        )}
        <Btn
          t={t}
          variant="primary"
          size="sm"
          onClick={onCreate}
          disabled={busy}
          icon={Icons.plus}
        >
          New chat
        </Btn>
      </div>
      {sessions.length > 0 && (
        <div
          style={{
            padding: "6px 10px",
            borderBottom: `1px solid ${t.borderSoft}`,
            background: t.surface,
          }}
        >
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title or model…"
            style={{
              width: "100%",
              boxSizing: "border-box",
              fontSize: FS_MD,
              fontFamily: FONT_SANS,
              color: t.text,
              background: t.surfaceAlt,
              border: `1px solid ${t.borderSoft}`,
              borderRadius: R_MD,
              padding: "5px 8px",
              outline: "none",
            }}
          />
        </div>
      )}
      <div style={{ overflow: "auto", flex: 1 }}>
        {sessions.length === 0 ? (
          <div
            style={{
              padding: 14,
              color: t.textDim,
              fontSize: FS_MD,
              textAlign: "center",
            }}
          >
            No sessions yet.
          </div>
        ) : totalShown === 0 ? (
          <div
            style={{
              padding: 14,
              color: t.textDim,
              fontSize: FS_MD,
              textAlign: "center",
            }}
          >
            No sessions match “{query}”.
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.id}>
              <div
                style={{
                  position: "sticky",
                  top: 0,
                  zIndex: 1,
                  padding: "5px 10px",
                  background: t.surfaceAlt,
                  borderBottom: `1px solid ${t.borderSoft}`,
                  color: t.textMuted,
                  fontSize: FS_XS,
                  fontFamily: FF_MONO,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                }}
              >
                {g.label}
              </div>
              {g.rows.map((s) => {
                const isCurrent = s.id === currentSessionId;
                const isRenaming = renamingId === s.id;
                const live = liveStates[s.id];
                return (
                  <div
                    key={s.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 10px",
                      borderBottom: `1px solid ${t.borderSoft}`,
                      background: isCurrent ? t.surfaceAlt : "transparent",
                      cursor: isRenaming ? "default" : "pointer",
                    }}
                    onClick={() => {
                      if (isRenaming) return;
                      if (!isCurrent) onPick(s.id);
                    }}
                  >
                    <StatusDot t={t} live={live} />
                    <div
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                      }}
                    >
                      {isRenaming ? (
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              const v = renameDraft.trim();
                              if (v) onRename(s.id, v);
                              setRenamingId(null);
                            } else if (e.key === "Escape") {
                              setRenamingId(null);
                            }
                          }}
                          onBlur={() => {
                            const v = renameDraft.trim();
                            if (v && v !== s.title) onRename(s.id, v);
                            setRenamingId(null);
                          }}
                          style={{
                            fontSize: FS_MD,
                            color: t.text,
                            background: t.surface,
                            border: `1px solid ${t.borderSoft}`,
                            borderRadius: R_MD,
                            padding: "3px 6px",
                            outline: "none",
                            fontFamily: FONT_SANS,
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            color: isCurrent ? t.text : t.textMuted,
                            fontSize: FS_MD,
                            fontWeight: isCurrent ? 600 : 400,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {s.title || "Untitled"}
                        </div>
                      )}
                      <div
                        style={{
                          color: t.textDim,
                          fontSize: FS_XS,
                          fontFamily: FF_MONO,
                          display: "flex",
                          gap: 8,
                        }}
                      >
                        <span>{relativeTime(s.updated_at_unix_ms)}</span>
                        {s.model && (
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {s.model}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenameDraft(s.title);
                        setRenamingId(s.id);
                      }}
                      title="Rename"
                      style={iconBtn(t)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (
                          confirm(
                            `Delete chat "${s.title || "Untitled"}"? This cannot be undone.`,
                          )
                        ) {
                          onDelete(s.id);
                        }
                      }}
                      title="Delete"
                      style={{ ...iconBtn(t), color: t.bad }}
                    >
                      {Icons.trash}
                    </button>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function StatusDot({
  t,
  live,
}: {
  t: ReturnType<typeof tokens>;
  live: SessionLiveState | undefined;
}) {
  // Three states, in priority order:
  //   - pending approval ⇒ amber, attention-grabbing (operator MUST
  //     return to unblock)
  //   - streaming ⇒ blue, pulsing (turn in flight; operator can ignore)
  //   - idle / not open ⇒ no dot (avoid visual noise on flat rows)
  let title: string | undefined;
  let color: string | undefined;
  let pulse = false;
  if (live && live.pendingApprovals > 0) {
    color = t.warn;
    pulse = true;
    title =
      live.pendingApprovals === 1
        ? "Awaiting approval"
        : `${live.pendingApprovals} approvals waiting`;
  } else if (live && live.streaming) {
    color = t.info;
    pulse = true;
    title = "Streaming…";
  }
  return (
    <div
      title={title}
      aria-label={title}
      className={pulse ? "fs-pulse-dot" : undefined}
      style={{
        width: 8,
        height: 8,
        // Always-round status dot — theme radius would distort under the
        // .fs-pulse-dot scale animation.
        borderRadius: "50%",
        flexShrink: 0,
        background: color ?? "transparent",
        border: color ? "none" : `1px solid ${t.borderSoft}`,
      }}
    />
  );
}

function iconBtn(t: ReturnType<typeof tokens>): React.CSSProperties {
  return {
    background: "transparent",
    border: `1px solid ${t.borderSoft}`,
    borderRadius: R_MD,
    width: 24,
    height: 24,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: t.textMuted,
    cursor: "pointer",
    padding: 0,
  };
}

function relativeTime(unixMs: number): string {
  const diff = Date.now() - unixMs;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(unixMs).toLocaleDateString();
}

type BucketId = "today" | "yesterday" | "thisWeek" | "older";

const BUCKET_ORDER: BucketId[] = ["today", "yesterday", "thisWeek", "older"];

const BUCKET_LABEL: Record<BucketId, string> = {
  today: "Today",
  yesterday: "Yesterday",
  thisWeek: "This week",
  older: "Older",
};

function bucketOf(unixMs: number): BucketId {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  // "This week" = within the last 7 days, after today/yesterday have
  // claimed their share. So the threshold is 6 days before todayStart.
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 6);
  if (unixMs >= todayStart.getTime()) return "today";
  if (unixMs >= yesterdayStart.getTime()) return "yesterday";
  if (unixMs >= weekStart.getTime()) return "thisWeek";
  return "older";
}
