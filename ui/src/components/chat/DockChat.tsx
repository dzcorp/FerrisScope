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
import { SessionsPopover, type SessionLiveState } from "./SessionsPopover";
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

/// Per-session live runtime state. One entry per session opened in this
/// tab; non-active entries keep streaming in the background, accumulating
/// view / usage / streaming flags so the operator sees the result when
/// they switch back. Backend chat is closed only on tab unmount or
/// explicit session deletion — switching sessions inside the tab is
/// purely a render-time key change.
type OpenChat = {
  chatId: string;
  meta: SessionMeta;
  view: ChatViewState;
  streaming: boolean;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  compacting: number | null;
};

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
  // Per-session live state, keyed by sessionId. Background sessions
  // remain in the map and keep streaming; the active session is just
  // `openChats[activeSessionId]`. Cleared only on tab unmount or
  // explicit session deletion.
  const [openChats, setOpenChats] = useState<Record<string, OpenChat>>({});
  // Imperative plumbing per session — kept out of state so we don't
  // re-render the world when we mutate the rAF id or push to the queue.
  // Backend events fire one-per-token during streaming; we coalesce
  // through requestAnimationFrame so we render at most once per paint
  // (~60fps) instead of once per token. Without this, parseBlocks runs
  // against the streaming bubble's growing text on every token =
  // O(n²) cumulative parse work over a long response.
  const chatChannels = useRef<
    Map<string, {
      chatId: string;
      close: () => void;
      pendingEvents: ChatEvent[];
      raf: number | null;
    }>
  >(new Map());
  // Mirror of `openChats` kept as a ref so the unmount cleanup effect
  // can read the latest map without re-running on every change.
  const openChatsLatest = useRef<Record<string, OpenChat>>({});
  useEffect(() => {
    openChatsLatest.current = openChats;
  }, [openChats]);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionBusy, setSessionBusy] = useState(false);
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

  // Active session derivations. Render reads from these; null when no
  // session is open yet (initial bring-up, or every session deleted).
  const activeSessionId = tabState.sessionId ?? null;
  const active: OpenChat | null = activeSessionId
    ? openChats[activeSessionId] ?? null
    : null;

  // Per-session live state for the SessionsPopover dots. Only includes
  // sessions currently open in this tab — flat sessions (closed,
  // disk-only) get no dot.
  const liveStates = useMemo(() => {
    const m: Record<string, SessionLiveState> = {};
    for (const [sid, oc] of Object.entries(openChats)) {
      m[sid] = {
        streaming: oc.streaming,
        pendingApprovals: oc.view.pendingApprovals.length,
      };
    }
    return m;
  }, [openChats]);
  const meta = active?.meta ?? null;
  const view = active?.view ?? chatStateFromMessages([]);
  const streaming = active?.streaming ?? false;
  const usage = active?.usage ?? null;
  const compacting = active?.compacting ?? null;
  const activeChatId = active?.chatId ?? null;

  // Per-session event flusher. Bound to a sessionId so events for
  // background sessions still drain into their own slot in the map
  // instead of leaking onto the active session's view. Folds every
  // queued event into one `setOpenChats` per frame so the transcript
  // re-renders at most once per paint regardless of token rate.
  const flushEventsForSession = (sessionId: string) => {
    const refs = chatChannels.current.get(sessionId);
    if (!refs) return;
    refs.raf = null;
    const queue = refs.pendingEvents;
    if (queue.length === 0) return;
    refs.pendingEvents = [];
    setOpenChats((prev) => {
      const cur = prev[sessionId];
      if (!cur) return prev;
      let nextView = cur.view;
      let nextStreaming = cur.streaming;
      let nextUsage = cur.usage;
      let nextCompacting = cur.compacting;
      let nextMeta = cur.meta;
      for (const e of queue) {
        nextView = applyChatEvent(nextView, e);
        if (e.type === "assistant_start") nextStreaming = true;
        else if (e.type === "assistant_end" || e.type === "error") {
          nextStreaming = false;
        } else if (e.type === "usage") {
          nextUsage = {
            promptTokens: e.prompt_tokens,
            completionTokens: e.completion_tokens,
            totalTokens: e.total_tokens,
          };
        } else if (e.type === "compaction_started") {
          nextCompacting = e.tokens_before;
        } else if (e.type === "compaction_completed") {
          nextCompacting = null;
          // Backend zeroes last_total_tokens on compaction; mirror it
          // on the chip so the running count matches what the index
          // will report on next reopen.
          nextUsage = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          };
        } else if (e.type === "title_updated") {
          nextMeta = { ...nextMeta, title: e.title };
        }
      }
      return {
        ...prev,
        [sessionId]: {
          ...cur,
          view: nextView,
          streaming: nextStreaming,
          usage: nextUsage,
          compacting: nextCompacting,
          meta: nextMeta,
        },
      };
    });
    // Mirror title_updated into the popover's session list so the row
    // text refreshes even while the operator is on a different session.
    for (const e of queue) {
      if (e.type === "title_updated") {
        const t = e.title;
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, title: t } : s)),
        );
      }
    }
  };

  // Bring-up: open whichever session the tab is pointed at, IF it's not
  // already open. Re-runs when `tabState.sessionId` changes (operator
  // switches session via the popover). Critically, the cleanup does NOT
  // close the previous chat — non-active sessions stay alive in
  // `chatChannels` and keep streaming events into their map slot. The
  // tab-unmount effect below is the only place that actually tears
  // chats down.
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
        const activeProvider = settings.providers[settings.active_provider];
        if (!activeProvider?.configured) {
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
        // No persisted session on this tab — open the most recent one
        // for this cluster instead of immediately minting a fresh chat.
        // The operator picks "New chat" from the sessions popover when
        // they actually want a clean slate; auto-creating on every
        // open litters the disk with empty sessions.
        if (!sessionId) {
          try {
            const existing = await api.chatListSessions(clusterId);
            if (existing.length > 0) {
              const latest = [...existing].sort(
                (a, b) => b.updated_at_unix_ms - a.updated_at_unix_ms,
              )[0]!;
              sessionId = latest.id;
              if (!cancelled) patchTabState(tab.id, { sessionId });
            }
          } catch {
            /* listing failed — fall through to the create path */
          }
        }
        // Already open in this tab: just signal ready and reuse the
        // existing entry. No backend chat_open, no view reset — the
        // operator's previous turn (if any) has been streaming into
        // the slot the whole time they were on a different session.
        if (sessionId && chatChannels.current.has(sessionId)) {
          if (!cancelled) {
            const existing = openChatsLatest.current[sessionId];
            if (existing) {
              patchTabState(tab.id, { chatId: existing.chatId });
            }
            setStatus({ kind: "ready" });
          }
          return;
        }
        // Resolve the default model up front — both the load-fallback
        // and the fresh-create path want it, and the API call may be slow.
        const pickModel = async (): Promise<string | null> => {
          let model: string | null = settings.default_model;
          if (!model) {
            try {
              const list = await api.aiListModels();
              model = list[0]?.id ?? null;
            } catch {
              /* empty list / network — leave null, let backend default */
            }
          }
          return model;
        };
        let sessionMeta: SessionMeta;
        let initialView: ChatViewState;
        if (sessionId) {
          // Load can fail when the persisted id points at a session
          // that's been deleted (another tab nuked it, the JSONL was
          // hand-removed, or the index is stale). Don't surface that
          // as a hard error — mint a fresh session and carry on.
          try {
            const data = await api.chatLoadSession(sessionId);
            sessionMeta = data.meta;
            const msgs = data.events.flatMap((e): AgentChatMessage[] =>
              e.kind === "message" ? [e.message] : [],
            );
            initialView = chatStateFromMessages(msgs);
          } catch (err) {
            console.warn("chatLoadSession failed; minting fresh", err);
            sessionMeta = await api.chatCreateSession(
              clusterId,
              await pickModel(),
            );
            sessionId = sessionMeta.id;
            if (!cancelled) patchTabState(tab.id, { sessionId });
            initialView = chatStateFromMessages([]);
          }
        } else {
          // First time on this cluster — mint a session so the chat
          // has somewhere to write.
          sessionMeta = await api.chatCreateSession(
            clusterId,
            await pickModel(),
          );
          sessionId = sessionMeta.id;
          if (!cancelled) patchTabState(tab.id, { sessionId });
          initialView = chatStateFromMessages([]);
        }
        const resolvedSessionId = sessionId;
        // Register the channel slot BEFORE chat_open so events emitted
        // during/just-after the IPC return have a buffer to land in.
        // chatId is filled in once chat_open resolves; before that the
        // close handle is a no-op.
        chatChannels.current.set(resolvedSessionId, {
          chatId: "",
          close: () => {},
          pendingEvents: [],
          raf: null,
        });
        let opened;
        try {
          opened = await api.chatOpen(resolvedSessionId, (evt: ChatEvent) => {
            const refs = chatChannels.current.get(resolvedSessionId);
            if (!refs) return;
            refs.pendingEvents.push(evt);
            if (refs.raf === null) {
              refs.raf = requestAnimationFrame(() =>
                flushEventsForSession(resolvedSessionId),
              );
            }
          });
        } catch (e) {
          chatChannels.current.delete(resolvedSessionId);
          throw e;
        }
        const entry = chatChannels.current.get(resolvedSessionId);
        if (entry) {
          entry.chatId = opened.chatId;
          entry.close = opened.close;
        }
        const seededView: ChatViewState = {
          ...initialView,
          // Seed `view.mcp` from the in-band snapshot so the header
          // chip turns green immediately. Streamed `mcp_status` events
          // (initial emit + per-server updates) overwrite this with
          // fresher values — the reducer wholesale-replaces `mcp` from
          // each event, so duplicates are harmless.
          mcp: {
            nativeToolCount: opened.initialMcp.nativeToolCount,
            servers: opened.initialMcp.servers,
          },
        };
        // Seed the token-usage chip from the persisted meta so the
        // operator sees the running count immediately on reopen. The
        // index only carries `total_tokens`; we don't have the
        // prompt/completion split for prior turns, so show 0 — the
        // running total is what matters for compaction.
        const seededUsage =
          typeof sessionMeta.last_total_tokens === "number" &&
          sessionMeta.last_total_tokens > 0
            ? {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: sessionMeta.last_total_tokens,
              }
            : null;
        // Always populate the map, even if `cancelled` (the operator
        // switched sessions while we were opening this one). Keeping
        // the just-opened session as a background entry is the whole
        // point of the multi-session model — they can come back.
        // Tab unmount is handled by the dedicated cleanup effect,
        // which walks `chatChannels` directly so this entry can't leak.
        setOpenChats((prev) => ({
          ...prev,
          [resolvedSessionId]: {
            chatId: opened.chatId,
            meta: sessionMeta,
            view: seededView,
            streaming: false,
            usage: seededUsage,
            compacting: null,
          },
        }));
        if (!cancelled) {
          patchTabState(tab.id, { chatId: opened.chatId });
          setStatus({ kind: "ready" });
        }
        // Belt-and-braces: re-request the MCP status snapshot after
        // the JS-side state is fully wired. The backend already emits
        // one during `chat_open`, but events sent during the same
        // Tauri invoke can race with the channel handler / RAF flush;
        // re-emitting is idempotent and cheap.
        api.chatRefreshStatus(opened.chatId).catch(() => {});
      } catch (e) {
        if (cancelled) return;
        setStatus({ kind: "error", message: String(e) });
      }
    })();
    return () => {
      cancelled = true;
      // Deliberately no chat_close here. Switching sessions inside
      // the tab leaves the previous session running in the background;
      // tab unmount is the only path that tears chats down.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, tab.id, tabState.sessionId]);

  // Tab-unmount cleanup. Walks `chatChannels.current` (mutated
  // synchronously when a session opens, so it's the source of truth
  // for "chats this tab has registered") and tears down every entry.
  // Empty deps so this fires only on real unmount, not on session
  // switches.
  useEffect(() => {
    return () => {
      for (const [, refs] of chatChannels.current.entries()) {
        if (refs.raf !== null) cancelAnimationFrame(refs.raf);
        refs.close();
        if (refs.chatId) api.chatClose(refs.chatId).catch(() => {});
      }
      chatChannels.current.clear();
    };
  }, []);

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
    if (!activeChatId) return;
    api.chatRefreshStatus(activeChatId).catch(() => {});
  }, [visible, settingsOpen, activeChatId]);

  // The model catalogue cache is bound to a provider, not a session.
  // Different sessions in the same tab can be on different providers,
  // so drop the cache whenever the active session changes — the next
  // ModelPickerPopover open will refetch for whatever provider this
  // session uses.
  useEffect(() => {
    setModels(null);
  }, [activeSessionId]);

  const onSend = async (text: string) => {
    if (!activeChatId || !activeSessionId) return;
    if (!text.trim()) return;
    const sid = activeSessionId;
    // Optimistic append so the user's bubble appears immediately,
    // before the backend's first AssistantStart fires. The backend
    // persists the user message itself; the optimistic add is purely
    // for perceived latency.
    setOpenChats((prev) => {
      const cur = prev[sid];
      if (!cur) return prev;
      return {
        ...prev,
        [sid]: {
          ...cur,
          view: {
            ...cur.view,
            messages: [
              ...cur.view.messages,
              {
                id: `local-${Date.now()}`,
                role: "user",
                content: text,
              } satisfies ChatViewMessage,
            ],
          },
        },
      };
    });
    try {
      await api.chatSendMessage(activeChatId, text);
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  };

  const onCancel = async () => {
    if (!activeChatId) return;
    try {
      await api.chatCancelStreaming(activeChatId);
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
        if (!activeChatId) return next;
        setToolsLoading(true);
        setToolsError(null);
        api
          .chatListTools(activeChatId)
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
    if (!activeChatId || !activeSessionId) return;
    if (modelId === meta?.model) {
      setModelPickerOpen(false);
      return;
    }
    // Optimistic header update — the API call is fire-and-forget from
    // the user's perspective. On failure we surface in the error
    // overlay just like other chat-mutating actions.
    const sid = activeSessionId;
    setOpenChats((prev) => {
      const cur = prev[sid];
      if (!cur) return prev;
      return { ...prev, [sid]: { ...cur, meta: { ...cur.meta, model: modelId } } };
    });
    setModelPickerOpen(false);
    try {
      await api.chatSetModel(activeChatId, modelId);
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

  // Switch the tab's render to a different session WITHOUT tearing
  // down the current one. The bring-up effect notices `tabState.sessionId`
  // changed and either reuses an existing entry in the map (instant)
  // or runs the open flow for a not-yet-opened session. The previous
  // session keeps streaming in the background, accumulating events
  // into its own slot — switch back and the operator sees the result.
  const switchToSession = (sessionId: string) => {
    if (sessionId === tabState.sessionId) {
      setSessionsOpen(false);
      return;
    }
    patchTabState(tab.id, { sessionId, chatId: null });
    setSessionsOpen(false);
    // Close popovers anchored to the old session — their fetched lists
    // (models for the prior provider, tools for the prior chat) are
    // about to be stale.
    setModelPickerOpen(false);
    setProviderPickerOpen(false);
    setToolsOpen(false);
    setModels(null);
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
      // Update the live entry's meta if this session is currently open
      // in the tab — covers both the active session and any background
      // session the operator might be holding open.
      setOpenChats((prev) => {
        const cur = prev[sessionId];
        if (!cur) return prev;
        return { ...prev, [sessionId]: { ...cur, meta: { ...cur.meta, title } } };
      });
    } catch {
      /* surface as error? — for now silent */
    } finally {
      setSessionBusy(false);
    }
  };

  // Tear down a live chat for one session and drop it from the map.
  // Called by both single- and bulk-delete paths so the channel and
  // backend chat get released alongside the JSONL file.
  const evictOpenChat = (sessionId: string) => {
    const refs = chatChannels.current.get(sessionId);
    if (refs) {
      if (refs.raf !== null) cancelAnimationFrame(refs.raf);
      refs.close();
      if (refs.chatId) api.chatClose(refs.chatId).catch(() => {});
      chatChannels.current.delete(sessionId);
    }
    setOpenChats((prev) => {
      if (!prev[sessionId]) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
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
        evictOpenChat(s.id);
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
      evictOpenChat(sessionId);
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
            liveStates={liveStates}
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
            chatId={activeChatId}
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
          if (!activeChatId || !activeSessionId) return;
          api.chatSetApprovalMode(activeChatId, am).catch(() => {});
          const sid = activeSessionId;
          setOpenChats((prev) => {
            const cur = prev[sid];
            if (!cur) return prev;
            return {
              ...prev,
              [sid]: { ...cur, meta: { ...cur.meta, approval_mode: am } },
            };
          });
        }}
        usage={usage}
        onCompact={
          status.kind === "ready"
            ? () => {
                if (!activeChatId || !activeSessionId) return;
                const sid = activeSessionId;
                setOpenChats((prev) => {
                  const cur = prev[sid];
                  if (!cur) return prev;
                  return { ...prev, [sid]: { ...cur, compacting: 0 } };
                });
                api.chatCompact(activeChatId).catch(() => {
                  setOpenChats((prev) => {
                    const cur = prev[sid];
                    if (!cur) return prev;
                    return { ...prev, [sid]: { ...cur, compacting: null } };
                  });
                });
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
