import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { TabScopeProvider } from "./tabScope";
import { useTableTop } from "./tableTop";

function Shell({ top }: { top: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useTableTop(ref);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el) el.getBoundingClientRect = () => ({ top }) as DOMRect;
      }}
    />
  );
}

const read = () => document.documentElement.style.getPropertyValue("--fs-table-body-top");

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--fs-table-body-top");
});

describe("useTableTop", () => {
  it("publishes the visible table's top and clears it on unmount", () => {
    const { unmount } = render(<Shell top={132.4} />);
    expect(read()).toBe("132px");
    unmount();
    expect(read()).toBe("");
  });

  it("a hidden tab's table doesn't publish", () => {
    render(
      <TabScopeProvider tabId="t" active={false}>
        <Shell top={500} />
      </TabScopeProvider>,
    );
    expect(read()).toBe("");
  });
});
