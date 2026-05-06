import { useEffect, useRef, useState } from "react";
import { tokens, FONT_MONO, FONT_SANS, type ThemeMode } from "../../theme";
import { Btn, Icons } from "../ui";
import type { SessionMeta } from "../../types";

type Props = {
  mode: ThemeMode;
  sessions: SessionMeta[];
  currentSessionId: string | null;
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
// one, rename, or delete. Sorted newest-first by `updated_at_unix_ms` so
// the chat the operator was just in floats to the top.
export function SessionsPopover({
  mode,
  sessions,
  currentSessionId,
  busy,
  onPick,
  onCreate,
  onRename,
  onDelete,
  onDeleteAll,
  onClose,
}: Props) {
  const t = tokens(mode);
  const ref = useRef<HTMLDivElement | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

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

  const sorted = [...sessions].sort(
    (a, b) => b.updated_at_unix_ms - a.updated_at_unix_ms,
  );

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
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        marginTop: 4,
        maxHeight: 360,
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
            fontSize: 11,
            fontFamily: FONT_MONO,
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          Sessions
        </div>
        {sorted.length > 0 && (
          <Btn
            t={t}
            variant="danger"
            size="sm"
            onClick={() => {
              if (
                confirm(
                  `Delete all ${sorted.length} session${sorted.length === 1 ? "" : "s"} for this cluster? This cannot be undone.`,
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
      <div style={{ overflow: "auto", flex: 1 }}>
        {sorted.length === 0 ? (
          <div
            style={{
              padding: 14,
              color: t.textDim,
              fontSize: 12,
              textAlign: "center",
            }}
          >
            No sessions yet.
          </div>
        ) : (
          sorted.map((s) => {
            const isCurrent = s.id === currentSessionId;
            const isRenaming = renamingId === s.id;
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
                        fontSize: 12.5,
                        color: t.text,
                        background: t.surface,
                        border: `1px solid ${t.borderSoft}`,
                        borderRadius: 4,
                        padding: "3px 6px",
                        outline: "none",
                        fontFamily: FONT_SANS,
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        color: isCurrent ? t.text : t.textMuted,
                        fontSize: 12.5,
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
                      fontSize: 10,
                      fontFamily: FONT_MONO,
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
          })
        )}
      </div>
    </div>
  );
}

function iconBtn(t: ReturnType<typeof tokens>): React.CSSProperties {
  return {
    background: "transparent",
    border: `1px solid ${t.borderSoft}`,
    borderRadius: 4,
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
