import { useEffect, useMemo, useRef, useState } from "react";
import type { DockTab } from "../../store";
import { useAppStore } from "../../store";
import { tokens, FONT_SANS, type ThemeMode } from "../../theme";
import { api } from "../../api";
import type {
  AgentChatMessage,
  ChatEvent,
  ChatTool,
  SessionMeta,
} from "../../types";
import { Btn, Icons } from "../ui";
import { ChatHeader } from "./ChatHeader";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { SessionsPopover } from "./SessionsPopover";
import { ToolsPopover } from "./ToolsPopover";
import {
  chatStateFromMessages,
  applyChatEvent,
  type ChatViewState,
  type ChatViewMessage,
} from "./chatStreaming";

type Props = {
  mode: ThemeMode;
  tab: DockTab;
};

type ChatTabState = {
  clusterId: string;
  contextLabel: string;
  sessionId: string | null;
  chatId: string | null;
};

type Status =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "needs_settings"; reason: string }
  | { kind: "ready" }
  | { kind: "error"; message: string };

// DockChat — top-level chat tab body. Owns the live Channel<ChatEvent>, the
// current session metadata, and the in-flight streaming state. Composes
// ChatHeader + MessageList + ChatInput so each is a small atom.
export function DockChat({ mode, tab }: Props) {
  const t = tokens(mode);
  const patchTabState = useAppStore((s) => s.patchDockTabState);
  const tabState = tab.state as Partial<ChatTabState>;
  const clusterId = tabState.clusterId ?? "";
  const contextLabel = tabState.contextLabel ?? clusterId;

  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [view, setView] = useState<ChatViewState>(() =>
    chatStateFromMessages([]),
  );
  const [streaming, setStreaming] = useState(false);
  const chatIdRef = useRef<string | null>(null);
  const closeRef = useRef<(() => void) | null>(null);
  // Backend events fire one-per-token during streaming. Coalesce them
  // through requestAnimationFrame so we render at most once per paint
  // (~60fps) instead of once per token (sometimes 100+/s for fast
  // models). Without this, parseBlocks runs against the streaming
  // bubble's growing text on every token = O(n²) cumulative parse
  // work over a long response.
  const pendingEventsRef = useRef<ChatEvent[]>([]);
  const rafRef = useRef<number | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [usage, setUsage] = useState<{
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsList, setToolsList] = useState<ChatTool[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  /// `null` outside compaction; set to the in-flight `tokens_before`
  /// while a compaction call is running. Drives the small "summarising
  /// older context…" pill in the chat header.
  const [compacting, setCompacting] = useState<number | null>(null);

  // One-time bring-up: reuse an existing sessionId on the tab state if
  // present (the operator might re-open after a hide). Otherwise create a
  // new session bound to this cluster.
  useEffect(() => {
    if (!clusterId) {
      setStatus({
        kind: "error",
        message: "no cluster context bound to this chat",
      });
      return;
    }
    let cancelled = false;
    (async () => {
      setStatus({ kind: "opening" });
      try {
        const settings = await api.aiGetSettings();
        const active = settings.providers[settings.active_provider];
        if (!active?.configured) {
          if (!cancelled) {
            setStatus({
              kind: "needs_settings",
              reason:
                "active provider has no credential — open Settings → AI to connect one",
            });
          }
          return;
        }
        let sessionId = tabState.sessionId ?? null;
        // No persisted session on this tab — open the most recent one for
        // this cluster instead of immediately minting a fresh chat. The
        // operator picks "New chat" from the sessions popover when they
        // actually want a clean slate; auto-creating on every open litters
        // the disk with empty sessions.
        if (!sessionId) {
          try {
            const existing = await api.chatListSessions(clusterId);
            if (existing.length > 0) {
              const latest = [...existing].sort(
                (a, b) => b.updated_at_unix_ms - a.updated_at_unix_ms,
              )[0]!;
              sessionId = latest.id;
              patchTabState(tab.id, { sessionId });
            }
          } catch {
            /* listing failed — fall through to the create path */
          }
        }
        // Resolve the default model up front — both the load-fallback and
        // the fresh-create path want it, and the API call may be slow.
        const pickModel = async (): Promise<string | null> => {
          let model: string | null = settings.default_model;
          if (!model) {
            try {
              const models = await api.aiListModels();
              model = models[0]?.id ?? null;
            } catch {
              /* empty list / network — leave null and let backend default */
            }
          }
          return model;
        };
        let sessionMeta: SessionMeta;
        if (sessionId) {
          // Load can fail when the persisted id points at a session that's
          // been deleted (another tab nuked it, the JSONL was hand-removed,
          // or the index is stale). Don't surface that as a hard error —
          // mint a fresh session and carry on so the operator can keep
          // chatting instead of staring at "session not found".
          try {
            const data = await api.chatLoadSession(sessionId);
            sessionMeta = data.meta;
            const msgs = data.events.flatMap((e): AgentChatMessage[] =>
              e.kind === "message" ? [e.message] : [],
            );
            if (!cancelled) setView(chatStateFromMessages(msgs));
          } catch (err) {
            console.warn("chatLoadSession failed; minting fresh", err);
            sessionMeta = await api.chatCreateSession(
              clusterId,
              await pickModel(),
            );
            sessionId = sessionMeta.id;
            patchTabState(tab.id, { sessionId });
            if (!cancelled) setView(chatStateFromMessages([]));
          }
        } else {
          // First time on this cluster — mint a session so the chat has
          // somewhere to write. From here on out we'll resume it on reopen.
          sessionMeta = await api.chatCreateSession(clusterId, await pickModel());
          sessionId = sessionMeta.id;
          patchTabState(tab.id, { sessionId });
        }
        const flushEvents = () => {
          rafRef.current = null;
          // Effect cleanup races us if the user switched session
          // while a frame was queued — drop the queue rather than
          // apply old-session events to new-session state.
          if (cancelled) {
            pendingEventsRef.current = [];
            return;
          }
          const queue = pendingEventsRef.current;
          if (queue.length === 0) return;
          pendingEventsRef.current = [];
          // Fold every queued event into the view in a single
          // setView so React renders the transcript once per frame
          // regardless of how many tokens arrived.
          setView((prev) => {
            let next = prev;
            for (const e of queue) next = applyChatEvent(next, e);
            return next;
          });
          // Apply per-event side-effect setStates. React batches
          // these inside the same callback so they cost one render.
          for (const evt of queue) {
            if (evt.type === "assistant_start") setStreaming(true);
            else if (evt.type === "assistant_end" || evt.type === "error") {
              setStreaming(false);
            } else if (evt.type === "usage") {
              setUsage({
                promptTokens: evt.prompt_tokens,
                completionTokens: evt.completion_tokens,
                totalTokens: evt.total_tokens,
              });
            } else if (evt.type === "compaction_started") {
              setCompacting(evt.tokens_before);
            } else if (evt.type === "compaction_completed") {
              setCompacting(null);
              // Backend zeroes last_total_tokens on compaction; mirror
              // it on the chip so the running count matches what the
              // index will report on next reopen.
              setUsage({
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
              });
            }
          }
        };
        const opened = await api.chatOpen(sessionId, (evt: ChatEvent) => {
          pendingEventsRef.current.push(evt);
          if (rafRef.current === null) {
            rafRef.current = requestAnimationFrame(flushEvents);
          }
        });
        if (cancelled) {
          opened.close();
          api.chatClose(opened.chatId).catch(() => {});
          return;
        }
        chatIdRef.current = opened.chatId;
        closeRef.current = opened.close;
        patchTabState(tab.id, { chatId: opened.chatId });
        setMeta(sessionMeta);
        // Seed the token-usage chip from the persisted meta so the
        // operator sees the running count immediately on reopen
        // (instead of waiting for the next round's Usage event). The
        // index only carries `total_tokens`; we don't have the
        // prompt/completion split for prior turns, so show 0 for
        // those — the running total is what matters for compaction.
        if (
          typeof sessionMeta.last_total_tokens === "number" &&
          sessionMeta.last_total_tokens > 0
        ) {
          setUsage({
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: sessionMeta.last_total_tokens,
          });
        }
        setStatus({ kind: "ready" });
      } catch (e) {
        if (cancelled) return;
        setStatus({ kind: "error", message: String(e) });
      }
    })();
    return () => {
      cancelled = true;
      // Drop any queued events and cancel the pending frame so the
      // next session's effect doesn't inherit stale token deltas.
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingEventsRef.current = [];
      const close = closeRef.current;
      const id = chatIdRef.current;
      if (close) close();
      if (id) api.chatClose(id).catch(() => {});
      chatIdRef.current = null;
      closeRef.current = null;
    };
    // `sessionEpoch` retriggers the effect when the operator switches to a
    // different session via the popover. We deliberately read tabState.sessionId
    // at run-time inside the closure — it's already updated by patchTabState
    // before the bump.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, tab.id, sessionEpoch]);

  const onSend = async (text: string) => {
    const id = chatIdRef.current;
    if (!id) return;
    if (!text.trim()) return;
    // Optimistic append so the user's bubble appears immediately, before the
    // backend's first AssistantStart fires. The backend persists the user
    // message itself; the optimistic add is purely for perceived latency.
    setView((prev) => ({
      ...prev,
      messages: [
        ...prev.messages,
        {
          id: `local-${Date.now()}`,
          role: "user",
          content: text,
        } satisfies ChatViewMessage,
      ],
    }));
    try {
      await api.chatSendMessage(id, text);
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  };

  const onCancel = async () => {
    const id = chatIdRef.current;
    if (!id) return;
    try {
      await api.chatCancelStreaming(id);
    } catch {
      /* ignore — best-effort */
    }
  };

  const subtitle = useMemo(
    () => (meta ? meta.title : "New chat"),
    [meta],
  );

  const refreshSessions = async () => {
    if (!clusterId) return;
    try {
      const list = await api.chatListSessions(clusterId);
      setSessions(list);
    } catch {
      /* best-effort — popover stays empty */
    }
  };

  const onToggleSessions = () => {
    setSessionsOpen((open) => {
      const next = !open;
      if (next) refreshSessions();
      return next;
    });
  };

  const onToggleTools = () => {
    setToolsOpen((open) => {
      const next = !open;
      if (next) {
        const id = chatIdRef.current;
        if (!id) return next;
        setToolsLoading(true);
        setToolsError(null);
        api
          .chatListTools(id)
          .then((list) => setToolsList(list))
          .catch((err) => setToolsError(String(err)))
          .finally(() => setToolsLoading(false));
      }
      return next;
    });
  };

  // Tear down the current chat and re-run the bring-up effect against the
  // new sessionId. We can't just call chatClose+chatOpen inline — the
  // effect's cleanup is what removes the chat from the registry on the
  // backend. Bumping sessionEpoch retriggers the effect cleanly.
  const switchToSession = (sessionId: string) => {
    if (sessionId === tabState.sessionId) {
      setSessionsOpen(false);
      return;
    }
    patchTabState(tab.id, { sessionId, chatId: null });
    setMeta(null);
    setView(chatStateFromMessages([]));
    setStreaming(false);
    setSessionsOpen(false);
    setSessionEpoch((n) => n + 1);
  };

  const onCreateSession = async () => {
    if (!clusterId) return;
    setSessionBusy(true);
    try {
      const settings = await api.aiGetSettings();
      let model: string | null = settings.default_model;
      if (!model) {
        try {
          const models = await api.aiListModels();
          model = models[0]?.id ?? null;
        } catch {
          /* leave null */
        }
      }
      const created = await api.chatCreateSession(clusterId, model);
      await refreshSessions();
      switchToSession(created.id);
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    } finally {
      setSessionBusy(false);
    }
  };

  const onRenameSession = async (sessionId: string, title: string) => {
    setSessionBusy(true);
    try {
      await api.chatRenameSession(sessionId, title);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title } : s)),
      );
      if (sessionId === tabState.sessionId) {
        setMeta((m) => (m ? { ...m, title } : m));
      }
    } catch {
      /* surface as error? — for now silent */
    } finally {
      setSessionBusy(false);
    }
  };

  const onDeleteAllSessions = async () => {
    if (!clusterId) return;
    setSessionBusy(true);
    try {
      const list = await api.chatListSessions(clusterId);
      // Sequential — backend uses one JSONL file per session and a single
      // index file; serializing keeps the index consistent without a bulk
      // command.
      for (const s of list) {
        await api.chatDeleteSession(s.id).catch(() => {});
      }
      setSessions([]);
      // Mint a replacement so the chat doesn't dangle pointing at a gone id.
      const settings = await api.aiGetSettings();
      let model: string | null = settings.default_model;
      if (!model) {
        try {
          const models = await api.aiListModels();
          model = models[0]?.id ?? null;
        } catch {
          /* leave null */
        }
      }
      const created = await api.chatCreateSession(clusterId, model);
      await refreshSessions();
      switchToSession(created.id);
    } catch {
      /* best-effort */
    } finally {
      setSessionBusy(false);
    }
  };

  const onDeleteSession = async (sessionId: string) => {
    setSessionBusy(true);
    try {
      await api.chatDeleteSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      // If we just deleted the active session, mint a fresh one so the chat
      // doesn't dangle pointing at a gone session.
      if (sessionId === tabState.sessionId) {
        const settings = await api.aiGetSettings();
        let model: string | null = settings.default_model;
        if (!model) {
          try {
            const models = await api.aiListModels();
            model = models[0]?.id ?? null;
          } catch {
            /* leave null */
          }
        }
        const created = await api.chatCreateSession(clusterId, model);
        await refreshSessions();
        switchToSession(created.id);
      }
    } catch {
      /* best-effort */
    } finally {
      setSessionBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: t.surface,
        fontFamily: FONT_SANS,
      }}
    >
      <div style={{ position: "relative", flexShrink: 0 }}>
        <ChatHeader
          mode={mode}
          title={subtitle}
          contextLabel={contextLabel}
          modelId={meta?.model ?? ""}
          mcp={view.mcp ?? null}
          onToggleSessions={onToggleSessions}
          sessionsOpen={sessionsOpen}
          onToggleTools={onToggleTools}
          toolsOpen={toolsOpen}
        />
        {sessionsOpen && (
          <SessionsPopover
            mode={mode}
            sessions={sessions}
            currentSessionId={tabState.sessionId ?? null}
            busy={sessionBusy}
            onPick={switchToSession}
            onCreate={onCreateSession}
            onRename={onRenameSession}
            onDelete={onDeleteSession}
            onDeleteAll={onDeleteAllSessions}
            onClose={() => setSessionsOpen(false)}
          />
        )}
        {toolsOpen && (
          <ToolsPopover
            mode={mode}
            tools={toolsList}
            mcp={view.mcp ?? null}
            loading={toolsLoading}
            error={toolsError}
            onClose={() => setToolsOpen(false)}
          />
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {status.kind === "opening" && (
          <ChatStatusOverlay mode={mode} message="Opening session…" />
        )}
        {status.kind === "needs_settings" && (
          <ChatStatusOverlay
            mode={mode}
            message={status.reason}
            action={
              <Btn
                t={t}
                variant="primary"
                size="sm"
                onClick={() => useAppStore.getState().openSettings()}
              >
                Open settings
              </Btn>
            }
          />
        )}
        {status.kind === "error" && (
          <ChatStatusOverlay
            mode={mode}
            message={status.message}
            tone="bad"
          />
        )}
        {status.kind === "ready" && (
          <MessageList
            mode={mode}
            state={view}
            streaming={streaming}
            chatId={chatIdRef.current}
            compacting={compacting !== null}
          />
        )}
      </div>

      <ChatInput
        mode={mode}
        disabled={status.kind !== "ready"}
        streaming={streaming}
        approvalMode={meta?.approval_mode ?? "approve_per_write"}
        onApprovalModeChange={(am) => {
          if (!chatIdRef.current) return;
          api.chatSetApprovalMode(chatIdRef.current, am).catch(() => {});
          setMeta((m) => (m ? { ...m, approval_mode: am } : m));
        }}
        usage={usage}
        onCompact={
          status.kind === "ready"
            ? () => {
                if (!chatIdRef.current) return;
                setCompacting(0);
                api
                  .chatCompact(chatIdRef.current)
                  .catch(() => setCompacting(null));
              }
            : null
        }
        compacting={compacting !== null}
        onSend={onSend}
        onCancel={onCancel}
      />
    </div>
  );
}

function ChatStatusOverlay({
  mode,
  message,
  tone,
  action,
}: {
  mode: ThemeMode;
  message: string;
  tone?: "default" | "bad";
  action?: React.ReactNode;
}) {
  const t = tokens(mode);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 12,
        padding: 24,
        textAlign: "center",
        color: tone === "bad" ? t.bad : t.textMuted,
        fontSize: 12,
      }}
    >
      <div style={{ display: "inline-flex", color: t.textDim }}>
        {Icons.chat}
      </div>
      <div style={{ maxWidth: 420 }}>{message}</div>
      {action}
    </div>
  );
}
