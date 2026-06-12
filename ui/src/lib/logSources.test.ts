import { describe, it, expect } from "vitest";
import {
  aggregateLogStatus,
  buildLogSources,
  formatLogExport,
  MAX_LOG_SOURCES,
  suggestedLogFileName,
  type LogStatus,
  type ObservedPod,
} from "./logSources";

const names: Record<string, string> = {
  "kc::prod-eu": "prod-eu",
  "kc::prod-us": "prod-us",
};
const nameFor = (cid: string) => names[cid] ?? cid;

function pod(
  clusterId: string,
  namespace: string,
  name: string,
  containers: string[],
): ObservedPod {
  return { clusterId, namespace, name, containers };
}

describe("buildLogSources", () => {
  it("one pod, one container → one unprefixed-feeling source", () => {
    const { sources, dropped } = buildLogSources(
      [pod("kc::prod-eu", "default", "api-7f9c-x1", ["app"])],
      nameFor,
    );
    expect(dropped).toBe(0);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.label).toBe("api-7f9c-x1");
    expect(sources[0]!.container).toBe("app");
  });

  it("compresses shared pod-name prefixes like the table compresses cluster names", () => {
    const { sources } = buildLogSources(
      [
        pod("kc::prod-eu", "default", "api-7f9c4d5-x1q2z", ["app"]),
        pod("kc::prod-eu", "default", "api-7f9c4d5-y8w3v", ["app"]),
      ],
      nameFor,
    );
    expect(sources.map((s) => s.label)).toEqual(["x1q2z", "y8w3v"]);
  });

  it("appends the container segment only for multi-container pods", () => {
    const { sources } = buildLogSources(
      [pod("kc::prod-eu", "default", "web-0", ["app", "istio-proxy"])],
      nameFor,
    );
    expect(sources.map((s) => s.label)).toEqual([
      "web-0/app",
      "web-0/istio-proxy",
    ]);
  });

  it("prefixes short cluster names when sources span clusters", () => {
    const { sources } = buildLogSources(
      [
        pod("kc::prod-eu", "default", "api-0", ["app"]),
        pod("kc::prod-us", "default", "api-0", ["app"]),
      ],
      nameFor,
    );
    expect(sources.map((s) => s.label)).toEqual(["eu api-0", "us api-0"]);
  });

  it("namespace-prefixes a pod name that repeats within one cluster", () => {
    const { sources } = buildLogSources(
      [
        pod("kc::prod-eu", "team-a", "api-0", ["app"]),
        pod("kc::prod-eu", "team-b", "api-0", ["app"]),
      ],
      nameFor,
    );
    expect(sources.map((s) => s.label)).toEqual([
      "team-a/api-0",
      "team-b/api-0",
    ]);
  });

  it("caps the fan-out at MAX_LOG_SOURCES and reports the overflow", () => {
    const pods = Array.from({ length: MAX_LOG_SOURCES + 5 }, (_, i) =>
      pod("kc::prod-eu", "default", `p${i}`, ["app"]),
    );
    const { sources, dropped } = buildLogSources(pods, nameFor);
    expect(sources).toHaveLength(MAX_LOG_SOURCES);
    expect(dropped).toBe(5);
  });

  it("assigns sequential color indices", () => {
    const { sources } = buildLogSources(
      [
        pod("kc::prod-eu", "default", "a", ["app", "sidecar"]),
        pod("kc::prod-eu", "default", "b", ["app"]),
      ],
      nameFor,
    );
    expect(sources.map((s) => s.colorIdx)).toEqual([0, 1, 2]);
  });
});

describe("aggregateLogStatus", () => {
  const streaming: LogStatus = { kind: "streaming" };
  const ended: LogStatus = { kind: "ended", reason: "exited" };
  const error: LogStatus = { kind: "error", message: "403" };

  it("empty → starting; single passes through", () => {
    expect(aggregateLogStatus([]).kind).toBe("starting");
    expect(aggregateLogStatus([error])).toEqual(error);
  });

  it("any streaming wins over everything else", () => {
    expect(aggregateLogStatus([ended, error, streaming]).kind).toBe(
      "streaming",
    );
  });

  it("waiting beats starting; starting beats terminal states", () => {
    expect(
      aggregateLogStatus([{ kind: "starting" }, { kind: "waiting", reason: "init" }])
        .kind,
    ).toBe("waiting");
    expect(aggregateLogStatus([{ kind: "starting" }, ended]).kind).toBe(
      "starting",
    );
  });

  it("all failed → error; mixed ended/failed → ended with counts", () => {
    expect(aggregateLogStatus([error, error]).kind).toBe("error");
    const mixed = aggregateLogStatus([ended, error]);
    expect(mixed.kind).toBe("ended");
    expect(mixed.kind === "ended" && mixed.reason).toContain("1 failed");
  });
});

describe("formatLogExport", () => {
  const sources = buildLogSources(
    [
      pod("kc::prod-eu", "default", "api-0", ["app"]),
      pod("kc::prod-eu", "default", "web-0", ["app"]),
    ],
    nameFor,
  ).sources;

  it("includes ts + label for aggregated views and strips ANSI", () => {
    const out = formatLogExport(
      [
        { ts: "10:30:00.000", text: "\u001b[31mred\u001b[0m alert", system: false, src: 0 },
        { ts: null, text: "plain", system: false, src: 1 },
        { ts: null, text: "— stream ended: exited", system: true, src: 0 },
      ],
      sources,
    );
    // Note the shortener also drops the shared "-0" suffix token — the
    // same compression the table applies to cluster names.
    expect(out).toBe(
      "10:30:00.000 [api] red alert\n[web] plain\n— stream ended: exited\n",
    );
  });

  it("omits labels for a single source", () => {
    const single = sources.slice(0, 1);
    const out = formatLogExport(
      [{ ts: null, text: "hello", system: false, src: 0 }],
      single,
    );
    expect(out).toBe("hello\n");
  });

  it("empty buffer → empty string (no trailing newline)", () => {
    expect(formatLogExport([], sources)).toBe("");
  });
});

describe("suggestedLogFileName", () => {
  const now = new Date(2026, 5, 12, 9, 5, 7);

  it("single source names after pod + container", () => {
    const sources = buildLogSources(
      [pod("kc::prod-eu", "default", "api-0", ["app"])],
      nameFor,
    ).sources;
    expect(suggestedLogFileName(sources, now)).toBe(
      "api-0-app-20260612-090507.log",
    );
  });

  it("aggregated names carry the pod count", () => {
    const sources = buildLogSources(
      [
        pod("kc::prod-eu", "default", "api-0", ["app", "sidecar"]),
        pod("kc::prod-eu", "default", "web-0", ["app"]),
      ],
      nameFor,
    ).sources;
    expect(suggestedLogFileName(sources, now)).toBe(
      "logs-2-pods-20260612-090507.log",
    );
  });
});
