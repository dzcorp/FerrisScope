import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { setMockInvoke } from "../test/tauri-mock";
import type { AccessDecision } from "../types";
import {
  allGates,
  anyGate,
  decidedGate,
  gateOf,
  gatedTitle,
  invalidateAccess,
  requestAccess,
  readDecision,
  resetAccessCache,
  revalidateAccess,
  useAccessChecks,
  useKindAccess,
  useScopesAccess,
} from "./access";

type Call = { cmd: string; args: Record<string, unknown> | undefined };

function mockDecisions(decide: (req: { action: string; namespace?: string | null }) => AccessDecision) {
  const calls: Call[] = [];
  setMockInvoke((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "access_check_cmd") {
      const reqs = (args?.requests ?? []) as { action: string; namespace?: string | null }[];
      return reqs.map(decide);
    }
    return undefined;
  });
  return calls;
}

const denied = (reason: string): AccessDecision => ({ state: "denied", reason });
const allowed: AccessDecision = { state: "allowed" };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetAccessCache();
});

describe("gates", () => {
  it("only an explicit denial closes a gate", () => {
    expect(gateOf(null)).toEqual({ allowed: true, reason: null, pending: true, error: null });
    expect(gateOf(allowed).allowed).toBe(true);
    expect(gateOf({ state: "unknown", error: "x" })).toEqual({
      allowed: true,
      reason: null,
      pending: false,
      error: "x",
    });
    expect(gateOf(denied("cannot delete pods in a"))).toEqual({
      allowed: false,
      reason: "Not permitted: cannot delete pods in a",
      pending: false,
      error: null,
    });
  });

  it("anyGate opens if one member does; allGates closes if one member does", () => {
    const no = gateOf(denied("x"));
    const yes = gateOf(allowed);
    expect(anyGate([no, yes]).allowed).toBe(true);
    expect(anyGate([no, no]).reason).toBe("Not permitted: x");
    expect(allGates([yes, no]).allowed).toBe(false);
    expect(allGates([]).allowed).toBe(true);
  });

  it("decidedGate lets a denial outweigh members that couldn't answer", () => {
    const off = gateOf({ state: "unknown", error: "cluster not connected" });
    const no = gateOf(denied("x"));
    const yes = gateOf(allowed);
    expect(decidedGate([off, no])).toBe(no);
    expect(decidedGate([off, no, yes])).toBe(yes);
    expect(decidedGate([off]).allowed).toBe(true);
  });

  it("gatedTitle appends the reason only when denied", () => {
    expect(gatedTitle("Delete", gateOf(allowed))).toBe("Delete");
    expect(gatedTitle("Delete", gateOf(denied("y")))).toBe("Delete — Not permitted: y");
  });
});

describe("batching and caching", () => {
  it("sends one call's checks as one invoke per cluster", async () => {
    const calls = mockDecisions(() => allowed);
    requestAccess([
      { clusterId: "a", kindId: "pods", action: "delete", namespace: "x" },
      { clusterId: "a", kindId: "pods", action: "exec", namespace: "x", name: "p" },
      { clusterId: "b", kindId: "nodes", action: "cordon" },
    ]);
    await flush();
    expect(calls.map((c) => c.cmd)).toEqual(["access_check_cmd", "access_check_cmd"]);
    expect(calls[0]?.args).toEqual({
      clusterId: "a",
      requests: [
        { kindId: "pods", action: "delete", namespace: "x", name: null },
        { kindId: "pods", action: "exec", namespace: "x", name: "p" },
      ],
    });
    // Cached: asking again is free.
    requestAccess([{ clusterId: "a", kindId: "pods", action: "delete", namespace: "x" }]);
    await flush();
    expect(calls).toHaveLength(2);
  });

  it("a failed call answers unknown, which stays open", async () => {
    setMockInvoke(() => {
      throw new Error("boom");
    });
    const check = { clusterId: "a", kindId: "pods", action: "delete" as const };
    requestAccess([check]);
    await flush();
    expect(readDecision(check)?.state).toBe("unknown");
    expect(gateOf(readDecision(check)).allowed).toBe(true);
  });

  it("invalidate drops one cluster's answers and tells Rust", async () => {
    const calls = mockDecisions(() => allowed);
    const a = { clusterId: "a", kindId: "pods", action: "list" as const };
    const b = { clusterId: "b", kindId: "pods", action: "list" as const };
    requestAccess([a, b]);
    await flush();
    act(() => invalidateAccess("a"));
    expect(readDecision(a)).toBeNull();
    expect(readDecision(b)).not.toBeNull();
    expect(calls.at(-1)).toEqual({ cmd: "access_invalidate_cmd", args: { clusterId: "a" } });
  });
});

