import type {
  AgentChatMessage,
  AgentToolCall,
  ChatEvent,
  McpServerStatusWire,
} from "../../types";

// View-shape message: lighter than the wire AgentChatMessage so React doesn't
// have to keep parsing tool_calls every render. The id keys the React list;
// the streaming partial accumulator lives here so a single state update
// owns the whole picture.
export type ChatViewMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  // Streaming flag — true while a TokenDelta stream is in flight. Cleared on
  // assistant_end / error. UI can render a blinking caret based on this.
  streaming?: boolean;
  toolCalls?: AgentToolCall[];
  // For tool-result messages.
  toolCallId?: string;
  toolName?: string;
  toolIsError?: boolean;
  // Pre-computed strip preview + line count for tool messages. Tool result
  // payloads can be tens of KB; computing these in the reducer means we
  // split the string once at message-creation time instead of on every
  // render of the collapsed strip.
  toolPreview?: string;
  toolLineCount?: number;
};

// Predicate for "this message will produce visible DOM in MessageBubble".
// Mirrors the early-return null branches in MessageBubble:
//  - settled assistant with no text content renders null (whether it has
//    tool_calls or not) — the matching ToolResultBubble below stands in,
//    or it's an EmptyTurn retry phantom we don't want to surface.
// MessageList filters by this before passing to the virtualizer so empty
// turns don't leave 12 px phantom rows between tool-result strips.
export function shouldRenderMessage(m: ChatViewMessage): boolean {
  if (m.role !== "assistant") return true;
  if (m.streaming) return true;
  return (m.content ?? "").trim().length > 0;
}

// Build the strip preview + line count from a tool result body. Only the
// first line is used for the preview, capped at 120 chars with an ellipsis
// so the strip stays single-row regardless of payload size.
function summarizeToolContent(content: string): {
  preview: string;
  lineCount: number;
} {
  if (!content) return { preview: "", lineCount: 0 };
  const firstNl = content.indexOf("\n");
  const firstLine = firstNl === -1 ? content : content.slice(0, firstNl);
  const preview =
    firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
  // `split` on a multi-KB string allocates an array of every line; counting
  // newlines walks the same bytes without the allocation.
  let lineCount = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lineCount++;
  }
  return { preview, lineCount };
}

// Tool catalogue snapshot for the live chat. Native tools are always
// counted; `servers` carries one entry per operator-configured MCP server
// with per-server availability + tool counts. The UI uses the most recent
// snapshot as authoritative — newer events overwrite older ones wholesale.
export type McpStatus = {
  nativeToolCount: number;
  servers: McpServerStatusWire[];
};

// Total tool count across native + every available MCP server. Cached
// here so the chat header pill doesn't re-derive it on every render.
export function totalToolCount(s: McpStatus | undefined): number {
  if (!s) return 0;
  return (
    s.nativeToolCount +
    s.servers.reduce((acc, sv) => acc + (sv.available ? sv.tool_count : 0), 0)
  );
}

// Pending operator approval — one entry per outstanding write tool call. The
// reducer adds entries on `approval_request` and removes them when the
// matching `tool_result` arrives (whether approved/denied/errored — the
// backend persists the decision and resolves the tool call either way).
export type PendingApproval = {
  toolCallId: string;
  name: string;
  arguments: string;
};

// Per-call execution marker — one entry per tool that has cleared approval
// and is currently running. Cleared by the matching tool_result event. Used
// to render a "running" strip while long tools (port-forward, ssh, http
// fetch) are in flight, so the operator sees activity instead of silence.
export type ExecutingToolCall = {
  toolCallId: string;
  name: string;
  startedAt: number;
};

export type ChatViewState = {
  messages: ChatViewMessage[];
  // Per-tool-call accumulator buffer for arguments. Keyed by tool call id;
  // promoted into a final ChatViewMessage entry on tool_call_end.
  toolBuffers: Record<string, { name: string; argsJson: string }>;
  mcp?: McpStatus;
  pendingApprovals: PendingApproval[];
  executing: ExecutingToolCall[];
};

export function chatStateFromMessages(
  msgs: AgentChatMessage[],
): ChatViewState {
  const messages: ChatViewMessage[] = msgs.flatMap((m, i) => {
    if (m.role === "system") return [];
    const role: "user" | "assistant" | "tool" =
      m.role === "tool" ? "tool" : (m.role as "user" | "assistant");
    const content = m.content ?? "";
    const summary = role === "tool" ? summarizeToolContent(content) : null;
    return [
      {
        id: `hist-${i}`,
        role,
        content,
        toolCalls: m.tool_calls,
        toolCallId: m.tool_call_id ?? undefined,
        toolName: m.name ?? undefined,
        toolPreview: summary?.preview,
        toolLineCount: summary?.lineCount,
      },
    ];
  });
  return { messages, toolBuffers: {}, pendingApprovals: [], executing: [] };
}

