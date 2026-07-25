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
