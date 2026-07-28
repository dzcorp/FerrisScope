import { describe, it, expect } from "vitest";
import type { LogContainer } from "../types";
import {
  aggregateLogStatus,
  buildLogSources,
  containerUniverse,
  initOnlyContainerNames,
  podKey,
  DEFAULT_TAIL_LINES,
  formatLogExport,
  isFullSourceSwap,
  MAX_LOG_SOURCES,
  reconcileStreams,
  sourceKey,
  suggestedLogFileName,
  TAIL_OPTIONS,
  type LogStatus,
  type ObservedPod,
} from "./logSources";

describe("reconcileStreams", () => {
  it("starts only new keys and stops only gone keys", () => {
    // a stays, b is removed, c is added.
    const { toStart, toStop } = reconcileStreams(["a", "b"], ["a", "c"]);
    expect(toStart).toEqual(["c"]);
    expect(toStop).toEqual(["b"]);
  });

  it("is a no-op when the sets match", () => {
    const { toStart, toStop } = reconcileStreams(["a", "b"], ["b", "a"]);
    expect(toStart).toEqual([]);
    expect(toStop).toEqual([]);
  });

  it("starts everything from empty and stops everything to empty", () => {
    expect(reconcileStreams([], ["a", "b"])).toEqual({
      toStart: ["a", "b"],
      toStop: [],
    });
    expect(reconcileStreams(["a", "b"], [])).toEqual({
      toStart: [],
      toStop: ["a", "b"],
    });
  });
});

describe("isFullSourceSwap", () => {
  it("is true when the two sets are disjoint and both non-empty", () => {
    expect(isFullSourceSwap(["a", "b"], ["c", "d"])).toBe(true);
  });

  it("is false when any key overlaps (incremental add/remove)", () => {
    // Pod added: a kept, b new.
    expect(isFullSourceSwap(["a"], ["a", "b"])).toBe(false);
    // Pod removed: a kept.
    expect(isFullSourceSwap(["a", "b"], ["a"])).toBe(false);
  });

  it("is false when either side is empty (initial start / full teardown)", () => {
    expect(isFullSourceSwap([], ["a"])).toBe(false);
    expect(isFullSourceSwap(["a"], [])).toBe(false);
    expect(isFullSourceSwap([], [])).toBe(false);
  });
});

const names: Record<string, string> = {
  "kc::prod-eu": "prod-eu",
  "kc::prod-us": "prod-us",
};
const nameFor = (cid: string) => names[cid] ?? cid;

/// Container names → all-`main` `LogContainer[]`. Tests that care about init /
/// sidecar roles build their container lists explicitly.
function mains(names: string[]): LogContainer[] {
  return names.map((name) => ({ name, kind: "main" }));
}

function pod(
  clusterId: string,
  namespace: string,
  name: string,
  containers: string[] | LogContainer[],
): ObservedPod {
  return {
    clusterId,
    namespace,
    name,
    containers: containers.every((c) => typeof c === "string")
      ? mains(containers as string[])
      : (containers as LogContainer[]),
  };
}

const init = (name: string): LogContainer => ({ name, kind: "init" });
const sidecar = (name: string): LogContainer => ({ name, kind: "sidecar" });
const main = (name: string): LogContainer => ({ name, kind: "main" });

describe("containerUniverse — container kinds", () => {
  it("orders main → sidecar → init, alphabetically within each rank", () => {
    const u = containerUniverse([
      pod("kc::eu", "default", "web-0", [
        init("migrate"),
        sidecar("logship"),
        main("app"),
        init("seed"),
      ]),
    ]);
    expect(u).toEqual([
      main("app"),
      sidecar("logship"),
      init("migrate"),
      init("seed"),
    ]);
  });

  it("the liveliest kind wins when a name appears as both across pods", () => {
    // Mid-rollout: the new ReplicaSet runs `proxy` as a native sidecar while a
    // stale replica still has it as a plain init container. The mute set is
    // keyed by name, so one entry has to speak for both — and labelling a
    // streaming container "init" would be the actively misleading direction.
    const u = containerUniverse([
      pod("kc::eu", "default", "old-0", [init("proxy"), main("app")]),
      pod("kc::eu", "default", "new-0", [sidecar("proxy"), main("app")]),
    ]);
    expect(u).toEqual([main("app"), sidecar("proxy")]);
  });
});

