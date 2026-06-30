import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { ColumnPicker } from "./ColumnPicker";

afterEach(cleanup);

function renderPicker(props: {
  available?: string[];
  enabled?: string[];
  onToggle?: (key: string) => void;
  onReset?: () => void;
}) {
  return render(
    <ColumnPicker
      available={props.available ?? []}
      enabled={props.enabled ?? []}
      onToggle={props.onToggle ?? (() => {})}
      onReset={props.onReset ?? (() => {})}
    />,
  );
}

describe("ColumnPicker", () => {
  it("is closed until the control is clicked", () => {
    const { queryByRole, getByRole } = renderPicker({ available: ["zone"] });
    expect(queryByRole("menu")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Customize columns" }));
    expect(getByRole("menu")).toBeTruthy();
  });

  it("lists the available keys with checked state reflecting enabled", () => {
    const { getByRole } = renderPicker({
      available: ["topology.kubernetes.io/zone", "kubernetes.io/arch"],
      enabled: ["kubernetes.io/arch"],
    });
    fireEvent.click(getByRole("button", { name: "Customize columns" }));
    expect(
      getByRole("menuitemcheckbox", {
        name: "topology.kubernetes.io/zone",
      }).getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      getByRole("menuitemcheckbox", {
        name: "kubernetes.io/arch",
      }).getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("toggles a key when its row is clicked", () => {
    const onToggle = vi.fn();
    const { getByRole } = renderPicker({ available: ["zone"], onToggle });
    fireEvent.click(getByRole("button", { name: "Customize columns" }));
    fireEvent.click(getByRole("menuitemcheckbox", { name: "zone" }));
    expect(onToggle).toHaveBeenCalledWith("zone");
  });

  it("shows a persisted-but-absent key so it can be turned off", () => {
    const { getByRole } = renderPicker({
      available: [],
      enabled: ["stale/key"],
    });
    fireEvent.click(getByRole("button", { name: "Customize columns" }));
    expect(
      getByRole("menuitemcheckbox", { name: "stale/key" }).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
  });

  it("renders an empty state when there are no labels", () => {
    const { getByRole, getByText } = renderPicker({});
    fireEvent.click(getByRole("button", { name: "Customize columns" }));
    expect(getByText("No labels on these resources.")).toBeTruthy();
  });

  it("shows Reset only when columns are enabled, and fires onReset", () => {
    const onReset = vi.fn();
    const { getByRole } = renderPicker({
      available: ["zone"],
      enabled: ["zone"],
      onReset,
    });
    fireEvent.click(getByRole("button", { name: "Customize columns" }));
    fireEvent.click(getByRole("button", { name: "Reset" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("hides Reset when nothing is enabled", () => {
    const { getByRole, queryByRole } = renderPicker({ available: ["zone"] });
    fireEvent.click(getByRole("button", { name: "Customize columns" }));
    expect(queryByRole("button", { name: "Reset" })).toBeNull();
  });
});
