import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Dialog } from "./Dialog";
import { tokens } from "../../theme";
import { useAppStore } from "../../store";

const t = tokens("light");
afterEach(() => {
  cleanup();
  useAppStore.setState({ modals: [] });
});

function renderDialog(props: Partial<Parameters<typeof Dialog>[0]> = {}) {
  const onClose = vi.fn();
  render(
    <Dialog t={t} title="Sync app" subtitle="argocd/app" onClose={onClose} footer={<button>Go</button>} {...props}>
      <p>body</p>
    </Dialog>,
  );
  return onClose;
}

describe("Dialog", () => {
  it("renders a labelled modal dialog with body and footer", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "Sync app" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("argocd/app")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go" })).toBeInTheDocument();
  });

  it("closes on Esc and the close button", () => {
    const onClose = renderDialog();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close (Esc)" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps Esc from reaching handlers behind it, focuses itself, and restores focus", () => {
    const outside = vi.fn();
    window.addEventListener("keydown", outside);
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const { unmount } = render(
      <Dialog t={t} title="Sync" onClose={onClose} footer={<button>Go</button>}>
        <input aria-label="rev" />
      </Dialog>,
    );
    expect(screen.getByRole("dialog")).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outside).not.toHaveBeenCalled();
    unmount();
    expect(opener).toHaveFocus();
    window.removeEventListener("keydown", outside);
    opener.remove();
  });

  it("traps Tab inside the dialog", () => {
    renderDialog();
    const go = screen.getByRole("button", { name: "Go" });
    go.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close (Esc)" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(go).toHaveFocus();
  });

  it("stays open while busy", () => {
    const onClose = renderDialog({ busy: true });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Close (Esc)" })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("leaves Esc to a confirm stacked on top", () => {
    const onClose = renderDialog();
    act(() =>
      useAppStore.setState({
        modals: [
          { id: "m", title: "Sure?", confirmLabel: "Yes", cancelLabel: "No", tone: "neutral", resolve: () => {} },
        ],
      }),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
