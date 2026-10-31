import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { useAppStore } from "../store";
import { SettingsPanel } from "./SettingsPanel";

const initial = useAppStore.getState();
afterEach(() => {
  cleanup();
  resetMockInvoke();
  act(() => useAppStore.setState({ ...initial }));
});

async function openAppearance() {
  setMockInvoke(() => undefined);
  await act(async () => {
    render(<SettingsPanel mode="dark" onClose={() => {}} />);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
  });
}

describe("Settings → Appearance", () => {
  it("shows a live preview card per theme and switches theme from it", async () => {
    await openAppearance();
    const themes = screen.getByRole("radiogroup", { name: "Theme" });
    const cards = within(themes).getAllByRole("radio");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual([
      "Default",
      "Lens",
      "VS Code",
      "Readable",
    ]);
    expect(within(themes).getAllByTestId("theme-preview")).toHaveLength(4);
    expect(within(themes).getByRole("radio", { name: "Default" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await act(async () => {
      fireEvent.click(within(themes).getByRole("radio", { name: "VS Code" }));
    });
    expect(useAppStore.getState().themeId).toBe("vscode");
    expect(useAppStore.getState().paletteId).toBe("modern");
    expect(within(themes).getByRole("radio", { name: "VS Code" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("lists the active theme's palettes as swatches and picks one", async () => {
    act(() => useAppStore.getState().setTheme("vscode"));
    await openAppearance();
    const palettes = screen.getByRole("radiogroup", { name: "Palette" });
    expect(within(palettes).getAllByRole("radio").map((r) => r.textContent)).toEqual([
      "Modern",
      "Dark+ / Light+",
      "Monokai",
      "Solarized",
      "High Contrast",
    ]);
    await act(async () => {
      fireEvent.click(within(palettes).getByRole("radio", { name: "Solarized" }));
    });
    expect(useAppStore.getState().paletteId).toBe("solarized");
    expect(within(palettes).getByRole("radio", { name: "Solarized" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("marks the palette a stale stored id resolves to", async () => {
    // "teal" was a Lens palette before Freelens teal became the "lens" default.
    act(() => useAppStore.setState({ themeId: "lens", paletteId: "teal" }));
    await openAppearance();
    const palettes = screen.getByRole("radiogroup", { name: "Palette" });
    expect(within(palettes).getByRole("radio", { name: "Freelens" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    act(() => useAppStore.setState({ themeId: "retired", paletteId: "x" }));
    const themes = screen.getByRole("radiogroup", { name: "Theme" });
    expect(within(themes).getByRole("radio", { name: "Default" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("explains a palette mode that isn't upstream", async () => {
    act(() => {
      useAppStore.getState().setTheme("vscode");
      useAppStore.getState().setPalette("monokai");
      useAppStore.setState({ themeMode: "light" });
    });
    await openAppearance();
    expect(screen.getByRole("note").textContent).toContain("Monokai ships dark only");
    act(() => useAppStore.setState({ themeMode: "dark" }));
    expect(screen.queryByRole("note")).toBeNull();
  });
});
