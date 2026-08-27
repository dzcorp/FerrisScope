// The status pill must describe the CLUSTER, not the socket. `connect_context`
// can return success against an entry the heartbeat already declared dead (its
// data plane is torn down and every subscribe is refused), and the bar used to
// report a green "Running" over exactly that state — the visible half of the
// dead-end this suite guards.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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
