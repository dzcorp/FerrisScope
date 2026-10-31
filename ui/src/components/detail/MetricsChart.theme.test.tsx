// The metrics Chart draws per the theme's `chart` style: Default a thin line
// over a fitted range, Lens Freelens's stepped 20 % fill from zero with
// zebra stripes.

import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useAppStore } from "../../store";
import { resolveTheme } from "../../theme";
import { Chart } from "./MetricsTab";

const initial = useAppStore.getState();
afterEach(() => {
  cleanup();
  act(() => useAppStore.setState({ ...initial }));
});

const samples = Array.from({ length: 30 }, (_, i) => ({ t: i * 60_000, v: 50 + (i % 5) * 10 }));

function draw(themeId: string) {
  act(() => useAppStore.getState().setTheme(themeId));
  const s = useAppStore.getState();
  const t = resolveTheme({ themeId: s.themeId, paletteId: s.paletteId, mode: s.themeMode }).tokens;
  const { container } = render(
    <Chart t={t} unit="m" series={[{ samples, stroke: t.chartCpu, label: "" }]} />,
  );
  const svg = container.querySelector("svg")!;
  return { svg, t };
}

describe("metrics Chart theme style", () => {
  it("Default: straight line, no fill, 3 gridlines, dashed middle, 130px", () => {
    const { svg, t } = draw("default");
    expect(svg.getAttribute("height")).toBe("130");
    const series = [...svg.querySelectorAll("path")];
    expect(series).toHaveLength(1);
    expect(series[0]!.getAttribute("d")).toContain(" L");
    expect(series[0]!.getAttribute("stroke-width")).toBe("1.5");
    expect(series[0]!.getAttribute("stroke")).toBe(t.accent);
    const grid = [...svg.querySelectorAll("line")];
    expect(grid).toHaveLength(3);
    expect(grid.map((g) => g.getAttribute("stroke-dasharray"))).toEqual([null, "2 4", null]);
    expect(svg.querySelectorAll("rect")).toHaveLength(0);
  });

  it("Lens: stepped series over a 20 % fill from zero, 6 ticks, stripes, 200px", () => {
    const { svg, t } = draw("lens");
    expect(svg.getAttribute("height")).toBe("200");
    const [area, line] = [...svg.querySelectorAll("path")];
    expect(area!.getAttribute("fill-opacity")).toBe("0.2");
    expect(area!.getAttribute("d")).toMatch(/Z$/);
    expect(line!.getAttribute("d")).toMatch(/ H[\d.]+ V[\d.]+/);
    expect(line!.getAttribute("stroke-width")).toBe("3");
    expect(line!.getAttribute("stroke")).toBe("#00a7a0");
    expect(svg.querySelectorAll("line")).toHaveLength(6);
    const labels = [...svg.querySelectorAll("text")].map((n) => n.textContent);
    expect(labels).toContain("0");
    const stripes = [...svg.querySelectorAll("rect")];
    expect(stripes.length).toBeGreaterThan(0);
    expect(stripes[0]!.getAttribute("fill")).toBe(t.chartStripe);
  });
});

describe("reference series", () => {
  const ref = samples.map((s) => ({ t: s.t, v: 120 }));
  function drawRefs(themeId: string) {
    act(() => useAppStore.getState().setTheme(themeId));
    const s = useAppStore.getState();
    const t = resolveTheme({ themeId: s.themeId, paletteId: s.paletteId, mode: s.themeMode }).tokens;
    const { container } = render(
      <Chart
        t={t}
        unit="m"
        series={[
          { samples, stroke: t.chartCpu, label: "Usage" },
          { samples: ref, stroke: t.chartRequests, label: "Requests", ref: true },
        ]}
      />,
    );
    return { svg: container.querySelector("svg")!, t };
  }

  it("Default dashes them and paints them under usage", () => {
    const { svg, t } = drawRefs("default");
    const lines = [...svg.querySelectorAll("path")];
    expect(lines.map((p) => p.getAttribute("stroke"))).toEqual([t.chartRequests, t.accent]);
    expect(lines[0]!.getAttribute("stroke-dasharray")).toBe("4 3");
    expect(lines[1]!.getAttribute("stroke-dasharray")).toBeNull();
  });

  it("Lens fills them like any dataset, Freelens's requests green", () => {
    const { svg } = drawRefs("lens");
    const paths = [...svg.querySelectorAll("path")];
    const fills = paths.filter((p) => p.getAttribute("fill-opacity") === "0.2");
    expect(fills.map((p) => p.getAttribute("fill"))).toEqual(["#30b24d", "#00a7a0"]);
    expect(paths.some((p) => p.getAttribute("stroke-dasharray"))).toBe(false);
  });
});

describe("metrics Chart sizing", () => {
  it("starts observing its width once samples arrive after mount", () => {
    const observed: Element[] = [];
    const Orig = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const t = resolveTheme({ themeId: "default", paletteId: "default", mode: "dark" }).tokens;
      const one = [{ samples: samples.slice(0, 1), stroke: t.chartCpu, label: "" }];
      const { container, rerender } = render(<Chart t={t} unit="m" series={one} />);
      expect(container.querySelector("svg")).toBeNull();
      rerender(<Chart t={t} unit="m" series={[{ ...one[0]!, samples }]} />);
      expect(observed).toHaveLength(1);
    } finally {
      globalThis.ResizeObserver = Orig;
    }
  });
});
