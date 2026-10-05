import { describe, expect, it } from "vitest";
import {
  AUTO,
  budgetLabel,
  budgetOptions,
  effortLabel,
  effortOptions,
  specIsEmpty,
} from "./reasoning";
import type { ReasoningSpec } from "../types";

const spec = (over: Partial<ReasoningSpec> = {}): ReasoningSpec => ({
  efforts: [],
  budget: null,
  toggle: false,
  from_catalogue: true,
  ...over,
});

describe("effortLabel", () => {
  it("renders the provider's own names readably", () => {
    expect(effortLabel("none")).toBe("Off");
    expect(effortLabel("minimal")).toBe("Minimal");
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel("max")).toBe("Max");
  });
  it("capitalises names it has never seen", () => {
    expect(effortLabel("ultra")).toBe("Ultra");
  });
});

describe("budgetLabel", () => {
  it("shows whole KiB compactly and other sizes exactly", () => {
    expect(budgetLabel(1024)).toBe("1k");
    expect(budgetLabel(16384)).toBe("16k");
    expect(budgetLabel(65536)).toBe("64k");
    expect(budgetLabel(5000)).toBe("5,000");
    expect(budgetLabel(500)).toBe("500");
  });
});

describe("effortOptions", () => {
  it("is Auto followed by exactly the model's levels, in order", () => {
    const o = effortOptions(spec({ efforts: ["none", "low", "high", "max"] }), null);
    expect(o.map((x) => x.value)).toEqual([AUTO, "none", "low", "high", "max"]);
    expect(o[0]!.label).toMatch(/^Auto/);
    expect(o[1]!.label).toBe("Off");
  });

  it("keeps a saved level the list no longer offers, marked", () => {
    const o = effortOptions(spec({ efforts: ["low", "high"] }), "xhigh");
    expect(o.at(-1)).toEqual({ value: "xhigh", label: "Extra high (not offered here)" });
  });

  it("does not duplicate a saved level that is offered", () => {
    const o = effortOptions(spec({ efforts: ["low", "high"] }), "high");
    expect(o.filter((x) => x.value === "high")).toHaveLength(1);
  });
});

describe("budgetOptions", () => {
  const range = { min: 1024, max: null, presets: [1024, 4096, 16384] };

  it("is Default plus the presets", () => {
    const o = budgetOptions(range, null);
    expect(o.map((x) => x.value)).toEqual(["default", "1024", "4096", "16384"]);
    expect(o[2]!.label).toBe("4k tokens");
  });

  it("keeps a saved budget outside the presets", () => {
    const o = budgetOptions(range, 5000);
    expect(o.at(-1)).toEqual({ value: "5000", label: "5,000 tokens" });
  });
});

describe("specIsEmpty", () => {
  it("is true only when there is nothing to choose", () => {
    expect(specIsEmpty(spec())).toBe(true);
    expect(specIsEmpty(spec({ efforts: ["low"] }))).toBe(false);
    expect(specIsEmpty(spec({ toggle: true }))).toBe(false);
    expect(
      specIsEmpty(spec({ budget: { min: 1024, max: null, presets: [1024] } })),
    ).toBe(false);
  });
});
