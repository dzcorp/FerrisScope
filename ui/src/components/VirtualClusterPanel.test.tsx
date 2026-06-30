// VirtualClusterPanel: per-member connections, the member-chip bar, and
// per-member failure banners with their own Reconnect.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, act, screen, fireEvent } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { resetEventMock, emitMock } from "../test/tauri-event-mock";
import { useAppStore } from "../store";
import { VirtualClusterPanel } from "./VirtualClusterPanel";
import type { ContextInfo } from "../types";

const initial = useAppStore.getState();

afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetEventMock();
  act(() => {
    useAppStore.setState({
      ...initial,
      selectedNamespaces: new Set<string>(),
      selection: new Map(),
      clusterHealth: {},
      clusterHealthReason: {},
      kinds: [],
      kindClusters: {},
    });
  });
});

const ctx = (id: string, name: string): ContextInfo => ({
  id,
  name,
  cluster: name,
  user: null,
  namespace: null,
  is_current: false,
  group: "Default",
  source_id: "default",
  source_path: null,
});

const MEMBERS = [ctx("default::prod-eu", "prod-eu"), ctx("default::prod-us", "prod-us")];

describe("VirtualClusterPanel", () => {
  it("connects every member and renders the bar with one chip per member", async () => {
    const connected: string[] = [];
    setMockInvoke((cmd, args) => {
      switch (cmd) {
        case "connect_context":
          connected.push(String(args?.name ?? ""));
          return { server_version: "1.30", node_count: 1 };
        case "subscribe_resource":
          return { rows: [], init_done: true };
        case "unsubscribe_resource":
        case "set_table_view":
        case "cancel_connect":
          return undefined;
        default:
          return undefined;
      }
    });
    await act(async () => {
      render(
        <VirtualClusterPanel
          mode="dark"
          title="prod fleet"
          viewScopeId="vctx:t1"
          contexts={MEMBERS}
        />,
      );
    });
    await act(async () => {});

    expect(connected.sort()).toEqual(["default::prod-eu", "default::prod-us"]);
    expect(screen.getByText("prod fleet")).toBeTruthy();
    expect(screen.getByText("prod-eu")).toBeTruthy();
    expect(screen.getByText("prod-us")).toBeTruthy();
    // No kind selected in the store → the picker hint shows (the connect
    // landed, so we're past loading).
    expect(screen.getByText("Pick a resource kind")).toBeTruthy();
  });

  it("a failed member gets its own Reconnect banner while others connect", async () => {
    setMockInvoke((cmd, args) => {
      switch (cmd) {
        case "connect_context": {
          if (args?.name === "default::prod-us") {
            throw new Error("dial tcp: connection refused");
          }
          return { server_version: "1.30", node_count: 1 };
        }
        case "subscribe_resource":
          return { rows: [], init_done: true };
        default:
          return undefined;
      }
    });
    await act(async () => {
      render(
        <VirtualClusterPanel
          mode="dark"
          title="prod fleet"
          viewScopeId="vctx:t1"
          contexts={MEMBERS}
        />,
      );
    });
    await act(async () => {});

    expect(screen.getByText("prod-us: could not connect")).toBeTruthy();
    expect(screen.getByText("Reconnect")).toBeTruthy();
    // The healthy member still drives the main pane (no kind → hint).
    expect(screen.getByText("Pick a resource kind")).toBeTruthy();
  });

  it("a member mid auto-reconnect shows a busy strip, not the failed one", async () => {
    setMockInvoke((cmd) => {
      switch (cmd) {
        case "connect_context":
          return { server_version: "1.30", node_count: 1 };
        case "subscribe_resource":
          return { rows: [], init_done: true };
        default:
          return undefined;
      }
    });
    await act(async () => {
      render(
        <VirtualClusterPanel
          mode="dark"
          title="prod fleet"
          viewScopeId="vctx:t1"
          contexts={MEMBERS}
        />,
      );
    });
    await act(async () => {});

    // The health probe declares prod-us unavailable. The hook arms an
    // auto-reconnect session synchronously (autoReconnect is set before the
    // backoff timer fires), so the busy strip renders immediately.
    act(() => {
      emitMock("cluster-health://default::prod-us", {
        status: "unavailable",
        reason: "timeout",
      });
    });

    expect(screen.getByText("prod-us: reconnecting…")).toBeTruthy();
    expect(screen.getByText("(1/10)")).toBeTruthy();
    expect(screen.getByText("Reconnect now")).toBeTruthy();
    // Not the terminal banner — and the healthy member still drives the pane.
    expect(screen.queryByText("prod-us: unavailable")).toBeNull();
    expect(screen.getByText("Pick a resource kind")).toBeTruthy();
  });

  it("renders the all-down empty state when every member fails", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "connect_context") throw new Error("nope");
      return undefined;
    });
    await act(async () => {
      render(
        <VirtualClusterPanel
          mode="dark"
          title="prod fleet"
          viewScopeId="vctx:t1"
          contexts={MEMBERS}
        />,
      );
    });
    await act(async () => {});
    expect(screen.getByText("No members reachable")).toBeTruthy();
    expect(screen.getAllByText("Reconnect")).toHaveLength(2);
  });
});