describe("ordering and isolation", () => {
  it("separate callers get separate invokes, so one never waits on another", async () => {
    const calls = mockDecisions(() => allowed);
    requestAccess([{ clusterId: "a", kindId: "pods", action: "list" }]);
    requestAccess([{ clusterId: "a", kindId: "nodes", action: "list" }]);
    await flush();
    expect(calls.filter((c) => c.cmd === "access_check_cmd")).toHaveLength(2);
  });

  it("checks after an invalidate wait for the backend to forget", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    setMockInvoke((cmd, args) => {
      order.push(cmd);
      if (cmd === "access_invalidate_cmd") return new Promise<void>((r) => (release = r));
      return ((args?.requests ?? []) as unknown[]).map(() => allowed);
    });
    const check = { clusterId: "a", kindId: "pods", action: "list" as const };
    invalidateAccess("a");
    requestAccess([check]);
    await flush();
    expect(order).toEqual(["access_invalidate_cmd"]);
    release();
    await waitFor(() => expect(readDecision(check)?.state).toBe("allowed"));
    expect(order).toEqual(["access_invalidate_cmd", "access_check_cmd"]);
  });

  it("an answer that predates an invalidate is dropped", async () => {
    let answer: (d: AccessDecision[]) => void = () => {};
    setMockInvoke((cmd) =>
      cmd === "access_check_cmd" ? new Promise<AccessDecision[]>((r) => (answer = r)) : undefined,
    );
    const check = { clusterId: "a", kindId: "pods", action: "delete" as const };
    requestAccess([check]);
    await flush();
    invalidateAccess("a");
    answer([denied("old")]);
    await flush();
    expect(readDecision(check)).toBeNull();
  });

  it("revalidate keeps old answers visible while re-asking", async () => {
    const calls = mockDecisions(() => denied("no"));
    const check = { clusterId: "a", kindId: "pods", action: "delete" as const };
    const { result } = renderHook(() => useAccessChecks([check]));
    await waitFor(() => expect(result.current[0]?.allowed).toBe(false));
    act(() => revalidateAccess("a"));
    expect(result.current[0]?.allowed).toBe(false);
    await flush();
    expect(calls.filter((c) => c.cmd === "access_check_cmd")).toHaveLength(2);
    expect(calls.some((c) => c.cmd === "access_invalidate_cmd")).toBe(false);
  });

  it("an unknown answer is re-asked sooner than a decision", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    let n = 0;
    setMockInvoke(() => (n++ === 0 ? [{ state: "unknown", error: "timeout" }] : [allowed]));
    const check = { clusterId: "a", kindId: "pods", action: "list" as const };
    requestAccess([check]);
    await flush();
    now.mockReturnValue(1_000 + 11_000);
    requestAccess([check]);
    await flush();
    expect(readDecision(check)?.state).toBe("allowed");
    now.mockReturnValue(1_000 + 22_000);
    requestAccess([check]);
    await flush();
    expect(n).toBe(2);
    now.mockRestore();
  });
});

