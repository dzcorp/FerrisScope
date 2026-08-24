import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetMockInvoke, setMockInvoke } from "../../test/tauri-mock";
import { emitMock, resetEventMock } from "../../test/tauri-event-mock";
import { PodListSection } from "./podList";
import { tokens } from "../../theme";
import type { ResourceRow } from "../../types";

afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetEventMock();
});

const POD: ResourceRow = {
  uid: "pod-1",
  namespace: "production",
  name: "web-7d9f-abc",
  phase: "Running",
  ready: "1/1",
  restarts: 0,
  node: "worker-1",
  creation_timestamp: "2026-08-24T09:00:00Z",
  __labels: { app: "web" },
};

/// Deltas for the cluster-wide pods watcher land on this channel — see
/// `resource_event_name` on the backend.
const PODS_CHANNEL = "resource://ctx/pods/all";

function renderList(
  overrides: Partial<React.ComponentProps<typeof PodListSection>> = {},
  pods: ResourceRow[] = [POD],
) {
  setMockInvoke((cmd) => {
    if (cmd === "subscribe_resource") return { rows: [], init_done: true };
    if (cmd === "unsubscribe_resource") return undefined;
    throw new Error(`unexpected command: ${cmd}`);
  });
  const onNavigate = vi.fn();
  const props = {
    t: tokens("dark"),
    mode: "dark" as const,
    clusterId: "ctx",
    fetchPods: () => Promise.resolve(pods),
    acceptsDelta: () => true,
    subjectKey: "deployments/production/web",
    refetchKey: 0,
    emptyLabel: "No pods match this Deployment's selector.",
    showNode: true,
    onNavigate,
    ...overrides,
  } as React.ComponentProps<typeof PodListSection>;
  return { onNavigate, props };
}

async function mount(
  overrides: Partial<React.ComponentProps<typeof PodListSection>> = {},
  pods: ResourceRow[] = [POD],
) {
  const { onNavigate, props } = renderList(overrides, pods);
  await act(async () => {
    render(<PodListSection {...props} />);
  });
  return { onNavigate };
}

