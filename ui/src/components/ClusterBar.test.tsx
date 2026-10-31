// The status pill must describe the CLUSTER, not the socket. `connect_context`
// can return success against an entry the heartbeat already declared dead (its
// data plane is torn down and every subscribe is refused), and the bar used to
// report a green "Running" over exactly that state — the visible half of the
// dead-end this suite guards.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ClusterBar } from "./ClusterBar";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { resetEventMock } from "../test/tauri-event-mock";
import { useAppStore } from "../store";
import type { ClusterInfo, ContextInfo } from "../types";

const CID = "default::prod";
const CTX = {
  id: CID,
  name: "prod",
  cluster: "prod",
  user: "u",
  namespace: null,
  is_current: true,
  group: "g",
  source_id: "default",
  source_path: null,
} as ContextInfo;

const INFO: ClusterInfo = { server_version: "v1.31.2", node_count: 3 };

const initial = useAppStore.getState();

afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetEventMock();
  useAppStore.setState({
    ...initial,
    clusterHealth: {},
    clusterHealthReason: {},
    clusterReconnecting: {},
  });
});

function renderBar() {
  setMockInvoke(() => undefined);
  render(
    <ClusterBar mode="dark" context={CTX} state={{ status: "ok", info: INFO }} />,
  );
}

describe("ClusterBar status pill", () => {
  it("reads Running only when the heartbeat agrees", () => {
    renderBar();
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("reads Unavailable when the heartbeat has declared the cluster dead", () => {
    useAppStore.setState({
      clusterHealth: { [CID]: "unavailable" },
      clusterHealthReason: { [CID]: "apiserver gone" },
    });
    renderBar();
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });

  it("reads Reconnecting while a retry session is running", () => {
    // Takes precedence over both: the client is being rebuilt, so neither
    // "Running" nor "Unavailable" is the honest answer yet.
    useAppStore.setState({
      clusterHealth: { [CID]: "unavailable" },
      clusterReconnecting: { [CID]: true },
    });
    renderBar();
    expect(screen.getByText("Reconnecting")).toBeTruthy();
  });

  it("keeps the connect-state answers for non-ok connections", () => {
    setMockInvoke(() => undefined);
    render(
      <ClusterBar
        mode="dark"
        context={CTX}
        state={{ status: "error", message: "connection refused" }}
      />,
    );
    expect(screen.getByText("Error")).toBeTruthy();
  });
});

describe("ClusterBar identity chip", () => {
  const GKE = {
    ...CTX,
    cloud_identity: { provider: "gcloud", pinned: "old@example.com" },
  } as ContextInfo;

  it("shows the pinned identity, and nothing when it follows the CLI", () => {
    setMockInvoke(() => undefined);
    const { rerender } = render(
      <ClusterBar
        mode="dark"
        context={GKE}
        state={{ status: "ok", info: INFO }}
        onIdentityChanged={() => {}}
      />,
    );
    expect(screen.getByText("old@example.com")).toBeTruthy();
    rerender(
      <ClusterBar
        mode="dark"
        context={{ ...GKE, cloud_identity: { provider: "aws", pinned: null } }}
        state={{ status: "ok", info: INFO }}
        onIdentityChanged={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /change cloud identity/i })).toBeNull();
  });

  it("stays hidden without a cloud identity or a way to reconnect", () => {
    setMockInvoke(() => undefined);
    const { rerender } = render(
      <ClusterBar mode="dark" context={GKE} state={{ status: "ok", info: INFO }} />,
    );
    expect(screen.queryByRole("button", { name: /change cloud identity/i })).toBeNull();
    rerender(
      <ClusterBar
        mode="dark"
        context={CTX}
        state={{ status: "ok", info: INFO }}
        onIdentityChanged={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /change cloud identity/i })).toBeNull();
  });

  it("repins from the chip and reconnects", async () => {
    const pinned: unknown[] = [];
    setMockInvoke((cmd, args) => {
      if (cmd === "cloud_identity_status_cmd")
        return {
          provider: "gcloud",
          detail: "This context is pinned to old@example.com.",
          pinned_identity: "old@example.com",
          active_identity: "new@example.com",
          identities: ["new@example.com", "old@example.com"],
          suggested_identity: "new@example.com",
          pin: { noun: "account", effects: ["replace the account"] },
          pin_blocked: null,
        };
      if (cmd === "pin_cloud_identity_cmd") pinned.push(args);
      if (cmd === "list_contexts") return [];
      return undefined;
    });
    const onIdentityChanged = vi.fn();
    render(
      <ClusterBar
        mode="dark"
        context={GKE}
        state={{ status: "ok", info: INFO }}
        onIdentityChanged={onIdentityChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /change cloud identity/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^pin account$/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^pin account$/i }));
    fireEvent.click(screen.getByRole("button", { name: /pin new@example\.com/i }));
    await waitFor(() => expect(onIdentityChanged).toHaveBeenCalledTimes(1));
    expect(pinned).toEqual([{ name: CID, identity: "new@example.com" }]);
  });
});

describe("ClusterBar long values", () => {
  const LONG = "gke_development-d83ab4a8_europe-west4_infrastructure-01";
  const EMAIL = "someone.with.a.long.name@example.com";
  const GKE = {
    ...CTX,
    name: LONG,
    cluster: LONG,
    user: LONG,
    cloud_identity: { provider: "gcloud", pinned: EMAIL },
  } as ContextInfo;
  const VERSION = "v1.35.8-gke.1439001";
  // A stat is its caption over its value.
  const stat = (caption: string) => screen.getByText(caption).parentElement!;
  const value = (caption: string) => stat(caption).children[1] as HTMLElement;

  const width = window.innerWidth;
  beforeEach(() => {
    // Wide enough that the bar shows every stat.
    Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
    useAppStore.setState({ contexts: [GKE] });
    setMockInvoke(() => undefined);
    render(
      <ClusterBar
        mode="dark"
        context={GKE}
        state={{ status: "ok", info: { server_version: VERSION, node_count: 12 } }}
        onIdentityChanged={() => {}}
      />,
    );
  });
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  });

  it("ellipsizes version, cluster and user on one line, full text on hover", () => {
    for (const [caption, full] of [
      ["Version", VERSION],
      ["Cluster", LONG],
      ["User", LONG],
    ]) {
      expect(stat(caption!).title).toBe(full);
      expect(stat(caption!).style.minWidth).toBe("0px");
      expect(value(caption!).style.whiteSpace).toBe("nowrap");
      expect(value(caption!).style.textOverflow).toBe("ellipsis");
    }
    // Shortened to the cluster segment over its project · region, each line
    // clipped on its own.
    for (const line of value("Cluster").children) {
      expect((line as HTMLElement).style.textOverflow).toBe("ellipsis");
    }
    expect(value("Cluster").textContent).toContain("infrastructure-01");
  });

  it("keeps status and nodes whole", () => {
    expect(stat("Status").style.flexShrink).toBe("0");
    expect(stat("Nodes").style.flexShrink).toBe("0");
    expect(value("Status").style.overflow).toBe("");
  });

  it("clips the identity and names it in the tooltip", async () => {
    const button = screen.getByRole("button", { name: /change cloud identity/i });
    expect(stat("Identity").style.minWidth).toBe("0px");
    expect(button.style.textOverflow).toBe("ellipsis");
    fireEvent.mouseEnter(button);
    expect(
      await screen.findByText(`${EMAIL} — change the cloud identity this context uses`),
    ).toBeTruthy();
  });
});