// Reducer for a single ChatEvent. Pure function — no fetches, no IO. Lets
// DockChat keep streaming state in `useState` without resorting to refs.
export function applyChatEvent(
  prev: ChatViewState,
  evt: ChatEvent,
): ChatViewState {
  switch (evt.type) {
    case "assistant_start": {
      return {
        ...prev,
        messages: [
          ...prev.messages,
          {
            id: evt.message_id,
            role: "assistant",
            content: "",
            streaming: true,
          },
        ],
      };
    }
    case "token_delta": {
      // Append to the last assistant message that's currently streaming.
      const messages = prev.messages.slice();
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role === "assistant" && m.streaming) {
          messages[i] = { ...m, content: m.content + evt.delta };
          break;
        }
      }
      return { ...prev, messages };
    }
    case "tool_call_start": {
      return {
        ...prev,
        toolBuffers: {
          ...prev.toolBuffers,
          [evt.id]: { name: evt.name, argsJson: "" },
        },
      };
    }
    case "tool_call_args_delta": {
      const cur = prev.toolBuffers[evt.id];
      if (!cur) return prev;
      return {
        ...prev,
        toolBuffers: {
          ...prev.toolBuffers,
          [evt.id]: { ...cur, argsJson: cur.argsJson + evt.json_delta },
        },
      };
    }
    case "tool_call_end": {
      // Promote the buffer into a tool_calls entry on the in-flight assistant.
      // M1 doesn't actually run tools, but the wire shape supports it.
      const buf = prev.toolBuffers[evt.id];
      const messages = prev.messages.slice();
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role === "assistant" && m.streaming) {
          const newCalls = (m.toolCalls ?? []).concat(
            buf
              ? [
                  {
                    id: evt.id,
                    name: buf.name,
                    arguments: buf.argsJson,
                  } satisfies AgentToolCall,
                ]
              : [],
          );
          messages[i] = { ...m, toolCalls: newCalls };
          break;
        }
      }
      const nextBufs = { ...prev.toolBuffers };
      delete nextBufs[evt.id];
      return { ...prev, messages, toolBuffers: nextBufs };
    }
    case "assistant_end": {
      const messages = prev.messages.map((m) =>
        m.id === evt.message_id ? { ...m, streaming: false } : m,
      );
      return { ...prev, messages };
    }
    case "error": {
      // Errors render as a synthetic assistant message tagged streaming:false
      // and styled distinctly. Keeps history visible even after a failure.
      const messages = prev.messages.slice();
      // Mark the in-flight assistant message as not-streaming so the UI
      // stops blinking.
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.role === "assistant" && m.streaming) {
          messages[i] = { ...m, streaming: false };
          break;
        }
      }
      messages.push({
        id: `err-${Date.now()}`,
        role: "assistant",
        content: `error: ${evt.message}`,
        streaming: false,
      });
      return { ...prev, messages };
    }
    case "tool_execution_start": {
      // Don't double-add if the same id arrives twice (shouldn't, but cheap
      // guard — keeps the strip stable if the backend ever retries).
      if (prev.executing.some((e) => e.toolCallId === evt.tool_call_id)) {
        return prev;
      }
      return {
        ...prev,
        executing: [
          ...prev.executing,
          {
            toolCallId: evt.tool_call_id,
            name: evt.name,
            startedAt: Date.now(),
          },
        ],
      };
    }
    case "tool_result": {
      // Append a synthetic "tool" view message carrying the result. The
      // backend already persisted the tool message; this entry is the UI
      // mirror so operators see what actually came back from MCP.
      const messages = prev.messages.slice();
      const summary = summarizeToolContent(evt.content);
      messages.push({
        id: `tool-${evt.tool_call_id}`,
        role: "tool",
        content: evt.content,
        toolCallId: evt.tool_call_id,
        toolName: evt.name,
        toolIsError: evt.is_error,
        toolPreview: summary.preview,
        toolLineCount: summary.lineCount,
      });
      // Clear any pending approval for this tool call (the backend already
      // resolved it — denied calls also surface as a tool_result so this
      // single removal covers all paths).
      const pendingApprovals = prev.pendingApprovals.filter(
        (p) => p.toolCallId !== evt.tool_call_id,
      );
      // Retire the matching "running" strip entry. Denied calls bypass
      // tool_execution_start entirely so this filter is a no-op for them.
      const executing = prev.executing.filter(
        (e) => e.toolCallId !== evt.tool_call_id,
      );
      return { ...prev, messages, pendingApprovals, executing };
    }
    case "approval_request": {
      // Don't double-add if the same id arrives twice for any reason.
      if (
        prev.pendingApprovals.some((p) => p.toolCallId === evt.tool_call_id)
      ) {
        return prev;
      }
      return {
        ...prev,
        pendingApprovals: [
          ...prev.pendingApprovals,
          {
            toolCallId: evt.tool_call_id,
            name: evt.name,
            arguments: evt.arguments,
          },
        ],
      };
    }
    case "mcp_status": {
      return {
        ...prev,
        mcp: {
          nativeToolCount: evt.native_tool_count,
          servers: evt.servers,
        },
      };
    }
    case "usage":
      // Token-usage display is a follow-up affordance; ignored in M1.
      return prev;
    case "compaction_started":
      // DockChat surfaces the in-flight pill; no transcript change.
      return prev;
    case "compaction_completed": {
      // Backend rewrote its in-memory transcript: the head was folded
      // into a single `[context checkpoint]` assistant message.
      // Mirror that on the UI side by replacing all bubbles with the
      // checkpoint. Streaming buffers and pending approvals get
      // cleared too — the head they referred to no longer exists.
      return {
        messages: [
          {
            id: `compact-${Date.now()}`,
            role: "assistant",
            content: `[context checkpoint]\n${evt.summary}`,
            toolName: "context_checkpoint",
          },
        ],
        toolBuffers: {},
        pendingApprovals: [],
        executing: [],
        mcp: prev.mcp,
      };
    }
    default:
      return prev;
  }
}