describe("VirtualClusterBar '+' menu", () => {
  const connectOk = () =>
    setMockInvoke((cmd) => {
      switch (cmd) {
        case "connect_context":
          return { server_version: "1.30", node_count: 1 };
        case "subscribe_resource":
          return { rows: [], init_done: true };
        default:
          return undefined;
      }
    });

  it("Terminal goes through a member picker and binds the tab to that member", async () => {
    connectOk();
    await act(async () => {
      render(
        <VirtualClusterPanel
          mode="dark"
          title="prod fleet"
          viewScopeId="vctx:t1"
          contexts={MEMBERS}
        />,
      );
    });
    await act(async () => {});

    fireEvent.click(screen.getByLabelText("Add tab or cluster"));
    fireEvent.click(screen.getByText("Terminal…"));
    // Member picker visible — pick the second member (the menu row renders
    // after the bar chip with the same text).
    fireEvent.click(screen.getAllByText("prod-us").at(-1)!);

    const tabs = useAppStore.getState().dockTabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.kind).toBe("terminal");
    const spec = (tabs[0]!.state as { spec?: { clusterId?: string } }).spec;
    expect(spec?.clusterId).toBe("default::prod-us");
  });

  it("Add cluster… lists contexts outside the view and appends via addScopeExtra", async () => {
    connectOk();
    const extraCtx = ctx("default::edge", "edge");
    act(() => {
      useAppStore.setState({
        contexts: [...MEMBERS, extraCtx],
      });
    });
    await act(async () => {
      render(
        <VirtualClusterPanel
          mode="dark"
          title="prod fleet"
          viewScopeId="vctx:t1"
          contexts={MEMBERS}
        />,
      );
    });
    await act(async () => {});

    fireEvent.click(screen.getByLabelText("Add tab or cluster"));
    fireEvent.click(screen.getByText("Add cluster…"));
    fireEvent.click(screen.getAllByText("edge")[0]!);
    expect(useAppStore.getState().scopeExtras).toEqual([]);
    // addScopeExtra requires an active anchor scope; simulate the real
    // wiring (a selected virtual context) and retry.
    act(() => {
      useAppStore.setState({
        virtualContexts: [
          {
            id: "t1",
            name: "prod fleet",
            members: MEMBERS.map((m) => m.id),
          },
        ],
        selectedVirtualContextId: "t1",
      });
    });
    fireEvent.click(screen.getByLabelText("Add tab or cluster"));
    fireEvent.click(screen.getByText("Add cluster…"));
    fireEvent.click(screen.getAllByText("edge")[0]!);
    expect(useAppStore.getState().scopeExtras).toEqual(["default::edge"]);
  });

  it("ad-hoc members render a remove × that drops them from the scope", async () => {
    connectOk();
    const extraCtx = ctx("default::edge", "edge");
    act(() => {
      useAppStore.setState({
        contexts: [...MEMBERS, extraCtx],
        virtualContexts: [
          { id: "t1", name: "prod fleet", members: MEMBERS.map((m) => m.id) },
        ],
        selectedVirtualContextId: "t1",
        scopeExtras: ["default::edge"],
      });
    });
    await act(async () => {
      render(
        <VirtualClusterPanel
          mode="dark"
          title="prod fleet"
          viewScopeId="vctx:t1"
          contexts={[...MEMBERS, extraCtx]}
        />,
      );
    });
    await act(async () => {});

    fireEvent.click(screen.getByLabelText("Remove edge from this view"));
    expect(useAppStore.getState().scopeExtras).toEqual([]);
  });
});

