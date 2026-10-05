// Deleting chats goes through the app's confirm modal (never window.confirm)
// and only acts once the operator agrees.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionsPopover } from "./SessionsPopover";
import { useAppStore } from "../../store";
import type { SessionMeta } from "../../types";

const session = (id: string, title: string): SessionMeta => ({
  id,
  cluster_id: "c1",
  title,
  created_at_unix_ms: Date.now(),
  updated_at_unix_ms: Date.now(),
  model: "m",
  approval_mode: "approve_per_write",
});

function renderPopover() {
  const handlers = {
    onPick: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onDeleteAll: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <SessionsPopover
      mode="dark"
      sessions={[session("s1", "Debug crashloop"), session("s2", "Scale web")]}
      currentSessionId="s1"
      liveStates={{}}
      busy={false}
      {...handlers}
    />,
  );
  return handlers;
}

const answer = async (ok: boolean) => {
  await act(async () => {
    useAppStore.getState().modals.at(-1)!.resolve(ok);
    await Promise.resolve();
  });
};

afterEach(() => {
  cleanup();
  useAppStore.setState({ modals: [] });
});

describe("SessionsPopover deleting", () => {
  it("asks first, with the chat's title, and deletes only after the operator agrees", async () => {
    const native = vi.spyOn(window, "confirm");
    const h = renderPopover();
    fireEvent.click(screen.getAllByTitle("Delete")[1]!);
    await act(async () => {});
    expect(h.onDelete).not.toHaveBeenCalled();
    const modal = useAppStore.getState().modals.at(-1)!;
    expect(modal.title).toContain("Scale web");
    expect(modal.tone).toBe("danger");
    await answer(true);
    expect(h.onDelete).toHaveBeenCalledExactlyOnceWith("s2");
    expect(native).not.toHaveBeenCalled();
  });

  it("does nothing when the operator cancels", async () => {
    const h = renderPopover();
    fireEvent.click(screen.getAllByTitle("Delete")[0]!);
    await act(async () => {});
    await answer(false);
    expect(h.onDelete).not.toHaveBeenCalled();
  });

  it("confirms 'Remove all' with the count, and cancelling keeps every chat", async () => {
    const h = renderPopover();
    fireEvent.click(screen.getByRole("button", { name: /Remove all/ }));
    await act(async () => {});
    expect(useAppStore.getState().modals.at(-1)!.title).toContain("2 chats");
    await answer(false);
    expect(h.onDeleteAll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Remove all/ }));
    await act(async () => {});
    await answer(true);
    expect(h.onDeleteAll).toHaveBeenCalledTimes(1);
  });
});
