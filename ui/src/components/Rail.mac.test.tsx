import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act, fireEvent } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { useAppStore } from "../store";
import { MAC_VIBRANCY_ALPHA_DARK } from "../theme";
import { Rail, RAIL_HOVER_INTENT_MS } from "./Rail";

vi.mock("../lib/keyboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/keyboard")>()),
  IS_MAC: true,
}));

afterEach(() => {
  cleanup();
  resetMockInvoke();
  vi.useRealTimers();
});

const translucent = new RegExp(`^rgba\\(.*, ${MAC_VIBRANCY_ALPHA_DARK}\\)$`);

async function mountRail(railMode: "auto" | "pinned") {
  setMockInvoke((cmd) => (cmd === "list_resource_kinds" ? [] : undefined));
  act(() => useAppStore.setState({ railMode }));
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(<Rail mode="dark" />));
  });
  const panel = container.querySelector(".fs-rail-scroll")?.parentElement;
  const wrapper = panel?.parentElement;
  if (!panel || !wrapper) throw new Error("rail panel not found");
  return { panel, wrapper };
}

describe("Rail macOS vibrancy", () => {
  it("frosts the collapsed strip but goes opaque while floating over content", async () => {
    vi.useFakeTimers();
    const { panel, wrapper } = await mountRail("auto");
    expect(panel.style.backgroundColor).toMatch(translucent);

    fireEvent.mouseEnter(wrapper);
    act(() => vi.advanceTimersByTime(RAIL_HOVER_INTENT_MS));
    expect(panel.style.backgroundColor).toMatch(/^rgb\(/);
    expect(panel.style.transition).toContain("background-color 0s linear 0s");

    fireEvent.mouseLeave(wrapper);
    expect(panel.style.backgroundColor).toMatch(translucent);
    expect(panel.style.transition).toMatch(/background-color 0s linear 0?\.18s/);
  });

  it("keeps the pinned rail frosted: it never overlaps content", async () => {
    const { panel } = await mountRail("pinned");
    expect(panel.style.backgroundColor).toMatch(translucent);
  });
});
