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
    fetchPods: () => Promise.resolve({ rows: pods }),
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
    expect(onNavigate).toHaveBeenCalledWith("Pod", "production", "web-7d9f-abc", "ctx");
  });

  // The node is cluster-scoped, so the namespace argument must be null —
  // passing the pod's namespace would resolve to nothing.
  it("navigates to the node detail with a null namespace", async () => {
    const { onNavigate } = await mount();
    (await screen.findByText("worker-1")).click();
    expect(onNavigate).toHaveBeenCalledWith("Node", null, "worker-1", "ctx");
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

  // A capped list read as a complete one: "500 total" for a 3000-pod
  // DaemonSet, with every pod past the cap also refused from the delta stream
  // under a selector we cannot evaluate client-side.
  it("says the list is a prefix when the source truncated it", async () => {
    await mount({
      fetchPods: () => Promise.resolve({ rows: [POD], truncated: true }),
    });
    expect(await screen.findByText("first 1 — more exist")).toBeInTheDocument();
    expect(screen.queryByText("1 total")).not.toBeInTheDocument();
  });

  it("reports a complete list plainly", async () => {
    await mount({
      fetchPods: () => Promise.resolve({ rows: [POD], truncated: false }),
    });
    expect(await screen.findByText("1 total")).toBeInTheDocument();
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
      fetchPods: () => Promise.resolve({ rows: [POD] }),
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
            Promise.resolve({ rows: [{ ...POD, uid: "pod-2", name: "api-1" }] })
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
        return Promise.resolve({ rows: [POD] });
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

describe("PodListSection row chrome", () => {
  const BASE = {
    t: tokens("dark"),
    mode: "dark" as const,
    clusterId: "ctx",
    acceptsDelta: () => true,
    subjectKey: "deployments/production/web",
    refetchKey: 0,
    emptyLabel: "none",
    fetchPods: () => Promise.resolve({ rows: [POD] }),
    onNavigate: () => {},
  };

  function stubInvoke() {
    setMockInvoke((cmd) => {
      if (cmd === "subscribe_resource") return { rows: [], init_done: true };
      if (cmd === "unsubscribe_resource") return undefined;
      throw new Error(`unexpected command: ${cmd}`);
    });
  }

  async function show(extra: Record<string, unknown>) {
    stubInvoke();
    await act(async () => {
      render(
        <PodListSection
          {...({ ...BASE, ...extra } as React.ComponentProps<
            typeof PodListSection
          >)}
        />,
      );
    });
  }

  // On a workload every pod shares the controller's namespace, so the label
  // column would be the same word repeated down the whole list.
  it("omits the namespace label by default", async () => {
    await show({ showNode: true });
    expect(await screen.findByText("web-7d9f-abc")).toBeInTheDocument();
    expect(screen.queryByText("production")).not.toBeInTheDocument();
  });

  // The Node panel's pods really do span namespaces, so it opts back in.
  it("shows the namespace label when asked", async () => {
    await show({ showNode: false, showNamespace: true });
    expect(await screen.findByText("web-7d9f-abc")).toBeInTheDocument();
    expect(screen.getByText("production")).toBeInTheDocument();
  });

  // The node is a secondary reference — clickable, but it must not carry the
  // accent colour that marks the pod's own name.
  it("renders the node muted while keeping it clickable", async () => {
    await show({ showNode: true });
    const t = tokens("dark");
    const node = await screen.findByText("worker-1");
    const pod = screen.getByText("web-7d9f-abc");
    expect(node).toHaveStyle({ color: t.textMuted });
    expect(node).toHaveStyle({ cursor: "pointer" });
    expect(pod).toHaveStyle({ color: t.accent });
    expect(node).not.toHaveStyle({ color: t.accent });
  });
});

describe("PodListSection owner chip", () => {
  const BASE = {
    t: tokens("dark"),
    mode: "dark" as const,
    clusterId: "ctx",
    acceptsDelta: () => true,
    subjectKey: "deployments/production/web",
    refetchKey: 0,
    emptyLabel: "none",
    fetchPods: () => Promise.resolve({ rows: [POD] }),
    onNavigate: () => {},
  };

  async function show(extra: Record<string, unknown>) {
    setMockInvoke((cmd) => {
      if (cmd === "subscribe_resource") return { rows: [], init_done: true };
      if (cmd === "unsubscribe_resource") return undefined;
      throw new Error(`unexpected command: ${cmd}`);
    });
    await act(async () => {
      render(
        <PodListSection
          {...({ ...BASE, ...extra } as React.ComponentProps<
            typeof PodListSection
          >)}
        />,
      );
    });
  }

  // A union list needs to say which controller each pod came from.
  it("renders the owner when ownerOf is supplied", async () => {
    await show({ ownerOf: () => "web-a" });
    expect(await screen.findByText("web-a")).toBeInTheDocument();
  });

  // On a single-owner list the chip would be the same word on every row.
  it("renders no owner chip by default", async () => {
    await show({});
    expect(await screen.findByText("web-7d9f-abc")).toBeInTheDocument();
    expect(screen.queryByText("web-a")).not.toBeInTheDocument();
  });

  it("omits the chip for a pod with no resolvable owner", async () => {
    await show({ ownerOf: () => null });
    expect(await screen.findByText("web-7d9f-abc")).toBeInTheDocument();
  });
});

describe("PodListSection subscription hygiene", () => {
  const BASE = {
    t: tokens("dark"),
    mode: "dark" as const,
    clusterId: "ctx",
    acceptsDelta: () => true,
    subjectKey: "deployments/production/web",
    emptyLabel: "none",
    onNavigate: () => {},
  };

  function track() {
    const calls: string[] = [];
    setMockInvoke((cmd) => {
      calls.push(cmd);
      if (cmd === "subscribe_resource") return { rows: [], init_done: true };
      if (cmd === "unsubscribe_resource") return undefined;
      throw new Error(`unexpected command: ${cmd}`);
    });
    return calls;
  }

  // `unsubscribe_resource` decrements a SHARED refcount. Unsubscribing when we
  // never subscribed steals the Pods table's watcher.
  it("does not unsubscribe when the initial fetch failed", async () => {
    const calls = track();
    const { unmount } = render(
      <PodListSection
        {...({
          ...BASE,
          refetchKey: 0,
          fetchPods: () => Promise.reject(new Error("nope")),
        } as React.ComponentProps<typeof PodListSection>)}
      />,
    );
    await act(async () => {});
    unmount();
    await act(async () => {});
    const subs = calls.filter((c) => c === "subscribe_resource").length;
    const unsubs = calls.filter((c) => c === "unsubscribe_resource").length;
    // Pairing, not `<=`: with unsubs=0 and subs=1 a `<=` assertion passes
    // while leaking, so it could never fail for the bug it was guarding.
    expect(unsubs).toBe(subs);
  });

  // The decrement used to hang off a flag set inside subscribe's `.then`.
  // Unmounting while subscribe was still in flight left the flag false, cleanup
  // skipped the decrement, and the refcount leaked +1 — pinning the cluster's
  // pods watcher for the rest of the session.
  it("releases a subscription that resolves after unmount", async () => {
    const calls: string[] = [];
    let releaseSub: (v: unknown) => void = () => {};
    setMockInvoke((cmd) => {
      calls.push(cmd);
      if (cmd === "subscribe_resource") {
        return new Promise((res) => {
          releaseSub = res;
        });
      }
      if (cmd === "unsubscribe_resource") return undefined;
      throw new Error(`unexpected command: ${cmd}`);
    });
    const { unmount } = render(
      <PodListSection
        {...({
          ...BASE,
          refetchKey: 0,
          fetchPods: () => Promise.resolve({ rows: [] }),
        } as React.ComponentProps<typeof PodListSection>)}
      />,
    );
    await act(async () => {});
    unmount();
    await act(async () => {});
    // Subscribe lands only now — after cleanup already ran.
    await act(async () => {
      releaseSub({ rows: [], init_done: true });
    });
    expect(calls.filter((c) => c === "subscribe_resource")).toHaveLength(1);
    expect(calls.filter((c) => c === "unsubscribe_resource")).toHaveLength(1);
  });

  // detailVersion bumps per debounced watcher delta; a churning rollout would
  // otherwise fire several LISTs a second.
  it("coalesces overlapping refetches into one in-flight request", async () => {
    track();
    let fetches = 0;
    let release: (v: { rows: ResourceRow[] }) => void = () => {};
    const props = {
      ...BASE,
      refetchKey: 1,
      fetchPods: () => {
        fetches += 1;
        return new Promise<{ rows: ResourceRow[] }>((res) => {
          release = res;
        });
      },
    } as React.ComponentProps<typeof PodListSection>;

    const { rerender } = render(<PodListSection {...props} />);
    await act(async () => {});
    const afterMount = fetches;

    // Three bumps while the first fetch is still outstanding — all three must
    // be swallowed by the in-flight guard.
    for (const k of [2, 3, 4]) {
      await act(async () => {
        rerender(<PodListSection {...props} refetchKey={k} />);
      });
    }
    expect(fetches).toBe(afterMount);

    await act(async () => {
      release({ rows: [] });
    });
  });
});
