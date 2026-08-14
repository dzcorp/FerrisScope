// CommandPalette search behaviour: fan-out across every active cluster,
// per-cluster hit badges, dead-kind-id filtering, the failure indicator for
// unreachable members, and cluster-aware navigation on Enter.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { useAppStore } from "../store";
import { CommandPalette } from "./CommandPalette";
import type { ContextInfo, ResourceKind, SearchHit } from "../types";

const ctxEu: ContextInfo = {
  id: "kc::prod-eu",
  name: "prod-eu",
  cluster: "prod-eu",
  user: null,
  namespace: null,
  is_current: false,
  group: "",
  source_id: "kc",
  source_path: null,
};
const ctxUs: ContextInfo = {
  ...ctxEu,
  id: "kc::prod-us",
  name: "prod-us",
  cluster: "prod-us",
};

const podsKind: ResourceKind = {
  id: "pods",
  group: "",
  version: "v1",
  kind: "Pod",
  plural: "pods",
  namespaced: true,
  category: "Workloads",
  columns: [],
};

function hit(partial: Partial<SearchHit>): SearchHit {
  return {
    kind_id: "pods",
    uid: "u1",
    namespace: "default",
    name: "api-0",
    score: -5,
    ...partial,
  };
}

const initial = useAppStore.getState();

beforeEach(() => {
  // jsdom has no scrollIntoView; the palette calls it on highlight moves.
  Element.prototype.scrollIntoView = vi.fn();
  vi.useFakeTimers();
  act(() => {
    useAppStore.setState({
      contexts: [ctxEu, ctxUs],
      kinds: [podsKind],
      selectedContext: ctxEu.id,
      // Ad-hoc multi-cluster scope: eu (selected) + us (extra).
      scopeExtras: [ctxUs.id],
    });
  });
});

afterEach(() => {
  cleanup();
  resetMockInvoke();
  vi.useRealTimers();
  act(() => {
    useAppStore.setState({
      ...initial,
      contexts: [],
      kinds: [],
      selectedContext: null,
      scopeExtras: [],
      pendingDetail: null,
      detailHistory: [],
      detailIndex: -1,
    });
  });
});

/// Type a query and let the 100 ms debounce + the search promises settle.
async function typeQuery(input: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.change(input, { target: { value } });
  });
  await act(async () => {
    vi.advanceTimersByTime(150);
  });
  await act(async () => {});
}

describe("CommandPalette search", () => {
  it("fans out to every active cluster and badges hits by origin", async () => {
    const searched: string[] = [];
    setMockInvoke((cmd, args) => {
      if (cmd !== "search_cluster_index") return undefined;
      const cid = String(args?.clusterId ?? "");
      searched.push(cid);
      return cid === ctxEu.id
        ? [hit({ uid: "e1", name: "api-eu", score: -9 })]
        : [hit({ uid: "s1", name: "api-us", score: -3 })];
    });
    const utils = render(<CommandPalette mode="dark" onClose={() => {}} />);
    await typeQuery(utils.getByPlaceholderText(/Search across 2 clusters/), "api");

    expect(searched.sort()).toEqual([ctxEu.id, ctxUs.id]);
    // Better (more negative) score first, each row badged with its cluster.
    expect(utils.getByText("api-eu")).toBeInTheDocument();
    expect(utils.getByText("api-us")).toBeInTheDocument();
    expect(utils.getByText(/Pod · ns:default · prod-eu/)).toBeInTheDocument();
    expect(utils.getByText(/Pod · ns:default · prod-us/)).toBeInTheDocument();
  });

  it("drops hits whose kind id no longer resolves to a known kind", async () => {
    setMockInvoke((cmd) =>
      cmd === "search_cluster_index"
        ? [
            hit({ uid: "ok", name: "live-pod" }),
            // Stale CRD id from before a version bump — navigating to it
            // would silently no-op, so the palette must not offer it.
            hit({
              uid: "dead",
              name: "old-route",
              kind_id: "wkcrd:httproute|gateway.networking.k8s.io|v1beta1|httproutes|HTTPRoute|ns",
            }),
          ]
        : undefined,
    );
    const utils = render(<CommandPalette mode="dark" onClose={() => {}} />);
    await typeQuery(utils.getByPlaceholderText(/Search across/), "route");

    expect(utils.getAllByText("live-pod").length).toBeGreaterThan(0);
    expect(utils.queryByText("old-route")).toBeNull();
  });

  it("names members whose search call failed instead of swallowing them", async () => {
    setMockInvoke((cmd, args) => {
      if (cmd !== "search_cluster_index") return undefined;
      if (String(args?.clusterId) === ctxUs.id) {
        throw new Error("index unavailable");
      }
      return [hit({})];
    });
    const utils = render(<CommandPalette mode="dark" onClose={() => {}} />);
    await typeQuery(utils.getByPlaceholderText(/Search across/), "api");

    expect(utils.getByText(/search unavailable on prod-us/)).toBeInTheDocument();
    // The healthy member's hits still render.
    expect(utils.getByText("api-0")).toBeInTheDocument();
  });

  it("Enter on a hit navigates with the hit's origin cluster", async () => {
    setMockInvoke((cmd, args) =>
      cmd === "search_cluster_index" && String(args?.clusterId) === ctxUs.id
        ? [hit({ uid: "s1", name: "api-us" })]
        : cmd === "search_cluster_index"
          ? []
          : undefined,
    );
    const onClose = vi.fn();
    const utils = render(<CommandPalette mode="dark" onClose={onClose} />);
    const input = utils.getByPlaceholderText(/Search across/);
    await typeQuery(input, "api-us");

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    const s = useAppStore.getState();
    expect(s.selectedKindId).toBe("pods");
    expect(s.pendingDetail).toMatchObject({
      clusterId: ctxUs.id,
      kindId: "pods",
      namespace: "default",
      name: "api-us",
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("CommandPalette short cluster names", () => {
  const GKE = "gke_production-4f83b34d_us-central1_prod-6";
  const gkeCtx: ContextInfo = {
    ...ctxEu,
    id: `kc::${GKE}`,
    name: GKE,
    cluster: GKE,
    group: "Default",
  };

  const withGkeFleet = () =>
    act(() => {
      useAppStore.setState({
        contexts: [gkeCtx],
        selectedContext: null,
        scopeExtras: [],
      });
    });

  it("lists the switch-context row under its short name", async () => {
    withGkeFleet();
    setMockInvoke(() => undefined);
    const utils = render(<CommandPalette mode="dark" onClose={() => {}} />);
    await typeQuery(utils.getByPlaceholderText(/Search/), "prod-6");
    expect(utils.getByText("prod-6")).toBeInTheDocument();
    expect(utils.queryByText(GKE)).toBeNull();
  });

  it("still matches when the operator types the full context name", async () => {
    withGkeFleet();
    setMockInvoke(() => undefined);
    const utils = render(<CommandPalette mode="dark" onClose={() => {}} />);
    // Muscle memory: the full name is still in the keyword index even though
    // the row renders short.
    await typeQuery(utils.getByPlaceholderText(/Search/), "gke_production-4f8");
    expect(utils.getByText("prod-6")).toBeInTheDocument();
  });

  it("shows the stripped coordinate on the row's sub line", async () => {
    withGkeFleet();
    setMockInvoke(() => undefined);
    const utils = render(<CommandPalette mode="dark" onClose={() => {}} />);
    await typeQuery(utils.getByPlaceholderText(/Search/), "prod-6");
    expect(
      utils.getByText(/Default · production-4f83b34d · us-central1/),
    ).toBeInTheDocument();
  });
});