describe("hooks", () => {
  it("an answer for someone else doesn't re-render a hook", async () => {
    mockDecisions(() => allowed);
    let renders = 0;
    const mine = [{ clusterId: "a", kindId: "pods", action: "list" as const }];
    renderHook(() => {
      renders += 1;
      return useAccessChecks(mine);
    });
    await flush();
    await flush();
    const settled = renders;
    requestAccess([{ clusterId: "a", kindId: "nodes", action: "list" }]);
    await flush();
    await flush();
    expect(renders).toBe(settled);
  });

  it("the sweep re-asks every mounted hook's stale answers together, and stops with the last hook", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const calls = mockDecisions(() => allowed);
      const a = [{ clusterId: "a", kindId: "pods", action: "list" as const }];
      const b = [{ clusterId: "a", kindId: "nodes", action: "list" as const }];
      const one = renderHook(() => useAccessChecks(a));
      const two = renderHook(() => useAccessChecks(b));
      await flush();
      const before = calls.length;
      vi.advanceTimersByTime(60_000);
      await flush();
      expect(calls.length).toBe(before);
      vi.advanceTimersByTime(70_000);
      await flush();
      const after = calls.slice(before).map((c) => (c.args?.requests as unknown[]).length);
      expect(after).toEqual([2]);
      one.unmount();
      two.unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an answer asked before a reconnect lands stale and is asked again", async () => {
    const answers: ((d: AccessDecision[]) => void)[] = [];
    setMockInvoke((cmd) =>
      cmd === "access_check_cmd" ? new Promise<AccessDecision[]>((r) => answers.push(r)) : undefined,
    );
    const check = [{ clusterId: "a", kindId: "pods", action: "delete" as const }];
    const { result } = renderHook(() => useAccessChecks(check));
    await flush();
    act(() => revalidateAccess("a"));
    await act(async () => {
      answers[0]?.([denied("old identity")]);
      await flush();
    });
    // Shown meanwhile, but not trusted.
    expect(result.current[0]?.allowed).toBe(false);
    expect(answers).toHaveLength(2);
    await act(async () => {
      answers[1]?.([allowed]);
      await flush();
    });
    expect(result.current[0]?.allowed).toBe(true);
  });

  it("an answer from before a reset is dropped", async () => {
    let answer: (d: AccessDecision[]) => void = () => {};
    setMockInvoke((cmd) =>
      cmd === "access_check_cmd" ? new Promise<AccessDecision[]>((r) => (answer = r)) : undefined,
    );
    const check = { clusterId: "a", kindId: "pods", action: "delete" as const };
    requestAccess([check]);
    await flush();
    resetAccessCache();
    answer([denied("old")]);
    await flush();
    expect(readDecision(check)).toBeNull();
  });

  it("past the scope cap a denial reads as unchecked, not denied", async () => {
    mockDecisions(() => denied("no"));
    const scopes = Array.from({ length: 60 }, (_, i) => ({ clusterId: "a", namespace: `ns-${i}` }));
    const { result } = renderHook(() => useScopesAccess("pods", scopes, ["delete"] as const));
    await waitFor(() => expect(result.current.delete.error).toMatch(/not checked/));
    expect(result.current.delete.allowed).toBe(true);
  });

  it("useKindAccess starts pending/open, then reflects the answer", async () => {
    mockDecisions((r) => (r.action === "delete" ? denied("cannot delete pods in x") : allowed));
    const { result } = renderHook(() =>
      useKindAccess("a", "pods", ["delete", "exec"] as const, { namespace: "x" }),
    );
    expect(result.current.delete.pending).toBe(true);
    expect(result.current.delete.allowed).toBe(true);
    await waitFor(() => expect(result.current.delete.allowed).toBe(false));
    expect(result.current.delete.reason).toBe("Not permitted: cannot delete pods in x");
    expect(result.current.exec.allowed).toBe(true);
  });

  it("no cluster → every gate open, no call", async () => {
    const calls = mockDecisions(() => denied("x"));
    const { result } = renderHook(() => useKindAccess(null, "pods", ["delete"] as const));
    await flush();
    expect(result.current.delete.allowed).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("useAccessChecks re-renders every subscriber when answers land", async () => {
    mockDecisions(() => denied("no"));
    const check = [{ clusterId: "a", kindId: "secrets", action: "list" as const }];
    const one = renderHook(() => useAccessChecks(check));
    const two = renderHook(() => useAccessChecks(check));
    await waitFor(() => expect(one.result.current[0]?.allowed).toBe(false));
    expect(two.result.current[0]?.allowed).toBe(false);
  });
});