describe("VirtualClusterBar save affordances", () => {
  const connectOk = () =>
    setMockInvoke((cmd) => {
      switch (cmd) {
        case "connect_context":
          return { server_version: "1.30", node_count: 1 };
        case "subscribe_resource":
          return { rows: [], init_done: true };
        default:
          return undefined;
      }
    });
  const EXTRA = ctx("default::edge", "edge");
  const adHocState = () =>
    act(() => {
      useAppStore.setState({
        contexts: [...MEMBERS, EXTRA],
        selectedContext: "default::prod-eu",
        selectedVirtualContextId: null,
        virtualContexts: [],
        scopeExtras: ["default::edge"],
      });
    });

  it("temporary views surface a standing 'Save view…' button; saved views don't", async () => {
    connectOk();
    adHocState();
    const { unmount } = render(
      <VirtualClusterPanel
        mode="dark"
        title="prod-eu +1"
        viewScopeId="default::prod-eu"
        contexts={[MEMBERS[0]!, EXTRA]}
      />,
    );
    await act(async () => {});
    expect(screen.getByText("Save view…")).toBeTruthy();
    unmount();

    act(() => {
      useAppStore.setState({
        scopeExtras: [],
        virtualContexts: [
          { id: "t1", name: "prod fleet", members: MEMBERS.map((m) => m.id) },
        ],
        selectedVirtualContextId: "t1",
        selectedContext: null,
      });
    });
    render(
      <VirtualClusterPanel
        mode="dark"
        title="prod fleet"
        viewScopeId="vctx:t1"
        contexts={MEMBERS}
      />,
    );
    await act(async () => {});
    expect(screen.queryByText("Save view…")).toBeNull();
  });

  it("saves with the pregenerated placeholder name when the input stays empty", async () => {
    connectOk();
    adHocState();
    render(
      <VirtualClusterPanel
        mode="dark"
        title="prod-eu +1"
        viewScopeId="default::prod-eu"
        contexts={[MEMBERS[0]!, EXTRA]}
      />,
    );
    await act(async () => {});

    fireEvent.click(screen.getByText("Save view…"));
    const input = screen.getByLabelText("Virtual context name");
    expect(input.getAttribute("placeholder")).toBe("prod-eu + edge");
    fireEvent.click(screen.getByText("Save"));

    const s = useAppStore.getState();
    expect(s.virtualContexts).toHaveLength(1);
    expect(s.virtualContexts[0]!.name).toBe("prod-eu + edge");
    expect(s.virtualContexts[0]!.members).toEqual([
      "default::prod-eu",
      "default::edge",
    ]);
    // Saving activates the new virtual context (extras become members).
    expect(s.selectedVirtualContextId).toBe(s.virtualContexts[0]!.id);
  });

  it("renders the same namespace control as the single-cluster bar", async () => {
    connectOk();
    adHocState();
    render(
      <VirtualClusterPanel
        mode="dark"
        title="prod-eu +1"
        viewScopeId="default::prod-eu"
        contexts={[MEMBERS[0]!, EXTRA]}
      />,
    );
    await act(async () => {});
    // Shared NamespaceButton anatomy: caption + summary + ⌘I hint.
    expect(screen.getByText("Namespace")).toBeTruthy();
    expect(screen.getByText("All namespaces")).toBeTruthy();
  });
});

describe("VirtualClusterBar save mode with an active virtual context", () => {
  const connectOk = () =>
    setMockInvoke((cmd) => {
      switch (cmd) {
        case "connect_context":
          return { server_version: "1.30", node_count: 1 };
        case "subscribe_resource":
          return { rows: [], init_done: true };
        default:
          return undefined;
      }
    });
  const EXTRA = ctx("default::edge", "edge");
  const seedVctxWithExtra = () =>
    act(() => {
      useAppStore.setState({
        contexts: [...MEMBERS, EXTRA],
        virtualContexts: [
          { id: "t1", name: "prod fleet", members: MEMBERS.map((m) => m.id) },
        ],
        selectedVirtualContextId: "t1",
        selectedContext: null,
        scopeExtras: ["default::edge"],
      });
    });

  it("offers 'Add to' the active virtual context; absorbing folds the extra in", async () => {
    connectOk();
    seedVctxWithExtra();
    render(
      <VirtualClusterPanel
        mode="dark"
        title="prod fleet +1"
        viewScopeId="vctx:t1"
        contexts={[...MEMBERS, EXTRA]}
      />,
    );
    await act(async () => {});

    fireEvent.click(screen.getByText("Save view…"));
    fireEvent.click(screen.getByText('Add to "prod fleet"'));

    const s = useAppStore.getState();
    expect(s.virtualContexts[0]!.members).toEqual([
      "default::prod-eu",
      "default::prod-us",
      "default::edge",
    ]);
    expect(s.scopeExtras).toEqual([]);
    expect(s.selectedVirtualContextId).toBe("t1");
  });

  it("'Save as new' creates a second virtual context instead of touching the active one", async () => {
    connectOk();
    seedVctxWithExtra();
    render(
      <VirtualClusterPanel
        mode="dark"
        title="prod fleet +1"
        viewScopeId="vctx:t1"
        contexts={[...MEMBERS, EXTRA]}
      />,
    );
    await act(async () => {});

    fireEvent.click(screen.getByText("Save view…"));
    fireEvent.click(screen.getByText("Save as new"));

    const s = useAppStore.getState();
    expect(s.virtualContexts).toHaveLength(2);
    expect(s.virtualContexts[0]!.members).toEqual(MEMBERS.map((m) => m.id));
    expect(s.virtualContexts[1]!.members).toEqual([
      "default::prod-eu",
      "default::prod-us",
      "default::edge",
    ]);
    expect(s.selectedVirtualContextId).toBe(s.virtualContexts[1]!.id);
  });

  it("the '+' menu root no longer duplicates the save entry", async () => {
    connectOk();
    seedVctxWithExtra();
    render(
      <VirtualClusterPanel
        mode="dark"
        title="prod fleet +1"
        viewScopeId="vctx:t1"
        contexts={[...MEMBERS, EXTRA]}
      />,
    );
    await act(async () => {});

    fireEvent.click(screen.getByLabelText("Add tab or cluster"));
    expect(screen.queryByText("Save as virtual context…")).toBeNull();
    // Root entries now carry the same icon-row anatomy as the
    // single-cluster menu (subtitles present).
    expect(screen.getByText("Talk to the cluster-aware assistant")).toBeTruthy();
    expect(screen.getByText("Merge another cluster into this view")).toBeTruthy();
  });
});
