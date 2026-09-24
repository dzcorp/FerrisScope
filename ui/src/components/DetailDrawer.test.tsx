import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { resetEventMock } from "../test/tauri-event-mock";
import { useAppStore, type Drawer } from "../store";
import type { DetailHistory } from "./DetailPanel";

type Captured = {
  target: { name: string };
  history?: DetailHistory;
  onNavigate?: (kind: string, ns: string | null, name: string, cid?: string) => void;
};
let last: Captured | null = null;
vi.mock("./DetailPanel", () => ({
  DetailPanel: (p: Captured) => {
    last = p;
    return null;
  },
}));
const toastWarn = vi.fn();
vi.mock("../lib/dialog", () => ({ toast: { warn: (m: string) => toastWarn(m), bad: vi.fn() }, confirm: vi.fn() }));

const { DetailDrawer } = await import("./DetailDrawer");

const kinds = [
  { id: "deployments", kind: "Deployment", group: "apps", namespaced: true },
  { id: "pods", kind: "Pod", group: "", namespaced: true },
] as never[];

beforeEach(() => {
  last = null;
  toastWarn.mockReset();
  setMockInvoke((cmd, args) =>
    cmd === "subscribe_resource"
      ? {
          rows: args?.["kindId"] === "pods" ? [{ uid: "pod-uid", name: "api-0", namespace: "web" }] : [],
          init_done: true,
        }
      : undefined,
  );
  act(() =>
    useAppStore.setState({ kinds, kindClusters: {}, selectedKindId: "services", pendingDetail: null, drawer: null, drawerId: null, tray: [] }),
  );
});
afterEach(() => {
  resetMockInvoke();
  resetEventMock();
});

function Host() {
  const d = useAppStore((s) => s.drawer);
  const id = useAppStore((s) => s.drawerId) ?? "drawer";
  return d?.kind === "detail" ? (
    <DetailDrawer mode="dark" drawer={d as Extract<Drawer, { kind: "detail" }>} instanceId={id} />
  ) : null;
}

describe("DetailDrawer", () => {
  it("follows a link inside its own history without touching the table", async () => {
    act(() =>
      useAppStore.getState().openDrawer({ kind: "detail", kindId: "deployments", clusterId: "c1", uid: "d-uid", namespace: "web", name: "api" }),
    );
    render(<Host />);
    expect(last?.history?.prev).toBeNull();

    await act(async () => last!.onNavigate!("Pod", "web", "api-0", "c1"));
    await waitFor(() => expect(last?.target.name).toBe("api-0"));
    const d = useAppStore.getState().drawer;
    expect(d?.kind === "detail" && d.uid).toBe("pod-uid");
    expect(last?.history?.prev?.name).toBe("api");
    expect(useAppStore.getState().selectedKindId).toBe("services");
    expect(useAppStore.getState().pendingDetail).toBeNull();

    act(() => last!.history!.onBack());
    expect(last?.target.name).toBe("api");
    expect(last?.history?.next?.name).toBe("api-0");
  });

  it("warns and stays put when the linked object doesn't exist", async () => {
    act(() =>
      useAppStore.getState().openDrawer({ kind: "detail", kindId: "deployments", clusterId: "c1", uid: "d-uid", namespace: "web", name: "api" }),
    );
    render(<Host />);
    await act(async () => last!.onNavigate!("Pod", "web", "ghost", "c1"));
    expect(toastWarn).toHaveBeenCalledWith("web/ghost not found — it may have been deleted");
    expect(last?.target.name).toBe("api");
  });
});
