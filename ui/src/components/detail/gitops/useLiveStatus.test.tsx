import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useLiveStatus, LIVE_STATUS_MIN_INTERVAL_MS } from "./useLiveStatus";
import { resetMockInvoke, setMockInvoke } from "../../../test/tauri-mock";
import type { GitOpsResource } from "../../../types";

const res = (name: string, local = true): GitOpsResource => ({
  group: "apps", kind: "Deployment", namespace: "prod", name, local, sync: null, health: null, message: null, prune: false,
});

afterEach(() => {
  resetMockInvoke();
  vi.useRealTimers();
});

describe("useLiveStatus", () => {
  it("throttles refetches of an unchanged set and refetches when the set changes", async () => {
    const calls: unknown[] = [];
    setMockInvoke((cmd, args) => {
      if (cmd !== "resolve_object_statuses_cmd") throw new Error(cmd);
      calls.push(args);
      return { items: [], truncated: false };
    });
    const { rerender } = renderHook(({ r }) => useLiveStatus("ctx", r), { initialProps: { r: [res("a"), res("remote", false)] } });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0] as { refs: unknown[] }).refs).toHaveLength(1);
    rerender({ r: [res("a"), res("remote", false)] });
    rerender({ r: [res("a"), res("remote", false)] });
    expect(calls).toHaveLength(1);
    rerender({ r: [res("a"), res("b")] });
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it("refreshes an unchanged set after the minimum interval", async () => {
    const calls: unknown[] = [];
    setMockInvoke(() => {
      calls.push(1);
      return { items: [], truncated: false };
    });
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const { rerender } = renderHook(({ r }) => useLiveStatus("ctx", r), { initialProps: { r: [res("a")] } });
    await waitFor(() => expect(calls).toHaveLength(1));
    now.mockReturnValue(1_000 + LIVE_STATUS_MIN_INTERVAL_MS + 1);
    rerender({ r: [res("a")] });
    await waitFor(() => expect(calls).toHaveLength(2));
    now.mockRestore();
  });

  it("skips the call when nothing is local", async () => {
    const spy = vi.fn();
    setMockInvoke(spy);
    const { result } = renderHook(() => useLiveStatus("ctx", [res("x", false)]));
    expect(result.current.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
});
