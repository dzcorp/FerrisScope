import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import type { HelmChartDetail } from "../../../types";

// Monaco pulls in a web worker + canvas that jsdom can't run; the values editor
// is irrelevant to what we're testing (hook order across load states), so stub
// it to a plain node.
vi.mock("@monaco-editor/react", () => ({
  default: () => <div data-testid="monaco-stub" />,
}));

// Control the detail fetch by hand so we can hold the component in `loading`
// and then flip it to `ready` — the exact transition that used to crash.
const getHelmChartDetail = vi.fn<() => Promise<HelmChartDetail>>();
vi.mock("../../../api", () => ({
  api: {
    getHelmChartDetail: (...args: unknown[]) =>
      getHelmChartDetail(...(args as [])),
  },
}));

import { HelmChartSummary } from "./chart";

const DETAIL: HelmChartDetail = {
  source: "cluster",
  chart_name: "podinfo",
  chart_version: "6.5.0",
  app_version: "6.5.0",
  description: "demo chart",
  home: null,
  icon: null,
  sources: [],
  keywords: [],
  default_values_yaml: "replicaCount: 1\n",
  used_by: [],
  helm_available: true,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("HelmChartSummary", () => {
  beforeEach(() => {
    getHelmChartDetail.mockReset();
  });

  // Regression: `useAppStore(selectClusterDegraded)` used to sit BELOW the
  // loading/error early returns, so the ready render called one more hook than
  // the loading render. React threw "Rendered more hooks than during the
  // previous render" the instant the chart loaded and — with no error boundary
  // — whited out the whole window. All hooks must run unconditionally, so the
  // loading -> ready transition must render cleanly.
  it("survives the loading -> ready transition without a hook-order crash", async () => {
    const d = deferred<HelmChartDetail>();
    getHelmChartDetail.mockReturnValue(d.promise);

    render(
      <HelmChartSummary
        mode="dark"
        clusterId="ctx"
        uid="helm:chart:cluster:podinfo:6.5.0"
        name="podinfo"
        detailVersion={0}
      />,
    );

    // Loading render: fewer hooks in the buggy version.
    expect(screen.getByText("Loading chart…")).toBeTruthy();

    // Ready render: the extra hook fired here and crashed. Now it must render.
    await act(async () => {
      d.resolve(DETAIL);
      await d.promise;
    });

    // Reaching the ready render at all is the assertion — a hook-order crash
    // would have thrown before any of this mounted. (The chart name shows in
    // both the title and the release-name suggestion, hence getAllByText.)
    expect(screen.getAllByText("podinfo").length).toBeGreaterThan(0);
    expect(screen.queryByText("Loading chart…")).toBeNull();
    expect(getHelmChartDetail).toHaveBeenCalledTimes(1);
  });
});
