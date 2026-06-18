// The panel's Global section reconciles from the backend on open (gf_list +
// gf_helper_status) and renders one card per session with its loopback IP,
// forwarded ports, and copyable in-cluster hostnames. It also surfaces the
// privileged-helper lifecycle (running / failed) so an elevation denial is
// visible rather than silent.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PortForwardsPanel } from "./PortForwardsPanel";
import { useAppStore } from "../store";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { GlobalForwardSession } from "../types";

// `api.openExternal` hands the URL to the opener plugin; stub it so the
// open-in-browser action is assertable under jsdom.
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

const session: GlobalForwardSession = {
  id: "ctx::ns::default",
  cluster_id: "ctx",
  namespace: "default",
  services: [
    {
      name: "api",
      namespace: "default",
      local_ip: "127.1.0.1",
      hostnames: ["api", "api.default.svc.cluster.local"],
      ports: [80],
    },
  ],
};

beforeEach(() => {
  vi.mocked(openUrl).mockClear();
  useAppStore.setState({
    forwards: {},
    forwardsOpen: true,
    globalForwards: {},
    helperStatus: { state: "not_started" },
    contexts: [],
  });
});

afterEach(() => resetMockInvoke());

describe("PortForwardsPanel — global section", () => {
  it("hydrates and renders a global session with IP, ports and hostnames", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "gf_list") return [session];
      if (cmd === "gf_helper_status") return { state: "running" };
      return undefined;
    });
    render(<PortForwardsPanel mode="dark" />);

    // Async hydrate from gf_list lands the session.
    expect(
      await screen.findByText("api.default.svc.cluster.local"),
    ).toBeTruthy();
    expect(screen.getByText(/127\.1\.0\.1:80/)).toBeTruthy();
    expect(screen.getByText("helper running")).toBeTruthy();
    // Per-session teardown affordance.
    expect(screen.getByRole("button", { name: "Disable" })).toBeTruthy();
  });

  it("opens a forwarded hostname in the browser at the service port", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "gf_list") return [session];
      if (cmd === "gf_helper_status") return { state: "running" };
      return undefined;
    });
    render(<PortForwardsPanel mode="dark" />);

    // Each hostname chip carries an open-in-browser action alongside copy.
    const openBtn = await screen.findByRole("button", {
      name: "Open api.default.svc.cluster.local in browser",
    });
    fireEvent.click(openBtn);
    expect(openUrl).toHaveBeenCalledWith(
      "http://api.default.svc.cluster.local:80",
    );
  });

  it("surfaces a failed helper status even with no sessions", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "gf_list") return [];
      if (cmd === "gf_helper_status")
        return { state: "failed", message: "elevation denied by user" };
      return undefined;
    });
    render(<PortForwardsPanel mode="dark" />);

    expect(await screen.findByText("helper failed")).toBeTruthy();
  });

  it("keeps the session and does not remove it optimistically when disable fails", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "gf_list") return [session];
      if (cmd === "gf_helper_status") return { state: "running" };
      if (cmd === "gf_disable") throw new Error("helper gone");
      return undefined;
    });
    render(<PortForwardsPanel mode="dark" />);

    const btn = await screen.findByRole("button", { name: "Disable" });
    fireEvent.click(btn);

    // The disable RPC rejected, so the session must stay — no optimistic
    // removal that would leave the UI lying about a still-live forward.
    expect(
      await screen.findByText("api.default.svc.cluster.local"),
    ).toBeTruthy();
    expect(Object.keys(useAppStore.getState().globalForwards)).toHaveLength(1);
  });

  it("+ New toggles the manual forward form", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "gf_list") return [];
      if (cmd === "gf_helper_status") return { state: "not_started" };
      return undefined;
    });
    render(<PortForwardsPanel mode="dark" />);
    expect(screen.queryByTestId("new-forward-form")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "+ New" }));
    expect(screen.getByTestId("new-forward-form")).toBeTruthy();
  });
});
