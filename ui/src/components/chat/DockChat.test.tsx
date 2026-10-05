// DockChat at tab level: how a failed send, a turn that is busy without a
// streaming bubble, and a chat waiting on a provider behave. The backend is
// mocked; events are pushed through the captured channel callback.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DockChat } from "./DockChat";
import { useAppStore } from "../../store";
import type { ChatEvent, SessionMeta } from "../../types";
import type { DockTab } from "../../store";

const api = vi.hoisted(() => ({
  aiGetSettings: vi.fn(),
  aiListModels: vi.fn(),
  aiSetSettings: vi.fn(),
  chatListSessions: vi.fn(),
  chatLoadSession: vi.fn(),
  chatCreateSession: vi.fn(),
  chatOpen: vi.fn(),
  chatClose: vi.fn(),
  chatRefreshStatus: vi.fn(),
  chatSendMessage: vi.fn(),
  chatCancelStreaming: vi.fn(),
  chatSetModel: vi.fn(),
  readClipboardImage: vi.fn(),
}));
vi.mock("../../api", () => ({ api }));

let emit: (evt: ChatEvent) => void = () => {};

const META: SessionMeta = {
  id: "s1",
  cluster_id: "c1",
  title: "New chat",
  created_at_unix_ms: 1,
  updated_at_unix_ms: 2,
  provider_kind: "anthropic",
  model: "claude-x",
  approval_mode: "approve_per_write",
};

function settings(configured: boolean) {
  return {
    active_provider: "anthropic",
    provider_order: ["anthropic"],
    default_model: "claude-x",
    providers: {
      anthropic: {
        kind: "anthropic",
        display_name: "Anthropic",
        enabled: true,
        configured,
      },
    },
  };
}

const TAB: DockTab = {
  id: "chat-1",
  kind: "chat",
  title: "chat@c1",
  placement: "right",
  state: { clusterId: "c1", contextLabel: "c1", sessionId: "s1", chatId: null },
};

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.aiGetSettings.mockResolvedValue(settings(true));
  api.aiListModels.mockResolvedValue([]);
  api.chatListSessions.mockResolvedValue([META]);
  api.chatLoadSession.mockResolvedValue({ meta: META, events: [] });
  api.chatRefreshStatus.mockResolvedValue(undefined);
  api.chatClose.mockResolvedValue(undefined);
  api.chatOpen.mockImplementation(async (_sid: string, onEvent: (e: ChatEvent) => void) => {
    emit = onEvent;
    return {
      chatId: "chat-live",
      initialMcp: { nativeToolCount: 3, servers: [] },
      contextLimit: 0,
      usableContext: 0,
      close: () => {},
    };
  });
  useAppStore.setState({ settingsOpen: false });
});

afterEach(() => {
  cleanup();
});

async function renderChat() {
  render(<DockChat mode="dark" tab={TAB} visible />);
  await screen.findByRole("textbox");
  await waitFor(() => expect(screen.getByRole("textbox")).not.toBeDisabled());
}

const send = (text: string) => {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
};

const push = async (evt: ChatEvent) => {
  await act(async () => {
    emit(evt);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  });
};

describe("DockChat failed send", () => {
  it("says why in a banner, keeps the chat usable and gives the text back", async () => {
    await renderChat();
    api.chatSendMessage.mockRejectedValue("no credential configured for this provider");
    send("scale web to 5");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Message not sent");
    expect(alert).toHaveTextContent("no credential configured");
    // Not the full-screen failure: the composer is live and holds the draft.
    expect(screen.getByRole("textbox")).not.toBeDisabled();
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("scale web to 5"));
    expect(screen.queryByText("scale web to 5", { selector: "div,span,p" })).toBeNull();
  });

  it("clears the banner when dismissed and on the next successful send", async () => {
    await renderChat();
    api.chatSendMessage.mockRejectedValueOnce("boom");
    send("first");
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("alert")).toBeNull();

    api.chatSendMessage.mockRejectedValueOnce("boom again");
    send("second");
    await screen.findByRole("alert");
    api.chatSendMessage.mockResolvedValueOnce(undefined);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "third" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("DockChat busy turn", () => {
  it("offers Stop while a tool runs with no assistant bubble open, and drops it when the turn ends", async () => {
    await renderChat();
    expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();

    await push({ type: "turn_state", running: true });
    await push({ type: "tool_execution_start", tool_call_id: "t1", name: "fs_pods_exec" });
    expect(screen.getByRole("button", { name: "Stop the agent" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop the agent" }));
    expect(api.chatCancelStreaming).toHaveBeenCalledWith("chat-live");

    await push({ type: "turn_state", running: false });
    expect(screen.queryByRole("button", { name: "Stop the agent" })).toBeNull();
  });
});

describe("DockChat waiting for a provider", () => {
  it("opens once the operator has connected one and closed Settings", async () => {
    api.aiGetSettings.mockResolvedValue(settings(false));
    render(<DockChat mode="dark" tab={TAB} visible />);
    await screen.findByText(/no provider connected yet/);
    expect(api.chatOpen).not.toHaveBeenCalled();

    api.aiGetSettings.mockResolvedValue(settings(true));
    act(() => useAppStore.setState({ settingsOpen: true }));
    act(() => useAppStore.setState({ settingsOpen: false }));

    await waitFor(() => expect(screen.getByRole("textbox")).not.toBeDisabled());
    expect(api.chatOpen).toHaveBeenCalledTimes(1);
  });
});

describe("DockChat failing to open", () => {
  it("offers Retry, which tries again", async () => {
    api.aiGetSettings.mockRejectedValueOnce("settings unreadable");
    render(<DockChat mode="dark" tab={TAB} visible />);
    await screen.findByText(/settings unreadable/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("textbox")).not.toBeDisabled());
    expect(api.chatOpen).toHaveBeenCalledTimes(1);
  });
});

describe("DockChat opening a session twice", () => {
  it("opens one backend chat when the same session is requested again mid-open", async () => {
    let finishLoad!: () => void;
    const slowLoad = new Promise<void>((r) => (finishLoad = r));
    api.chatLoadSession.mockImplementation(async (id: string) => {
      if (id === "s1") await slowLoad;
      return { meta: { ...META, id }, events: [] };
    });
    const tabFor = (sessionId: string): DockTab => ({
      ...TAB,
      state: { ...TAB.state, sessionId },
    });
    const { rerender } = render(<DockChat mode="dark" tab={tabFor("s1")} visible />);
    await waitFor(() => expect(api.chatLoadSession).toHaveBeenCalledWith("s1"));
    // Away to another session and back while the first open is still loading.
    rerender(<DockChat mode="dark" tab={tabFor("s2")} visible />);
    await waitFor(() => expect(api.chatOpen).toHaveBeenCalledWith("s2", expect.any(Function)));
    rerender(<DockChat mode="dark" tab={tabFor("s1")} visible />);
    await act(async () => {
      finishLoad();
      await slowLoad;
    });
    await waitFor(() => expect(screen.getByRole("textbox")).not.toBeDisabled());
    const opened = api.chatOpen.mock.calls.map((c) => c[0] as string);
    expect(opened.filter((id) => id === "s1")).toHaveLength(1);
  });
});
