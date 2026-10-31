import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { ColumnPicker } from "./ColumnPicker";
import type { ColumnDef } from "../types";

afterEach(cleanup);

const COLUMNS: ColumnDef[] = [
  { id: "name", header: "Name", kind: "text" },
  { id: "node", header: "Node", kind: "text" },
  { id: "creation_timestamp", header: "Age", kind: "age" },
];

function renderPicker(props: {
  available?: string[];
  enabled?: string[];
  hidden?: string[];
  onToggle?: (key: string) => void;
  onToggleColumn?: (id: string) => void;
  onReset?: () => void;
}) {
  return render(
    <ColumnPicker
      columns={COLUMNS}
      hidden={props.hidden ?? []}
      onToggleColumn={props.onToggleColumn ?? (() => {})}
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

  it("offers the kind's own columns except Name, checked while shown", () => {
    const onToggleColumn = vi.fn();
    const { getByRole, queryByRole } = renderPicker({ hidden: ["node"], onToggleColumn });
    fireEvent.click(getByRole("button", { name: "Customize columns" }));
    expect(queryByRole("menuitemcheckbox", { name: "Name" })).toBeNull();
    expect(getByRole("menuitemcheckbox", { name: "Node" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(getByRole("menuitemcheckbox", { name: "Age" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(getByRole("menuitemcheckbox", { name: "Age" }));
    expect(onToggleColumn).toHaveBeenCalledWith("creation_timestamp");
  });

  it("offers Reset while a built-in column is hidden", () => {
    const onReset = vi.fn();
    const { getByRole } = renderPicker({ hidden: ["node"], onReset });
    fireEvent.click(getByRole("button", { name: "Customize columns" }));
    fireEvent.click(getByRole("button", { name: "Reset" }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("hides Reset when nothing is enabled", () => {
    const { getByRole, queryByRole } = renderPicker({ available: ["zone"] });
    fireEvent.click(getByRole("button", { name: "Customize columns" }));
    expect(queryByRole("button", { name: "Reset" })).toBeNull();
  });

  it("portals the menu to the body so it layers above the tray; clicks inside keep it open", () => {
    const { getByRole, container } = renderPicker({ available: ["zone"] });
    fireEvent.click(getByRole("button", { name: "Customize columns" }));
    const menu = getByRole("menu");
    expect(container.contains(menu)).toBe(false);
    expect(menu.style.position).toBe("fixed");
    fireEvent.mouseDown(getByRole("menuitemcheckbox", { name: "zone" }));
    expect(getByRole("menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(document.querySelector("[role=menu]")).toBeNull();
  });
});
