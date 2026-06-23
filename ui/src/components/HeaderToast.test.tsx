// HeaderToast routing: a routed toast (the "update available" notice) must
// deep-link to its Settings target and dismiss itself; every other toast keeps
// the original behaviour of opening the notifications panel.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { HeaderToast } from "./HeaderToast";
import { useAppStore } from "../store";
import type { Toast } from "../store";

function seed(toast: Toast) {
  useAppStore.setState({
    toasts: [toast],
    settingsOpen: false,
    settingsTarget: null,
    notificationsOpen: false,
  });
}

afterEach(cleanup);

describe("HeaderToast routing", () => {
  it("routed toast click opens Settings at the target and dismisses the toast", () => {
    seed({
      id: "u",
      tone: "info",
      text: "update available",
      durationMs: 0,
      route: { section: "about", anchor: "about-whatsnew" },
    });
    render(<HeaderToast mode="dark" />);

    fireEvent.click(screen.getByText("update available").closest("button")!);

    const s = useAppStore.getState();
    expect(s.settingsOpen).toBe(true);
    expect(s.settingsTarget).toEqual({ section: "about", anchor: "about-whatsnew" });
    expect(s.notificationsOpen).toBe(false);
    // Dismissed so it doesn't linger over the destination.
    expect(s.toasts).toHaveLength(0);
  });

  it("plain toast click opens the notifications panel", () => {
    seed({ id: "p", tone: "info", text: "something happened", durationMs: 0 });
    render(<HeaderToast mode="dark" />);

    fireEvent.click(screen.getByText("something happened").closest("button")!);

    const s = useAppStore.getState();
    expect(s.notificationsOpen).toBe(true);
    expect(s.settingsOpen).toBe(false);
  });
});
