import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetMockInvoke, setMockInvoke } from "../test/tauri-mock";
import { emitMock, resetEventMock } from "../test/tauri-event-mock";
import { TabScopeProvider } from "../lib/tabScope";
import { DetailPanel } from "./DetailPanel";
import type { ResourceKind } from "../types";

const KIND: ResourceKind = {
  id: "configmaps",
  group: "",
  version: "v1",
  kind: "ConfigMap",
  plural: "configmaps",
  namespaced: true,
  category: "config" as ResourceKind["category"],
  columns: [],
};

afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetEventMock();
});

async function mount(props: {
  onClose?: () => void;
  onMinimize?: () => void;
  onLeave?: (v: { tab?: string; scrollTop?: number }) => void;
}) {
  setMockInvoke(() => null);
  await act(async () => {
    render(
      <DetailPanel
        mode="dark"
        clusterId="ctx"
        kind={KIND}
        target={{ clusterId: "ctx", uid: "u1", namespace: "ns", name: "cm" }}
        row={null}
        onClose={props.onClose ?? (() => {})}
        onMinimize={props.onMinimize}
        onLeave={props.onLeave}
      />,
    );
  });
}

describe("DetailPanel hide vs close", () => {
  const esc = () =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

  it("outside click and Esc hide it to the tray with its view; × closes", async () => {
    const onMinimize = vi.fn();
    const onClose = vi.fn();
    await mount({ onMinimize, onClose });
    await act(async () => {
      fireEvent.click(screen.getByTestId("drawer-scrim"));
      esc();
    });
    expect(onMinimize).toHaveBeenCalledTimes(2);
    expect(onMinimize.mock.calls[0]?.[0]).toMatchObject({ tab: expect.any(String) });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Minimize to tray")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Close"));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("without a tray host, Esc closes", async () => {
    const onClose = vi.fn();
    await mount({ onClose });
    await act(async () => esc());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reports its inner tab and last scroll when it unmounts", async () => {
    const onLeave = vi.fn();
    await mount({ onLeave });
    const scroller = document.createElement("div");
    screen.getByTestId("detail-body").appendChild(scroller);
    Object.defineProperty(scroller, "scrollTop", { value: 240 });
    fireEvent.scroll(scroller);
    cleanup();
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onLeave.mock.calls[0]?.[0]).toMatchObject({ scrollTop: 240, tab: expect.any(String) });
  });
});

describe("DetailPanel while parked", () => {
  it("defers delta-driven refetches until it is shown again", async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      setMockInvoke((cmd) => {
        calls.push(cmd);
        return null;
      });
      const panel = (active: boolean) => (
        <TabScopeProvider tabId={null} active={active}>
          <DetailPanel
            mode="dark"
            clusterId="ctx"
            kind={KIND}
            target={{ clusterId: "ctx", uid: "u1", namespace: "ns", name: "cm" }}
            subscribeNamespaces={["ns"]}
            row={null}
            onClose={() => {}}
          />
        </TabScopeProvider>
      );
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = render(panel(false));
      });
      const yamlFetches = () => calls.filter((c) => c.includes("yaml")).length;
      const before = yamlFetches();
      const upsert = { kind: "upsert", row: { uid: "u1", name: "cm", namespace: "ns" } };
      await act(async () => {
        for (let i = 0; i < 5; i++) emitMock("resource://ctx/configmaps/ns:ns", upsert);
        vi.advanceTimersByTime(1000);
      });
      expect(yamlFetches()).toBe(before);
      await act(async () => {
        view.rerender(panel(true));
      });
      expect(yamlFetches()).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});