describe("PodListSection", () => {
  it("renders the fetched pods with a total count", async () => {
    await mount();
    expect(await screen.findByText("web-7d9f-abc")).toBeInTheDocument();
    expect(screen.getByText("1 total")).toBeInTheDocument();
  });

  it("navigates to the pod detail by Kind name, not registry id", async () => {
    const { onNavigate } = await mount();
    (await screen.findByText("web-7d9f-abc")).click();
    expect(onNavigate).toHaveBeenCalledWith("Pod", "production", "web-7d9f-abc");
  });

  // The node is cluster-scoped, so the namespace argument must be null —
  // passing the pod's namespace would resolve to nothing.
  it("navigates to the node detail with a null namespace", async () => {
    const { onNavigate } = await mount();
    (await screen.findByText("worker-1")).click();
    expect(onNavigate).toHaveBeenCalledWith("Node", null, "worker-1");
  });

  it("omits the node column when showNode is off", async () => {
    await mount({ showNode: false });
    expect(await screen.findByText("web-7d9f-abc")).toBeInTheDocument();
    expect(screen.queryByText("worker-1")).not.toBeInTheDocument();
  });

  // A Pending pod has no node yet; a link would read as a real one.
  it("renders a placeholder instead of a dead link for an unscheduled pod", async () => {
    const { onNavigate } = await mount({}, [
      { ...POD, phase: "Pending", node: null },
    ]);
    expect(await screen.findByText("web-7d9f-abc")).toBeInTheDocument();
    expect(screen.queryByText("worker-1")).not.toBeInTheDocument();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("shows the caller's empty label when nothing matches", async () => {
    await mount({}, []);
    expect(
      await screen.findByText("No pods match this Deployment's selector."),
    ).toBeInTheDocument();
  });

  it("surfaces a failed initial fetch", async () => {
    await mount({ fetchPods: () => Promise.reject(new Error("boom")) });
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });

  it("hides the Evict button unless the caller enables it", async () => {
    await mount();
    expect(await screen.findByText("web-7d9f-abc")).toBeInTheDocument();
    expect(screen.queryByText("Evict")).not.toBeInTheDocument();
  });

  describe("live deltas", () => {
    it("folds in an accepted pod without a refetch", async () => {
      await mount();
      await screen.findByText("web-7d9f-abc");
      await act(async () => {
        emitMock(PODS_CHANNEL, [
          { kind: "upsert", row: { ...POD, uid: "pod-2", name: "web-7d9f-def" } },
        ]);
      });
      expect(screen.getByText("web-7d9f-def")).toBeInTheDocument();
      expect(screen.getByText("2 total")).toBeInTheDocument();
    });

    it("drops a pod the predicate stops accepting", async () => {
      await mount({ acceptsDelta: (row) => row.uid !== "pod-1" });
      await screen.findByText("web-7d9f-abc");
      await act(async () => {
        emitMock(PODS_CHANNEL, [{ kind: "upsert", row: POD }]);
      });
      expect(screen.queryByText("web-7d9f-abc")).not.toBeInTheDocument();
    });

    it("removes a deleted pod", async () => {
      await mount();
      await screen.findByText("web-7d9f-abc");
      await act(async () => {
        emitMock(PODS_CHANNEL, [{ kind: "delete", uid: "pod-1" }]);
      });
      expect(screen.queryByText("web-7d9f-abc")).not.toBeInTheDocument();
      expect(screen.getByText("0 total")).toBeInTheDocument();
    });

    // The predicate sees the uids the last fetch vouched for, which is how a
    // caller with an unevaluable matchExpressions selector stays honest.
    it("passes the fetched uids to the predicate as `known`", async () => {
      const seen: ReadonlySet<string>[] = [];
      const acceptsDelta = (_row: ResourceRow, known: ReadonlySet<string>) => {
        seen.push(known);
        return true;
      };
      await mount({ acceptsDelta });
      await screen.findByText("web-7d9f-abc");
      await act(async () => {
        emitMock(PODS_CHANNEL, [
          { kind: "upsert", row: { ...POD, uid: "pod-9" } },
        ]);
      });
      const known = seen.at(-1);
      expect(known?.has("pod-1")).toBe(true);
      expect(known?.has("pod-9")).toBe(false);
    });
  });
});

describe("PodListSection subject + refetch keys", () => {
  const BASE = {
    t: tokens("dark"),
    mode: "dark" as const,
    clusterId: "ctx",
    acceptsDelta: () => true,
    emptyLabel: "none",
    showNode: true,
  };

  function stubInvoke() {
    setMockInvoke((cmd) => {
      if (cmd === "subscribe_resource") return { rows: [], init_done: true };
      if (cmd === "unsubscribe_resource") return undefined;
      throw new Error(`unexpected command: ${cmd}`);
    });
  }

  // `fetchPods` is read through a ref, so a changed closure alone can't
  // rebuild the list — without subjectKey in the deps, navigating from one
  // Deployment to another would keep showing the first one's pods.
  it("rebuilds the list when the subject changes", async () => {
    stubInvoke();
    const props = {
      ...BASE,
      fetchPods: () => Promise.resolve([POD]),
      subjectKey: "deployments/production/web",
      refetchKey: 3,
    };
    const { rerender } = render(<PodListSection {...props} />);
    await act(async () => {});
    expect(screen.getByText("web-7d9f-abc")).toBeInTheDocument();

    await act(async () => {
      rerender(
        <PodListSection
          {...props}
          fetchPods={() =>
            Promise.resolve([{ ...POD, uid: "pod-2", name: "api-1" }])
          }
          subjectKey="deployments/production/api"
        />,
      );
    });
    expect(screen.getByText("api-1")).toBeInTheDocument();
    expect(screen.queryByText("web-7d9f-abc")).not.toBeInTheDocument();
  });

  // A panel can mount with a bump count already past zero; firing the refetch
  // effect on that initial value would duplicate the mount fetch.
  it("does not refetch on mount when refetchKey is already non-zero", async () => {
    stubInvoke();
    let fetches = 0;
    const props = {
      ...BASE,
      fetchPods: () => {
        fetches += 1;
        return Promise.resolve([POD]);
      },
      subjectKey: "deployments/production/web",
      refetchKey: 7,
    };
    const { rerender } = render(<PodListSection {...props} />);
    await act(async () => {});
    expect(fetches).toBe(1);

    await act(async () => {
      rerender(<PodListSection {...props} refetchKey={8} />);
    });
    expect(fetches).toBe(2);
  });
});
