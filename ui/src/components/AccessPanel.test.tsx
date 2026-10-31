import { describe, it, expect, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { useAppStore } from "../store";
import { resetAccessCache } from "../lib/access";
import { AccessPanel } from "./AccessPanel";
import { RestrictedStrip } from "./ClusterPanel";

type Call = { cmd: string; args?: Record<string, unknown> };

afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetAccessCache();
});

function mock(calls: Call[]) {
  setMockInvoke((cmd, args) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "access_whoami_cmd":
        return { username: "dev@example.io", uid: null, groups: ["system:authenticated", "devs"], extra: {} };
      case "access_rules_cmd":
        return {
          namespace: args?.namespace,
          rules: [{ verbs: ["get", "list"], apiGroups: [""], resources: ["pods"], resourceNames: [] }],
          nonResourceRules: [],
          incomplete: true,
          evaluationError: null,
        };
      case "access_check_cmd":
        return (args?.requests as { kindId: string; action: string }[]).map((r) =>
          r.kindId === "pods" && (r.action === "list" || r.action === "get")
            ? { state: "allowed" }
            : { state: "denied", reason: `cannot ${r.action} ${r.kindId}` },
        );
      case "connect_hint_cmd":
        return null;
      default:
        return undefined;
    }
  });
}

describe("AccessPanel", () => {
  it("shows identity, the can-i matrix and the rules, and refreshes on demand", async () => {
    const calls: Call[] = [];
    mock(calls);
    act(() => useAppStore.setState({ selectedNamespaces: new Set(["team"]) }));
    await act(async () => {
      render(<AccessPanel clusterId="c1" onClose={() => {}} />);
    });
    expect(await screen.findByText("dev@example.io")).toBeTruthy();
    expect(screen.getByText("devs")).toBeTruthy();
    expect(screen.getByText("RBAC rules in team")).toBeTruthy();
    expect(screen.getByText(/Incomplete: a webhook authorizer/)).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("✓").length).toBe(2));
    expect(screen.getAllByText("✕").length).toBeGreaterThan(10);

    const before = calls.filter((c) => c.cmd === "access_whoami_cmd").length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.cmd === "access_whoami_cmd").length).toBe(before + 1),
    );
    expect(calls.some((c) => c.cmd === "access_invalidate_cmd")).toBe(true);
  });

  it("shows a check that couldn't answer as ?, never as allowed", async () => {
    setMockInvoke((cmd, args) =>
      cmd === "access_check_cmd"
        ? (args?.requests as unknown[]).map(() => ({ state: "unknown", error: "permission checks unavailable" }))
        : cmd === "access_whoami_cmd" || cmd === "access_rules_cmd"
          ? Promise.reject(new Error("forbidden"))
          : undefined,
    );
    await act(async () => {
      render(<AccessPanel clusterId="c1" onClose={() => {}} />);
    });
    await waitFor(() => expect(screen.getAllByText("?").length).toBeGreaterThan(10));
    expect(screen.queryByText("✓")).toBeNull();
    expect(screen.getAllByTitle("Couldn't check: permission checks unavailable").length).toBeGreaterThan(0);
  });

  it("asks about a typed namespace", async () => {
    const calls: Call[] = [];
    mock(calls);
    act(() => useAppStore.setState({ selectedNamespaces: new Set() }));
    await act(async () => {
      render(<AccessPanel clusterId="c1" onClose={() => {}} />);
    });
    const input = screen.getByLabelText("Namespace");
    fireEvent.change(input, { target: { value: "other" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "access_rules_cmd" && c.args?.namespace === "other")).toBe(true),
    );
  });
});

describe("RestrictedStrip", () => {
  it("points at the namespace picker and the permissions panel", async () => {
    mock([]);
    act(() =>
      useAppStore.setState({ nsModalOpen: false, accessPanelCluster: null, restrictedDismissed: new Set() }),
    );
    await act(async () => {
      render(
        <RestrictedStrip
          context={{ id: "c1", name: "c1" } as never}
          reason='namespaces is forbidden: User "dev" cannot list resource "namespaces"'
          onReconnect={() => {}}
        />,
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Pick namespace" }));
    expect(useAppStore.getState().nsModalOpen).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "My permissions" }));
    expect(useAppStore.getState().accessPanelCluster).toBe("c1");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/Limited access/)).toBeNull();
    // Survives the remount a tab switch causes.
    expect(useAppStore.getState().restrictedDismissed.has("c1")).toBe(true);
  });
});
