import { describe, expect, it } from "vitest";
import {
  approxLineDiff,
  isPendingStatus,
  namespaceError,
  parseChartUid,
  releaseNameError,
  suggestReleaseName,
  valuesToYaml,
  valuesYamlError,
} from "./helm";

describe("parseChartUid", () => {
  it("splits source, name and a version that may contain dashes", () => {
    expect(parseChartUid("helm:chart:bitnami:redis:18.1.0-rc.1")).toEqual({
      source: "bitnami",
      name: "redis",
      version: "18.1.0-rc.1",
    });
  });

  it("rejects foreign prefixes and missing parts", () => {
    expect(parseChartUid("chart:cluster:x:1")).toBeNull();
    expect(parseChartUid("helm:chart:cluster")).toBeNull();
    expect(parseChartUid("helm:chart:cluster:redis")).toBeNull();
    expect(parseChartUid("helm:chart:cluster::1.0")).toBeNull();
    expect(parseChartUid("helm:chart:cluster:redis:")).toBeNull();
  });
});

describe("approxLineDiff", () => {
  it("counts changed, added and removed lines", () => {
    expect(approxLineDiff("a\nb", "a\nb")).toBe(0);
    expect(approxLineDiff("a\nb", "a\nc")).toBe(1);
    expect(approxLineDiff("a", "a\nb\nc")).toBe(2);
  });
});

describe("valuesToYaml", () => {
  it("dumps objects as YAML and treats empty values as no overrides", () => {
    expect(valuesToYaml({ replicaCount: 2 })).toBe("replicaCount: 2\n");
    expect(valuesToYaml(null)).toBe("");
    expect(valuesToYaml({})).toBe("");
    expect(valuesToYaml("raw: text")).toBe("raw: text");
  });
});

describe("suggestReleaseName", () => {
  it("strips the repo prefix and sanitises to a valid release name", () => {
    expect(suggestReleaseName("bitnami/redis")).toBe("redis");
    expect(suggestReleaseName("My_Chart")).toBe("my-chart");
    expect(releaseNameError(suggestReleaseName("-Weird--Chart_"))).toBeNull();
  });
});

describe("releaseNameError", () => {
  it("accepts dot-separated DNS labels up to 53 chars", () => {
    expect(releaseNameError("web")).toBeNull();
    expect(releaseNameError("web.v2-canary")).toBeNull();
    expect(releaseNameError("a".repeat(53))).toBeNull();
  });

  it("rejects empty, long, uppercase and badly delimited names", () => {
    expect(releaseNameError("")).toMatch(/required/);
    expect(releaseNameError("a".repeat(54))).toMatch(/53/);
    expect(releaseNameError("Web")).toMatch(/lowercase/);
    expect(releaseNameError("-web")).not.toBeNull();
    expect(releaseNameError("web-")).not.toBeNull();
    expect(releaseNameError("web..v2")).not.toBeNull();
    expect(releaseNameError("web_v2")).not.toBeNull();
  });
});

describe("namespaceError", () => {
  it("enforces a DNS-1123 label of at most 63 chars", () => {
    expect(namespaceError("kube-system")).toBeNull();
    expect(namespaceError("")).toMatch(/required/);
    expect(namespaceError("a".repeat(64))).toMatch(/63/);
    expect(namespaceError("team.a")).not.toBeNull();
    expect(namespaceError("Team")).not.toBeNull();
  });
});

describe("valuesYamlError", () => {
  it("accepts mappings and empty documents", () => {
    expect(valuesYamlError("a: 1\n")).toBeNull();
    expect(valuesYamlError("")).toBeNull();
    expect(valuesYamlError("# only a comment\n")).toBeNull();
  });

  it("rejects parse errors and non-mapping documents", () => {
    expect(valuesYamlError("a: [1, 2")).toMatch(/YAML parse error/);
    expect(valuesYamlError("- a\n- b\n")).toMatch(/mapping/);
    expect(valuesYamlError("42")).toMatch(/mapping/);
  });
});

describe("isPendingStatus", () => {
  it("flags in-flight helm operations only", () => {
    for (const s of ["pending-install", "pending-upgrade", "pending-rollback", "uninstalling"])
      expect(isPendingStatus(s)).toBe(true);
    for (const s of ["deployed", "failed", "superseded", null, undefined])
      expect(isPendingStatus(s)).toBe(false);
  });
});
