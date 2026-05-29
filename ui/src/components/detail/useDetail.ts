import { useEffect, useRef, useState } from "react";

// Canonical load-state + fetch hook shared by every kind's detail summary.
//
// Before this lived here, each summary family (workload, network, storage,
// rbac, cluster, config, extended, gateway) carried a byte-identical copy of
// both `LoadState<T>` and `useDetail<T>`. They are kind-agnostic — the summary
// owns the typed `fetcher` and the `deps` that retrigger it (clusterId, name,
// namespace, and a local refetch / `detailVersion` counter) — so there is no
// reason for N copies. See CLAUDE.md §"Detail-panel primitives".

export type LoadState<T> =
  | { kind: "loading" }
  | { kind: "ready"; detail: T }
  | { kind: "error"; message: string };

/// Fetch `fetcher()` on mount and whenever `deps` change, exposing a three-way
/// load state. Two deliberate behaviours every detail panel relies on:
///
/// 1. **No spinner on refetch (R-01).** A dep change (poll, save,
///    cordon/drain, force-takeover, `detailVersion` bump) does NOT flip back
///    to `loading`; the previous `detail` stays on screen until the new fetch
///    resolves. Otherwise the panel collapses to a one-line spinner, its
///    scroll-container height drops to zero, and the browser snaps to
///    scroll-top after every action.
/// 2. **Stale-response guard.** A monotonic request id means an earlier,
///    slower fetch that resolves after a newer one cannot clobber the fresher
///    result (or a result for a since-changed dep set).
export function useDetail<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ kind: "loading" });
  const reqId = useRef(0);
  useEffect(() => {
    const id = ++reqId.current;
    fetcher()
      .then((detail) => {
        if (reqId.current === id) setState({ kind: "ready", detail });
      })
      .catch((e: unknown) => {
        if (reqId.current === id)
          setState({ kind: "error", message: String(e) });
      });
    // The caller owns the dependency list — it knows which inputs (ids, name,
    // namespace, refetch counter) should retrigger the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}
