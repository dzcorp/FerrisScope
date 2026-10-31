import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../../../test/tauri-mock";
import type { CustomResourceDetail } from "../../../types";
import { CustomResourceSummary } from "./generic";

afterEach(() => {
  cleanup();
  resetMockInvoke();
});

const detail: CustomResourceDetail = {
  meta: {
    name: "demo",
    namespace: "ns",
    uid: null,
    created_at: null,
    labels: [],
    annotations: [],
    controlled_by: null,
    generation: null,
    managers: [],
  },
  object: {
    spec: {
      routes: [
        { name: "alpha", port: 80 },
        { name: "bravo", port: 81 },
      ],
      tags: ["one", "two"],
    },
  },
  schema: null,
  printer_columns: [],
  kind: "Demo",
  group: "example.com",
  version: "v1",
  scope: "Namespaced",
};

describe("CustomResourceSummary tree filter", () => {
  it("hides non-matching array items and restores them when the filter clears", async () => {
    setMockInvoke((cmd) => (cmd === "get_custom_resource_detail_cmd" ? detail : undefined));
    await act(async () => {
      render(
        <CustomResourceSummary
          mode="dark"
          clusterId="c1"
          kindId="crd:demo"
          namespace="ns"
          name="demo"
          detailVersion={0}
        />,
      );
    });
    const filter = screen.getAllByPlaceholderText("filter…")[0]!;
    expect(screen.queryAllByText("bravo").length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.change(filter, { target: { value: "alpha" } });
    });
    expect(screen.queryAllByText("bravo")).toHaveLength(0);
    expect(screen.getAllByText("alpha").length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.change(filter, { target: { value: "" } });
    });
    expect(screen.queryAllByText("bravo").length).toBeGreaterThan(0);
  });
});
