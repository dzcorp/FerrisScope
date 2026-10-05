import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProviderEnableDialog } from "./ProviderEnableDialog";
import { tokens } from "../../theme";
import { useAppStore } from "../../store";
import type { EnableNotice } from "../../types";

const t = tokens("light");
const notice: EnableNotice = {
  headline: "Enable OpenCode Zen free tier?",
  points: ["Free: no account or API key.", "Your prompts leave your machine."],
  learn_more_url: "https://opencode.ai/docs/zen#privacy",
};

afterEach(() => {
  cleanup();
  useAppStore.setState({ modals: [] });
});

function renderDialog(busy = false) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ProviderEnableDialog
      t={t}
      providerName="OpenCode Zen"
      notice={notice}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  return { onCancel, onConfirm };
}

describe("ProviderEnableDialog", () => {
  it("shows the headline, every disclosure point and a privacy link", () => {
    renderDialog();
    expect(
      screen.getByRole("dialog", { name: notice.headline }),
    ).toBeInTheDocument();
    for (const point of notice.points) {
      expect(screen.getByText(point)).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "Privacy details" })).toHaveAttribute(
      "href",
      notice.learn_more_url,
    );
  });

  it("confirms only through the Enable button", () => {
    const { onCancel, onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels via the button and Esc without confirming", () => {
    const { onCancel, onConfirm } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("locks both actions and Esc while the enable request is in flight", () => {
    const { onCancel, onConfirm } = renderDialog(true);
    expect(screen.getByRole("button", { name: "Enabling…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
