// ComparePanel: two-resource YAML diff drawer. Pins that both sides fetch
// through the same getResourceYaml path the detail YAML tab uses, that the
// documents are stripped with the same rules (managedFields & friends
// gone), the swap control flips sides without refetching, and per-side
// fetch failures surface with a Retry.
//
// Monaco's DiffEditor is mocked to two textareas — we assert values, not
// editor chrome.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import type { SelectionMeta } from "../store";
import {
  ComparePanel,
  compareTargetFromSelection,
  type CompareTarget,
} from "./ComparePanel";

const { getResourceYamlMock } = vi.hoisted(() => ({
  getResourceYamlMock: vi.fn(),
}));

vi.mock("../api", () => ({
  api: { getResourceYaml: getResourceYamlMock },
}));

vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: { original?: string; modified?: string }) => (
    <div>
      <textarea data-testid="diff-original" readOnly value={props.original ?? ""} />
      <textarea data-testid="diff-modified" readOnly value={props.modified ?? ""} />
    </div>
  ),
}));

beforeEach(() => {
  cleanup();
  getResourceYamlMock.mockReset();
});

const YAML_EU = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: web
  resourceVersion: "111"
  managedFields:
    - manager: ferrisscope
data:
  replicas: "3"
`;
const YAML_US = `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
  namespace: web
  resourceVersion: "222"
  managedFields:
    - manager: ferrisscope
data:
  replicas: "5"
`;

const TARGET: CompareTarget = {
  kindId: "configmaps",
  kindLabel: "ConfigMap",
  a: {
    clusterId: "default::prod-eu",
    clusterName: "prod-eu",
    colorIdx: 0,
    namespace: "web",
    name: "app-config",
  },
  b: {
    clusterId: "default::prod-us",
    clusterName: "prod-us",
    colorIdx: 1,
    namespace: "web",
    name: "app-config",
  },
};

const mockBothSides = () =>
  getResourceYamlMock.mockImplementation((clusterId: string) =>
    Promise.resolve(clusterId === "default::prod-eu" ? YAML_EU : YAML_US),
  );

describe("compareTargetFromSelection", () => {
  const meta = (cid: string, name: string): SelectionMeta => ({
    clusterId: cid,
    namespace: "web",
    name,
  });
  const nameFor = (cid: string) => cid.split("::")[1] ?? cid;
  const colorFor = () => 0;

  it("builds a target from exactly two selected rows in selection order", () => {
    const sel = new Map<string, SelectionMeta>([
      ["s1", meta("default::prod-eu", "app-config")],
      ["s2", meta("default::prod-us", "app-config")],
    ]);
    const target = compareTargetFromSelection(
      sel,
      "configmaps",
      "ConfigMap",
      nameFor,
      colorFor,
    );
    expect(target?.a.clusterName).toBe("prod-eu");
    expect(target?.b.clusterName).toBe("prod-us");
  });

  it("returns null unless exactly two rows are selected", () => {
    const one = new Map([["s1", meta("c", "x")]]);
    const three = new Map([
      ["s1", meta("c", "x")],
      ["s2", meta("c", "y")],
      ["s3", meta("c", "z")],
    ]);
    expect(
      compareTargetFromSelection(one, "k", "K", nameFor, colorFor),
    ).toBeNull();
    expect(
      compareTargetFromSelection(three, "k", "K", nameFor, colorFor),
    ).toBeNull();
  });
});

describe("ComparePanel", () => {
  it("fetches both sides and diffs the STRIPPED documents", async () => {
    mockBothSides();
    render(<ComparePanel mode="dark" target={TARGET} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByTestId("diff-original")).toBeTruthy(),
    );
    expect(getResourceYamlMock).toHaveBeenCalledWith(
      "default::prod-eu",
      "configmaps",
      "web",
      "app-config",
    );
    expect(getResourceYamlMock).toHaveBeenCalledWith(
      "default::prod-us",
      "configmaps",
      "web",
      "app-config",
    );

    const original = (
      screen.getByTestId("diff-original") as HTMLTextAreaElement
    ).value;
    const modified = (
      screen.getByTestId("diff-modified") as HTMLTextAreaElement
    ).value;
    // Same strip rules as the YAML tab: server-managed fields are gone…
    expect(original).not.toContain("managedFields");
    expect(original).not.toContain("resourceVersion");
    expect(modified).not.toContain("managedFields");
    // …while the real divergence is visible (the strip→re-dump cycle may
    // change the quote style, so match either).
    expect(original).toMatch(/replicas: ['"]3['"]/);
    expect(modified).toMatch(/replicas: ['"]5['"]/);
  });

  it("swap flips sides without refetching", async () => {
    mockBothSides();
    render(<ComparePanel mode="dark" target={TARGET} onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("diff-original")).toBeTruthy(),
    );
    const calls = getResourceYamlMock.mock.calls.length;

    fireEvent.click(screen.getByLabelText("Swap sides"));
    await waitFor(() =>
      expect(
        (screen.getByTestId("diff-original") as HTMLTextAreaElement).value,
      ).toMatch(/replicas: ['"]5['"]/),
    );
    expect(
      (screen.getByTestId("diff-modified") as HTMLTextAreaElement).value,
    ).toMatch(/replicas: ['"]3['"]/);
    expect(getResourceYamlMock.mock.calls.length).toBe(calls);
  });

  it("surfaces a per-side fetch failure with the side identity and a Retry", async () => {
    getResourceYamlMock.mockImplementation((clusterId: string) =>
      clusterId === "default::prod-eu"
        ? Promise.resolve(YAML_EU)
        : Promise.reject(new Error("connection refused")),
    );
    render(<ComparePanel mode="dark" target={TARGET} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText("Retry")).toBeTruthy());
    expect(screen.getByText(/prod-us · web\/app-config/)).toBeTruthy();
    expect(screen.queryByTestId("diff-original")).toBeNull();

    // Retry refetches; with both sides healthy the diff appears.
    mockBothSides();
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() =>
      expect(screen.getByTestId("diff-original")).toBeTruthy(),
    );
  });

  it("Escape closes the drawer", async () => {
    mockBothSides();
    const onClose = vi.fn();
    render(<ComparePanel mode="dark" target={TARGET} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
