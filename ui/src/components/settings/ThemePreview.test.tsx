import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PaletteSwatch, ThemePreview } from "./ThemePreview";
import { resolveTheme, tokens } from "../../theme";

const toRgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

describe("ThemePreview", () => {
  it("draws the shell in the theme's own rail and accent colours", () => {
    const r = resolveTheme({ themeId: "lens", paletteId: "lens", mode: "dark" });
    render(<ThemePreview theme={r} />);
    expect(screen.getByTestId("theme-preview").style.background).toBe(toRgb(r.tokens.bg));
    expect(screen.getByTestId("theme-preview-rail-active").style.background).toBe(
      toRgb(r.tokens.railActive),
    );
    expect(screen.getByTestId("theme-preview-button").style.background).toBe(toRgb(r.tokens.accent));
  });

  it("uses the theme's font family", () => {
    const r = resolveTheme({ themeId: "vscode", paletteId: "modern", mode: "light" });
    render(<ThemePreview theme={r} />);
    expect(screen.getByTestId("theme-preview").style.fontFamily).toContain("Segoe WPC");
  });
});

describe("PaletteSwatch", () => {
  it("is a radio that reports its state and picks on click", () => {
    const onClick = vi.fn();
    const r = resolveTheme({ themeId: "vscode", paletteId: "monokai", mode: "dark" });
    const { rerender } = render(
      <PaletteSwatch t={tokens("dark")} theme={r} name="Monokai" active={false} onClick={onClick} />,
    );
    const radio = screen.getByRole("radio", { name: "Monokai" });
    expect(radio).toHaveAttribute("aria-checked", "false");
    fireEvent.click(radio);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<PaletteSwatch t={tokens("dark")} theme={r} name="Monokai" active onClick={onClick} />);
    expect(screen.getByRole("radio", { name: "Monokai" })).toHaveAttribute("aria-checked", "true");
  });
});
