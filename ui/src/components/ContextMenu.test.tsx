import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ContextMenu } from "./ContextMenu";

afterEach(cleanup);

describe("ContextMenu", () => {
  it("renders an item's reason as its tooltip and swallows a disabled click", () => {
    const onClick = vi.fn();
    render(
      <ContextMenu
        mode="dark"
        position={{ x: 0, y: 0 }}
        onClose={() => {}}
        items={[
          { kind: "item", label: "Delete pod", onClick, disabled: true, title: "Not permitted: x" },
        ]}
      />,
    );
    const item = screen.getByRole("menuitem", { name: "Delete pod" });
    expect(item.getAttribute("title")).toBe("Not permitted: x");
    expect(item).toBeDisabled();
    // Hoverable, so the reason shows; the click still goes nowhere.
    expect((item as HTMLButtonElement).disabled).toBe(false);
    fireEvent.mouseEnter(item);
    expect(item.style.background).toBe("transparent");
    fireEvent.click(item);
    expect(onClick).not.toHaveBeenCalled();
  });
});
