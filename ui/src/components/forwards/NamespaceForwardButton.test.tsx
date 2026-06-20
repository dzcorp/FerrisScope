// Header toggle: idle ("Forward all services (DNS)") vs live ("Forwarding · N
// services · click to stop"), keyed off whether a global session for this
// (cluster, namespace) exists. Plus the enable click path.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NamespaceForwardButton } from "./NamespaceForwardButton";
import { useAppStore } from "../../store";
import { tokens } from "../../theme";
import { setMockInvoke, resetMockInvoke } from "../../test/tauri-mock";
import type { GlobalForwardSession } from "../../types";

const t = tokens("dark");

const session: GlobalForwardSession = {
  id: "ctx::q::default::",
  cluster_id: "ctx",
  namespace: "default",
  services: [
    { name: "api", namespace: "default", local_ip: "127.1.0.1", hostnames: ["api"], ports: [80] },
    { name: "db", namespace: "default", local_ip: "127.1.0.2", hostnames: ["db"], ports: [5432] },
  ],
};

beforeEach(() => {
  useAppStore.setState({ globalForwards: {} });
});
afterEach(() => resetMockInvoke());

describe("NamespaceForwardButton", () => {
  it("idle: offers a Forward-all toggle", () => {
    render(<NamespaceForwardButton t={t} clusterId="ctx" namespace="default" />);
    expect(
      screen.getByRole("button", { name: "Forward all services (DNS)" }),
    ).toBeTruthy();
  });

  it("live: reads as forwarding with a count when a matching session exists", () => {
    useAppStore.setState({ globalForwards: { [session.id]: session } });
    render(<NamespaceForwardButton t={t} clusterId="ctx" namespace="default" />);
    expect(
      screen.getByRole("button", { name: /Forwarding · 2 services · click to stop/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Forward all services (DNS)" }),
    ).toBeNull();
  });

  it("does not match a session from another namespace", () => {
    useAppStore.setState({ globalForwards: { [session.id]: session } });
    render(<NamespaceForwardButton t={t} clusterId="ctx" namespace="kube-system" />);
    expect(
      screen.getByRole("button", { name: "Forward all services (DNS)" }),
    ).toBeTruthy();
  });

  it("click enables: fires gf_enable_namespace and stores the session", async () => {
    const calls: string[] = [];
    setMockInvoke((cmd) => {
      calls.push(cmd);
      if (cmd === "gf_enable_namespace") return session;
      return undefined;
    });
    render(<NamespaceForwardButton t={t} clusterId="ctx" namespace="default" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Forward all services (DNS)" }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().globalForwards[session.id]).toBeTruthy(),
    );
    expect(calls).toContain("gf_enable_namespace");
  });
});