describe("initOnlyContainerNames", () => {
  it("names containers that are init containers everywhere they appear", () => {
    expect(
      initOnlyContainerNames([
        pod("kc::eu", "default", "web-0", [
          init("migrate"),
          sidecar("logship"),
          main("app"),
        ]),
      ]),
    ).toEqual(["migrate"]);
  });

  it("excludes a name that is a live container on any pod", () => {
    expect(
      initOnlyContainerNames([
        pod("kc::eu", "default", "old-0", [init("proxy")]),
        pod("kc::eu", "default", "new-0", [sidecar("proxy")]),
      ]),
    ).toEqual([]);
  });
});

describe("buildLogSources — container kinds and rail selection", () => {
  it("carries each source's container kind through", () => {
    const { sources } = buildLogSources(
      [pod("kc::eu", "default", "web-0", [init("migrate"), main("app")])],
      () => "eu",
    );
    expect(sources.map((s) => [s.container, s.containerKind])).toEqual([
      ["migrate", "init"],
      ["app", "main"],
    ]);
  });

  it("does not append a container segment for a pod that streams only one", () => {
    // A one-container pod that merely *declares* an init container must not
    // start prefixing every line with "/app".
    const { sources } = buildLogSources(
      [pod("kc::eu", "default", "web-0", [init("migrate"), main("app")])],
      () => "eu",
      { excludedContainers: new Set(["migrate"]) },
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]!.label).toBe("web-0");
  });

  it("streams only the pods in `includedPods` when one is given", () => {
    const pods = [
      pod("kc::eu", "default", "web-0", ["app"]),
      pod("kc::eu", "default", "web-1", ["app"]),
      pod("kc::eu", "default", "web-2", ["app"]),
    ];
    const { sources, dropped } = buildLogSources(pods, () => "eu", {
      includedPods: new Set([podKey("kc::eu", "default", "web-1")]),
    });
    expect(sources.map((s) => s.pod)).toEqual(["web-1"]);
    // Unselected pods are a choice, not an overflow — they must not inflate
    // the "over cap" counter.
    expect(dropped).toBe(0);
  });

  it("an empty selection streams nothing", () => {
    const { sources } = buildLogSources(
      [pod("kc::eu", "default", "web-0", ["app"])],
      () => "eu",
      { includedPods: new Set() },
    );
    expect(sources).toEqual([]);
  });
});

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
    // Aggregated/workload sources are always the live instance — previous-log
    // viewing is a single-pod affair (issue #63).
    expect(sources[0]!.previous).toBe(false);
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

  it("stamps the chosen tail on every source and folds it into the key", () => {
    const { sources } = buildLogSources(
      [pod("kc::prod-eu", "default", "api-0", ["app"])],
      nameFor,
      { tailLines: 5000 },
    );
    expect(sources[0]!.tailLines).toBe(5000);
    expect(sources[0]!.key).toBe(
      sourceKey("kc::prod-eu", "default", "api-0", "app", false, 5000),
    );
    // Different tail ⇒ different stream identity (must restart, not reuse).
    expect(sources[0]!.key).not.toBe(
      sourceKey("kc::prod-eu", "default", "api-0", "app", false, 200),
    );
  });

  it("defaults tail to DEFAULT_TAIL_LINES when unspecified", () => {
    const { sources } = buildLogSources(
      [pod("kc::prod-eu", "default", "api-0", ["app"])],
      nameFor,
    );
    expect(sources[0]!.tailLines).toBe(DEFAULT_TAIL_LINES);
  });

  it("carries a null tail (whole history) through unchanged", () => {
    const { sources } = buildLogSources(
      [pod("kc::prod-eu", "default", "api-0", ["app"])],
      nameFor,
      { tailLines: null },
    );
    expect(sources[0]!.tailLines).toBeNull();
    expect(sources[0]!.key).toContain("all");
  });

  it("excludes a muted container across every pod", () => {
    const { sources } = buildLogSources(
      [
        pod("kc::prod-eu", "default", "web-0", ["app", "istio-proxy"]),
        pod("kc::prod-eu", "default", "web-1", ["app", "istio-proxy"]),
      ],
      nameFor,
      { excludedContainers: new Set(["istio-proxy"]) },
    );
    expect(sources.map((s) => s.container)).toEqual(["app", "app"]);
  });

  it("skips excluded containers before the cap so real ones aren't dropped", () => {
    // 24 real "app" containers + 24 noisy "sidecar" — without pre-cap
    // exclusion the sidecars would consume half the MAX_LOG_SOURCES budget and
    // drop real app streams. Excluding the sidecar must keep all apps.
    const pods = Array.from({ length: MAX_LOG_SOURCES }, (_, i) =>
      pod("kc::prod-eu", "default", `p${i}`, ["app", "sidecar"]),
    );
    const { sources, dropped } = buildLogSources(pods, nameFor, {
      excludedContainers: new Set(["sidecar"]),
    });
    expect(sources).toHaveLength(MAX_LOG_SOURCES);
    expect(sources.every((s) => s.container === "app")).toBe(true);
    expect(dropped).toBe(0);
  });

  it("returns nothing when every container is muted", () => {
    const { sources, dropped } = buildLogSources(
      [pod("kc::prod-eu", "default", "web-0", ["app", "istio-proxy"])],
      nameFor,
      { excludedContainers: new Set(["app", "istio-proxy"]) },
    );
    expect(sources).toHaveLength(0);
    expect(dropped).toBe(0);
  });
});

