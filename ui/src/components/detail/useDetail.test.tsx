import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDetail } from "./useDetail";

// A promise we resolve/reject by hand, so a test can interleave two in-flight
// fetches and control which one lands first.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useDetail", () => {
  it("starts loading, then resolves to ready with the fetched detail", async () => {
    const d = deferred<string>();
    const { result } = renderHook(() => useDetail(() => d.promise, [1]));

    expect(result.current).toEqual({ kind: "loading" });

    await act(async () => {
      d.resolve("payload");
      await d.promise;
    });
    expect(result.current).toEqual({ kind: "ready", detail: "payload" });
  });

  it("surfaces a rejection as an error state carrying the message", async () => {
    const d = deferred<string>();
    const { result } = renderHook(() => useDetail(() => d.promise, [1]));

    await act(async () => {
      d.reject(new Error("boom"));
      await d.promise.catch(() => {});
    });
    expect(result.current).toEqual({ kind: "error", message: "Error: boom" });
  });

  it("does NOT flip back to loading on a dep change — keeps prior detail until the refetch lands", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const { result, rerender } = renderHook(
      ({ fetcher, deps }: { fetcher: () => Promise<string>; deps: number[] }) =>
        useDetail(fetcher, deps),
      { initialProps: { fetcher: () => first.promise, deps: [1] } },
    );

    await act(async () => {
      first.resolve("A");
      await first.promise;
    });
    expect(result.current).toEqual({ kind: "ready", detail: "A" });

    // Dep change triggers a refetch whose promise is still pending. The panel
    // must keep showing "A" rather than collapsing to a spinner (R-01).
    rerender({ fetcher: () => second.promise, deps: [2] });
    expect(result.current).toEqual({ kind: "ready", detail: "A" });

    await act(async () => {
      second.resolve("B");
      await second.promise;
    });
    expect(result.current).toEqual({ kind: "ready", detail: "B" });
  });

  it("drops a stale fetch that resolves after a newer one (request-id guard)", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    const { result, rerender } = renderHook(
      ({ fetcher, deps }: { fetcher: () => Promise<string>; deps: number[] }) =>
        useDetail(fetcher, deps),
      { initialProps: { fetcher: () => slow.promise, deps: [1] } },
    );

    // Second fetch (fast) supersedes the first (slow) before either resolves.
    rerender({ fetcher: () => fast.promise, deps: [2] });

    await act(async () => {
      fast.resolve("second");
      await fast.promise;
    });
    expect(result.current).toEqual({ kind: "ready", detail: "second" });

    // The slow first fetch resolves late — its request id is stale, so it must
    // NOT clobber the newer result.
    await act(async () => {
      slow.resolve("first");
      await slow.promise;
    });
    expect(result.current).toEqual({ kind: "ready", detail: "second" });
  });
});
