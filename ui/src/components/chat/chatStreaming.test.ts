// Image attachments must survive the wire→view reconstruction so a reopened
// chat still shows the thumbnails the operator pasted, and so non-user roles
// never accidentally carry them.

import { describe, it, expect } from "vitest";
import { applyChatEvent, chatStateFromMessages } from "./chatStreaming";
import type { AgentChatMessage } from "../../types";

describe("chatStateFromMessages — image attachments", () => {
  it("carries user-message images through to the view message", () => {
    const msgs: AgentChatMessage[] = [
      {
        role: "user",
        content: "what is this?",
        images: [{ mime: "image/png", data: "AAAA" }],
      },
    ];
    const { messages } = chatStateFromMessages(msgs);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.images).toEqual([{ mime: "image/png", data: "AAAA" }]);
  });

  it("omits images for messages without attachments", () => {
    const msgs: AgentChatMessage[] = [{ role: "user", content: "plain" }];
    const { messages } = chatStateFromMessages(msgs);
    expect(messages[0]!.images).toBeUndefined();
  });

  it("does not attach images to non-user roles", () => {
    // Defensive: even if a stray assistant message arrived with images on the
    // wire, the view reconstruction must not surface them as a user-style grid.
    const msgs: AgentChatMessage[] = [
      {
        role: "assistant",
        content: "here",
        images: [{ mime: "image/png", data: "AAAA" }],
      },
    ];
    const { messages } = chatStateFromMessages(msgs);
    expect(messages[0]!.role).toBe("assistant");
    expect(messages[0]!.images).toBeUndefined();
  });
});

describe("applyChatEvent — retrying", () => {
  it("leaves the view state untouched (handled at the session level)", () => {
    // The `retrying` event drives the per-session RetryBubble in DockChat,
    // not the transcript view — the reducer must not materialise a bubble
    // or disturb an in-flight stream when it passes through applyChatEvent.
    const prev = chatStateFromMessages([
      { role: "user", content: "hi" },
    ]);
    const next = applyChatEvent(prev, {
      type: "retrying",
      attempt: 2,
      max: 5,
      reason: "rate limited",
      delay_ms: 4000,
    });
    expect(next).toBe(prev);
  });
});

describe("applyChatEvent — turn_state", () => {
  const withActivity = () => {
    let s = chatStateFromMessages([{ role: "user", content: "restart it" }]);
    s = applyChatEvent(s, { type: "turn_state", running: true });
    s = applyChatEvent(s, {
      type: "approval_request",
      tool_call_id: "t1",
      name: "fs_resources_apply",
      arguments: "{}",
    });
    s = applyChatEvent(s, {
      type: "tool_execution_start",
      tool_call_id: "t2",
      name: "fs_pods_exec",
    });
    return s;
  };

  it("marks the turn running, including while only tools are active", () => {
    const s = withActivity();
    expect(s.running).toBe(true);
    expect(s.messages.some((m) => m.streaming)).toBe(false);
  });

  it("retires running tools and pending approvals when the turn ends or is cancelled", () => {
    const s = applyChatEvent(withActivity(), { type: "turn_state", running: false });
    expect(s.running).toBe(false);
    expect(s.executing).toEqual([]);
    expect(s.pendingApprovals).toEqual([]);
  });

  it("closes a bubble still marked as streaming", () => {
    let s = applyChatEvent(chatStateFromMessages([]), { type: "assistant_start", message_id: "m1" });
    s = applyChatEvent(s, { type: "token_delta", delta: "partial" });
    s = applyChatEvent(s, { type: "turn_state", running: false });
    expect(s.messages[0]).toMatchObject({ content: "partial", streaming: false });
  });
});

describe("applyChatEvent — tool_execution_start", () => {
  it("drops the approval card for a call that is now running", () => {
    let s = applyChatEvent(chatStateFromMessages([]), {
      type: "approval_request",
      tool_call_id: "t1",
      name: "fs_resources_apply",
      arguments: "{}",
    });
    s = applyChatEvent(s, {
      type: "approval_request",
      tool_call_id: "t2",
      name: "fs_resources_delete",
      arguments: "{}",
    });
    s = applyChatEvent(s, {
      type: "tool_execution_start",
      tool_call_id: "t1",
      name: "fs_resources_apply",
    });
    expect(s.pendingApprovals.map((p) => p.toolCallId)).toEqual(["t2"]);
    expect(s.executing.map((e) => e.toolCallId)).toEqual(["t1"]);
  });
});

describe("applyChatEvent — compaction_completed", () => {
  const history: AgentChatMessage[] = [
    { role: "user", content: "old question" },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "latest question" },
  ];

  it("shows the checkpoint followed by the messages the backend kept", () => {
    const prev = chatStateFromMessages(history);
    const next = applyChatEvent(prev, {
      type: "compaction_completed",
      summary_chars: 1,
      summary: "S",
      tail: [{ role: "user", content: "latest question" }],
    });
    expect(next.messages.map((m) => m.content)).toEqual([
      "[context checkpoint]\nS",
      "latest question",
    ]);
    expect(next.messages[0]!.toolName).toBe("context_checkpoint");
  });

  it("keeps live state: the bubble being streamed, approvals, running tools, MCP status", () => {
    let prev = chatStateFromMessages(history);
    prev = applyChatEvent(prev, {
      type: "mcp_status",
      servers: [],
      native_tool_count: 7,
    });
    prev = applyChatEvent(prev, { type: "assistant_start", message_id: "live" });
    prev = applyChatEvent(prev, { type: "token_delta", delta: "thinking…" });
    prev = applyChatEvent(prev, {
      type: "approval_request",
      tool_call_id: "t1",
      name: "fs_resources_apply",
      arguments: "{}",
    });
    const next = applyChatEvent(prev, {
      type: "compaction_completed",
      summary_chars: 1,
      summary: "S",
      tail: [],
    });
    expect(next.messages.at(-1)).toMatchObject({ id: "live", content: "thinking…", streaming: true });
    expect(next.pendingApprovals).toHaveLength(1);
    expect(next.mcp?.nativeToolCount).toBe(7);
  });
});
