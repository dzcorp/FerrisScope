import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useAppStore } from "../store";
import { TabScopeProvider } from "../lib/tabScope";

vi.mock("./ClusterPanel", () => ({
  ClusterPanel: ({ context }: { context: { id: string } }) => <div data-testid={`single-${context.id}`} />,
}));
vi.mock("./VirtualClusterPanel", () => ({
  VirtualClusterPanel: ({ contexts }: { contexts: { id: string }[] }) => (
    <div data-testid={`multi-${contexts.map((c) => c.id).join("+")}`} />
  ),
}));

const { TabMainView } = await import("./TabMainView");

beforeEach(() => {
  act(() =>
    useAppStore.setState({
      contexts: [{ id: "a", name: "a" } as never, { id: "b", name: "b" } as never],
      virtualContexts: [],
      openTabs: [],
      activeTabId: null,
    }),
  );
});

describe("TabMainView", () => {
  it("renders each tab's own scope, hidden or not", () => {
    act(() => {
      useAppStore.getState().selectContext("a");
      useAppStore.getState().addScopeExtra("b");
      useAppStore.getState().selectContext("b");
    });
    const [ta, tb] = useAppStore.getState().openTabs;
    render(
      <>
        <TabScopeProvider tabId={ta!.id} active={false}>
          <TabMainView mode="dark" />
        </TabScopeProvider>
        <TabScopeProvider tabId={tb!.id} active>
          <TabMainView mode="dark" />
        </TabScopeProvider>
      </>,
    );
    expect(screen.getByTestId("multi-a+b")).toBeTruthy();
    expect(screen.getByTestId("single-b")).toBeTruthy();
  });
});
