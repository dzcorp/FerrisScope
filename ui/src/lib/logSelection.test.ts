// Source-rail selection maths. The behaviour that matters: the default has to
// be useful without any interaction, and pod-set churn must never evict a pod
// the operator explicitly chose to read.

import { describe, it, expect } from "vitest";
import {
  defaultSelection,
  filterPods,
  reconcileSelection,
  selectablePods,
  selectionStreamCount,
  type SelectablePod,
} from "./logSelection";
import { podKey, type ObservedPod } from "./logSources";
import type { LogContainer } from "../types";

const mains = (names: string[]): LogContainer[] =>
  names.map((name) => ({ name, kind: "main" }));

function pod(name: string, containers: string[] = ["app"]): ObservedPod {
  return {
    clusterId: "cl1",
    namespace: "default",
    name,
    containers: mains(containers),
  };
}

function row(name: string, streamCount: number): SelectablePod {
  return {
    key: podKey("cl1", "default", name),
    clusterId: "cl1",
    namespace: "default",
    name,
    streamCount,
  };
}

describe("selectablePods", () => {
  it("counts only the containers that aren't muted", () => {
    const rows = selectablePods(
      [pod("web-0", ["app", "istio-proxy"]), pod("web-1", ["app"])],
      new Set(["istio-proxy"]),
    );
    expect(rows.map((r) => r.streamCount)).toEqual([1, 1]);
  });

  it("reports zero for a pod whose every container is muted", () => {
    const rows = selectablePods([pod("web-0", ["app"])], new Set(["app"]));
    expect(rows[0]!.streamCount).toBe(0);
  });
});

describe("defaultSelection", () => {
  it("fills the budget in order", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`p${i}`, 1));
    expect(defaultSelection(rows, 4).size).toBe(4);
    expect([...defaultSelection(rows, 4)]).toEqual(
      rows.slice(0, 4).map((r) => r.key),
    );
  });

  it("never takes a pod partially", () => {
    // A 3-stream pod that doesn't fit is skipped whole — showing one container
    // of a three-container pod with no hint the others were dropped is worse
    // than not showing the pod.
    const rows = [row("big", 3), row("small", 1)];
    const sel = defaultSelection(rows, 2);
    expect(sel.has(rows[0]!.key)).toBe(false);
    expect(sel.has(rows[1]!.key)).toBe(true);
  });

  it("keeps walking past a pod that didn't fit", () => {
    const rows = [row("big", 5), row("a", 1), row("b", 1)];
    expect(defaultSelection(rows, 2).size).toBe(2);
  });

  it("selects fully-muted pods, which cost nothing", () => {
    // Otherwise un-muting a container would leave the pod mysteriously absent.
    const rows = [row("muted", 0), row("live", 1)];
    expect(defaultSelection(rows, 1).size).toBe(2);
  });
});

describe("selectionStreamCount", () => {
  it("sums only the selected pods", () => {
    const rows = [row("a", 2), row("b", 3), row("c", 1)];
    const sel = new Set([rows[0]!.key, rows[2]!.key]);
    expect(selectionStreamCount(rows, sel)).toBe(3);
  });
});

describe("reconcileSelection", () => {
  it("drops pods that no longer exist", () => {
    const before = [row("a", 1), row("b", 1)];
    const sel = new Set(before.map((r) => r.key));
    const after = [before[0]!];
    const next = reconcileSelection(after, sel, new Set(), 24);
    expect([...next]).toEqual([before[0]!.key]);
  });

  it("adds newly-appeared pods when they fit", () => {
    const rows = [row("a", 1), row("b", 1)];
    const next = reconcileSelection(
      rows,
      new Set([rows[0]!.key]),
      new Set([rows[1]!.key]),
      24,
    );
    expect(next.size).toBe(2);
  });

  it("does not resurrect a pod the operator deselected", () => {
    // Muting a noisy sidecar frees budget. That must not silently re-select
    // every pod the operator had just turned off — a pod is offered once, when
    // it first appears, and after that its state belongs to the operator.
    const rows = [row("a", 1), row("b", 1)];
    const sel = new Set([rows[0]!.key]);
    // `b` is not fresh — it has been seen before and was deselected.
    expect(reconcileSelection(rows, sel, new Set(), 24)).toBe(sel);
  });

  it("never evicts a selected pod to make room for a new one", () => {
    // A rollout adding replicas must not yank the log someone is reading.
    const rows = [row("a", 1), row("b", 1), row("c", 1)];
    const sel = new Set([rows[0]!.key, rows[1]!.key]);
    const next = reconcileSelection(rows, sel, new Set([rows[2]!.key]), 2);
    expect(next.has(rows[0]!.key)).toBe(true);
    expect(next.has(rows[1]!.key)).toBe(true);
    expect(next.has(rows[2]!.key)).toBe(false);
  });

  it("returns the same set instance when nothing changed", () => {
    // Pod watches fire on every status heartbeat; an identity-stable return
    // lets the React caller skip the state update entirely.
    const rows = [row("a", 1)];
    const sel = new Set([rows[0]!.key]);
    expect(reconcileSelection(rows, sel, new Set(), 24)).toBe(sel);
  });

  it("still admits fully-muted new pods over budget", () => {
    const rows = [row("a", 24), row("muted", 0)];
    const next = reconcileSelection(
      rows,
      new Set([rows[0]!.key]),
      new Set([rows[1]!.key]),
      24,
    );
    expect(next.has(rows[1]!.key)).toBe(true);
  });
});

describe("filterPods", () => {
  it("matches name or namespace, case-insensitively", () => {
    const rows = [row("web-0", 1), row("api-0", 1)];
    expect(filterPods(rows, "WEB").map((r) => r.name)).toEqual(["web-0"]);
    expect(filterPods(rows, "default")).toHaveLength(2);
  });

  it("an empty or whitespace query matches everything", () => {
    const rows = [row("web-0", 1)];
    expect(filterPods(rows, "")).toEqual(rows);
    expect(filterPods(rows, "   ")).toEqual(rows);
  });
});
