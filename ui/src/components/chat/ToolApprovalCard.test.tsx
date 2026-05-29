import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { ToolApprovalCard } from "./ToolApprovalCard";
import type { PendingApproval } from "./chatStreaming";

// chatApproveToolCall hits the Tauri bridge; stub the api module so decide()
// doesn't try to invoke a real command.
const approveMock = vi.fn(
  (_chatId: string, _toolCallId: string, _decision: string): Promise<void> =>
    Promise.resolve(),
);
vi.mock("../../api", () => ({
  api: {
    chatApproveToolCall: (chatId: string, toolCallId: string, decision: string) =>
      approveMock(chatId, toolCallId, decision),
  },
}));

const approval: PendingApproval = {
  toolCallId: "tc-1",
  name: "fs_resources_delete",
  arguments: '{"kind":"Pod","name":"web-0"}',
};

afterEach(() => {
  cleanup();
  approveMock.mockClear();
});

describe("ToolApprovalCard — approve-always scope", () => {
  it("spells out that 'Approve always' covers every future call of this tool", () => {
    const { getByTestId } = render(
      <ToolApprovalCard mode="dark" chatId="chat-1" approval={approval} />,
    );
    const scope = getByTestId("approve-always-scope");
    // The always-visible scope hint must name the specific tool and make clear
    // it's not a one-shot grant — this is the privilege-escalation footgun
    // being surfaced (the `Btn` title= adds the same text as a hover tooltip).
    expect(scope.textContent).toContain("fs_resources_delete");
    expect(scope.textContent).toMatch(/every future call/i);
  });

  it("sends approved_always when the button is clicked", () => {
    const { getByText } = render(
      <ToolApprovalCard mode="dark" chatId="chat-1" approval={approval} />,
    );
    fireEvent.click(getByText("Approve always"));
    expect(approveMock).toHaveBeenCalledWith("chat-1", "tc-1", "approved_always");
  });
});
