import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { HpaMetricCard, HpaOverview } from "./hpa";
import { tokens } from "../../../theme";
import type { HorizontalPodAutoscalerDetail, HpaMetric } from "../../../types";

const t = tokens("light");

const metric = (over: Partial<HpaMetric> = {}): HpaMetric => ({
  type: "Resource",
  name: "cpu",
  target: { type: "Utilization", average_utilization: 80, average_value: null, value: null },
  current: { average_utilization: 120, average_value: null, value: null },
  target_display: "80%",
  current_display: "120%",
  ratio: 1.5,
  ...over,
});

const detail = (over: Partial<HorizontalPodAutoscalerDetail> = {}): HorizontalPodAutoscalerDetail => ({
  meta: {} as HorizontalPodAutoscalerDetail["meta"],
  scale_target_ref: { api_version: "apps/v1", kind: "Deployment", name: "web" },
  min_replicas: 2,
  max_replicas: 10,
  current_replicas: 3,
  desired_replicas: 3,
  last_scale_time: null,
  metrics: [],
  conditions: [],
  scaling: { status: "Active", reason: "ValidMetricFound", message: "the HPA was able to compute" },
  ...over,
});

afterEach(cleanup);

describe("HpaMetricCard", () => {
  it("renders current / target with an over-target meter and target tick", () => {
    render(<HpaMetricCard t={t} metric={metric()} />);
    expect(screen.getByTestId("hpa-metric-current").textContent).toBe("120%");
    expect(screen.getByText("/ 80%")).toBeTruthy();
    const meter = screen.getByRole("meter", { name: "cpu vs target" });
    expect(meter.getAttribute("aria-valuenow")).toBe("150");
    expect(within(meter).getByTestId("bar-gauge-marker")).toBeTruthy();
    expect(screen.getByText("150% of target")).toBeTruthy();
  });

  it("shows <unknown> and no meter when the controller has no reading", () => {
    render(<HpaMetricCard t={t} metric={metric({ current: null, current_display: null, ratio: null })} />);
    expect(screen.getByTestId("hpa-metric-current").textContent).toBe("<unknown>");
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByText("no reading from metrics API")).toBeTruthy();
  });
});

describe("HpaOverview", () => {
  it("renders scaling status, replicas and target cards", () => {
    render(<HpaOverview t={t} mode="light" detail={detail()} namespace="default" />);
    const list = screen.getByRole("list", { name: "Autoscaler overview" });
    expect(within(list).getAllByRole("listitem").map((c) => c.getAttribute("aria-label"))).toEqual([
      "Scaling",
      "Replicas",
      "Target",
    ]);
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByTestId("hpa-current-replicas").textContent).toBe("3");
    expect(screen.queryByTestId("hpa-desired-replicas")).toBeNull();
    expect(screen.getByText("min 2 · max 10")).toBeTruthy();
    expect(screen.getByText("Deployment/web")).toBeTruthy();
    expect(screen.getByText("never scaled")).toBeTruthy();
  });

  it("shows the desired count while a rescale is in flight", () => {
    render(
      <HpaOverview
        t={t}
        mode="light"
        detail={detail({ desired_replicas: 6, scaling: { status: "Scaling", reason: null, message: null } })}
        namespace="default"
      />,
    );
    expect(screen.getByTestId("hpa-desired-replicas").textContent).toBe("→ 6");
    expect(screen.getByTestId("bar-gauge-marker")).toBeTruthy();
  });
});
