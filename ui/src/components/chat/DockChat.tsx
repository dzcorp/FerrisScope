import { useEffect, useMemo, useRef, useState } from "react";
import type { DockTab } from "../../store";
import { useAppStore } from "../../store";
import { tokens, FONT_SANS, type ThemeMode } from "../../theme";
import { api } from "../../api";
import type {
  AgentChatMessage,
  AiSettingsWire,
  ChatEvent,
  ChatTool,
  ModelInfo,
  ProviderKind,
  SessionMeta,
} from "../../types";
import { Btn, Icons } from "../ui";
import { ChatHeader } from "./ChatHeader";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { SessionsPopover } from "./SessionsPopover";
import { ToolsPopover } from "./ToolsPopover";
import { ModelPickerPopover } from "./ModelPickerPopover";
import { ProviderPickerPopover } from "./ProviderPickerPopover";
import {
  chatStateFromMessages,
  applyChatEvent,
  type ChatViewState,
  type ChatViewMessage,
} from "./chatStreaming";

type Props = {
  mode: ThemeMode;
  tab: DockTab;
  /// `true` when this tab is the active one in its dock placement. The
  /// dock keeps every tab mounted but hides inactive ones with
  /// `visibility: hidden`, so we can't rely on mount/unmount to detect
  /// foregrounding. Used to ping `chat_refresh_status` so the header
  /// tools chip catches up after the operator returns from another tab
  /// or the Settings modal.
  visible: boolean;
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
export function DockChat({ mode, tab, visible }: Props) {
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
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  // Cached AI settings, captured once at chat-open time. We need the
  // provider's display name for the model picker caption; the chat's
  // bound provider lives in `meta.provider_kind`. Refreshed whenever the
  // operator picks "Settings" from the popover so labels stay in sync.
  const [aiSettings, setAiSettings] = useState<AiSettingsWire | null>(null);
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
        if (!cancelled) setAiSettings(settings);
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
            } else if (evt.type === "title_updated") {
              // Auto-titling landed. Mirror the backend's journaled
              // title onto the in-memory meta so the header updates
              // without a session reload, and patch the cached
              // sessions list so the popover row reflects the new
              // title next time the operator opens it.
              const nextTitle = evt.title;
              let sessionId: string | null = null;
              setMeta((m) => {
                if (!m) return m;
                sessionId = m.id;
                return { ...m, title: nextTitle };
              });
              if (sessionId) {
                setSessions((prev) =>
                  prev.map((s) =>
                    s.id === sessionId ? { ...s, title: nextTitle } : s,
                  ),
                );
              }
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
        // Seed `view.mcp` from the in-band snapshot so the header chip
        // turns green immediately. The streamed `mcp_status` events
        // (initial emit + per-server updates) will continue to land
        // through the channel and overwrite this with the same / fresher
        // values — the reducer wholesale-replaces `mcp` from each event,
        // so duplicates are harmless.
        setView((prev) => ({
          ...prev,
          mcp: {
            nativeToolCount: opened.initialMcp.nativeToolCount,
            servers: opened.initialMcp.servers,
          },
        }));
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
        // Belt-and-braces: re-request the MCP status snapshot after the
        // JS-side state is fully wired. The backend already emits one
        // during `chat_open`, but events sent during the same Tauri
        // invoke can race with the channel handler / RAF flush in some
        // orderings — leaving `view.mcp` null and the header chip
        // showing `…` even though the runtime has all the tools (the
        // popover proves it via the direct `chat_list_tools` query).
        // This second emit is idempotent (the reducer wholesale-replaces
        // `view.mcp` from each event) and cheap.
        api.chatRefreshStatus(opened.chatId).catch(() => {});
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

  // Self-healing tools-chip: ping the backend to re-emit `mcp_status`
  // whenever this chat tab returns to the foreground (tab switch back,
  // Settings modal closed). The chip's count lives in `view.mcp` which
  // is only set by streamed mcp_status events; the backend emits at
  // chat_open and on MCP-server spawn results, so any UI flow that
  // races / resets the in-memory snapshot leaves a stale "0 tools"
  // chip even though the runtime still has all tools (the popover,
  // which queries `chat_list_tools` directly, proves it). This makes
  // the chip eventually-consistent without us having to find the exact
  // race.
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  useEffect(() => {
    if (!visible || settingsOpen) return;
    const id = chatIdRef.current;
    if (!id) return;
    api.chatRefreshStatus(id).catch(() => {});
  }, [visible, settingsOpen]);

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

  // Fetch the model catalogue for the chat's bound provider on demand.
  // Cached on the component for the chat's lifetime — operators rarely
  // need to refresh while a chat is open. The popover's Retry button
  // bypasses the cache.
  const fetchModelsForChat = (force = false) => {
    const provider = meta?.provider_kind;
    if (!provider) return;
    if (!force && (modelsLoading || models !== null)) return;
    setModelsLoading(true);
    setModelsError(null);
    api
      .aiListModels(provider)
      .then((list) => setModels(list))
      .catch((err) => {
        setModelsError(String(err));
        setModels([]);
      })
      .finally(() => setModelsLoading(false));
  };

  const onToggleModelPicker = () => {
    setModelPickerOpen((open) => {
      const next = !open;
      if (next) fetchModelsForChat();
      return next;
    });
  };

  const onPickModel = async (modelId: string) => {
    const id = chatIdRef.current;
    if (!id) return;
    if (modelId === meta?.model) {
      setModelPickerOpen(false);
      return;
    }
    // Optimistic header update — the API call is fire-and-forget from
    // the user's perspective. On failure we surface in the error
    // overlay just like other chat-mutating actions.
    setMeta((m) => (m ? { ...m, model: modelId } : m));
    setModelPickerOpen(false);
    try {
      await api.chatSetModel(id, modelId);
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  };

  const onOpenAiSettings = (anchor?: string) => {
    setModelPickerOpen(false);
    setProviderPickerOpen(false);
    useAppStore.getState().openSettings({ section: "ai", anchor });
  };

  const onToggleProviderPicker = () => {
    setProviderPickerOpen((open) => {
      const next = !open;
      // Re-pull AI settings on each open so freshly-configured providers
      // (operator went to Settings → AI between picker views) appear
      // without needing a chat reopen.
      if (next) {
        api
          .aiGetSettings()
          .then((s) => setAiSettings(s))
          .catch(() => {});
      }
      return next;
    });
  };

  // Provider switch — promotes the chosen provider to `active_provider`
  // (so subsequent New chats default to it) and mints a fresh session
  // for this cluster bound to that provider, then switches the tab to
  // the new session. The previous chat is preserved on disk and still
  // reachable from the sessions popover. Mid-stream provider hot-swap
  // isn't offered: providers translate transcripts into different wire
  // shapes and tool-call ID streams don't carry across cleanly.
  const onPickProvider = async (kind: ProviderKind) => {
    setProviderPickerOpen(false);
    if (!clusterId) return;
    if (kind === meta?.provider_kind) return;
    setSessionBusy(true);
    try {
      const next = await api.aiSetSettings({ active_provider: kind });
      setAiSettings(next);
      // Pick a model up front from the new provider so the new chat
      // doesn't open with an empty model id (which would make the
      // header chip read "no model selected" until the operator
      // clicks the model picker).
      let model: string | null = next.default_model;
      try {
        const list = await api.aiListModels(kind);
        if (!list.some((m) => m.id === model)) {
          model = list[0]?.id ?? model;
        }
      } catch {
        /* leave model as is — backend will accept empty and let the
           operator pick from the chip */
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
    // Close the model / provider / tools popovers — they were anchored
    // to the old session and their fetched lists are about to be stale.
    setModelPickerOpen(false);
    setProviderPickerOpen(false);
    setToolsOpen(false);
    setModels(null);
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
          providerLabel={
            meta?.provider_kind && aiSettings
              ? aiSettings.providers[meta.provider_kind]?.display_name ??
                meta.provider_kind
              : ""
          }
          mcp={view.mcp ?? null}
          onToggleSessions={onToggleSessions}
          sessionsOpen={sessionsOpen}
          onToggleTools={onToggleTools}
          toolsOpen={toolsOpen}
          onToggleModelPicker={onToggleModelPicker}
          modelPickerOpen={modelPickerOpen}
          onToggleProviderPicker={onToggleProviderPicker}
          providerPickerOpen={providerPickerOpen}
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
        {modelPickerOpen && meta?.provider_kind && (
          <ModelPickerPopover
            mode={mode}
            models={models}
            loading={modelsLoading}
            error={modelsError}
            currentModelId={meta.model}
            providerKind={meta.provider_kind as ProviderKind}
            providerLabel={
              aiSettings?.providers[meta.provider_kind]?.display_name ??
              meta.provider_kind
            }
            onPick={onPickModel}
            onRetry={() => fetchModelsForChat(true)}
            onOpenSettings={onOpenAiSettings}
            onClose={() => setModelPickerOpen(false)}
          />
        )}
        {providerPickerOpen && aiSettings && meta?.provider_kind && (
          <ProviderPickerPopover
            mode={mode}
            settings={aiSettings}
            currentProviderKind={meta.provider_kind as ProviderKind}
            onPick={onPickProvider}
            onOpenSettings={onOpenAiSettings}
            onClose={() => setProviderPickerOpen(false)}
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
                onClick={() =>
                  useAppStore.getState().openSettings({
                    section: "ai",
                    anchor: "providers",
                  })
                }
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