describe("containerUniverse", () => {
  it("returns the sorted distinct container names across pods", () => {
    const u = containerUniverse([
      pod("kc::eu", "default", "web-0", ["app", "istio-proxy"]),
      pod("kc::eu", "default", "web-1", ["app", "istio-proxy"]),
      pod("kc::eu", "default", "job-0", ["worker"]),
    ]);
    expect(u).toEqual(mains(["app", "istio-proxy", "worker"]));
  });

  it("is empty for no pods", () => {
    expect(containerUniverse([])).toEqual([]);
  });
});

describe("TAIL_OPTIONS", () => {
  it("offers the default tail and a full-history choice", () => {
    expect(TAIL_OPTIONS.some((o) => o.value === DEFAULT_TAIL_LINES)).toBe(true);
    expect(TAIL_OPTIONS.some((o) => o.value === null)).toBe(true);
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
        { ts: "10:30:00.000", text: "\u001b[31mred\u001b[0m alert", system: false, src: sources[0]!.key },
        { ts: null, text: "plain", system: false, src: sources[1]!.key },
        { ts: null, text: "— stream ended: exited", system: true, src: sources[0]!.key },
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
      [{ ts: null, text: "hello", system: false, src: single[0]!.key }],
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

describe("sourceKey", () => {
  it("distinguishes live from previous so toggling swaps the stream", () => {
    const live = sourceKey("kc::eu", "default", "api-0", "app", false);
    const prev = sourceKey("kc::eu", "default", "api-0", "app", true);
    expect(live).not.toBe(prev);
    // Defaulting the flag matches the live key (stable for existing callers).
    expect(sourceKey("kc::eu", "default", "api-0", "app")).toBe(live);
  });

  it("still separates cluster / namespace / pod / container", () => {
    const base = sourceKey("kc::eu", "default", "api-0", "app", true);
    expect(sourceKey("kc::us", "default", "api-0", "app", true)).not.toBe(base);
    expect(sourceKey("kc::eu", "kube-system", "api-0", "app", true)).not.toBe(
      base,
    );
    expect(sourceKey("kc::eu", "default", "api-1", "app", true)).not.toBe(base);
    expect(sourceKey("kc::eu", "default", "api-0", "sidecar", true)).not.toBe(
      base,
    );
  });
});
