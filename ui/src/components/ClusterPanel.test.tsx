// UnavailableOverlay + ReconnectBanner: behaviour when a cluster's heartbeat
// flips. The load-bearing regression is that the dimmed table stays
// INTERACTIVE (no pointer-events:none) so the operator can still click a row
// into its detail panel while disconnected — and that an active auto-reconnect
// shows the busy progress banner instead of the terminal one.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { UnavailableOverlay, ReconnectBanner } from "./ClusterPanel";

afterEach(cleanup);

describe("UnavailableOverlay", () => {
  it("keeps the table interactive (dim, but no pointer-events:none)", () => {
    render(
      <UnavailableOverlay
        mode="dark"
        unavailable
        reason="apiserver gone"
        onReconnect={() => {}}
        autoReconnect={null}
      >
        <button data-testid="row">row</button>
      </UnavailableOverlay>,
    );
    const wrapper = screen.getByTestId("row").parentElement as HTMLElement;
    expect(wrapper.style.opacity).toBe("0.5");
    expect(wrapper.style.pointerEvents).not.toBe("none");
    // Manual banner is shown when not auto-reconnecting.
    expect(screen.getByText("Cluster unavailable")).toBeTruthy();
  });

  it("passes children straight through when healthy and not reconnecting", () => {
    render(
      <UnavailableOverlay
        mode="dark"
        unavailable={false}
        reason={null}
        onReconnect={() => {}}
        autoReconnect={null}
      >
        <button data-testid="row">row</button>
      </UnavailableOverlay>,
    );
    // No overlay wrapper, no banner.
    expect(screen.queryByText("Cluster unavailable")).toBeNull();
    expect(screen.getByTestId("row")).toBeTruthy();
  });

  it("shows the busy progress banner while auto-reconnecting", () => {
    const onReconnect = vi.fn();
    render(
      <UnavailableOverlay
        mode="dark"
        unavailable
        reason="timeout"
        onReconnect={onReconnect}
        autoReconnect={{ attempt: 2, max: 3 }}
      >
        <button data-testid="row">row</button>
      </UnavailableOverlay>,
    );
    expect(screen.getByText("Reconnecting…")).toBeTruthy();
    expect(screen.getByText("(2/3)")).toBeTruthy();
    expect(screen.queryByText("Cluster unavailable")).toBeNull();
    fireEvent.click(screen.getByText("Reconnect now"));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});

describe("ReconnectBanner", () => {
  it("renders the plain Reconnect button by default", () => {
    render(
      <ReconnectBanner
        mode="dark"
        title="Cluster unavailable"
        reason={null}
        onReconnect={() => {}}
      />,
    );
    expect(screen.getByText("Reconnect")).toBeTruthy();
    expect(screen.queryByText("Reconnect now")).toBeNull();
  });

  it("renders busy progress + Reconnect now when busy", () => {
    render(
      <ReconnectBanner
        mode="dark"
        title="Reconnecting…"
        reason={null}
        onReconnect={() => {}}
        busy
        progress={{ attempt: 3, max: 3 }}
      />,
    );
    expect(screen.getByText("(3/3)")).toBeTruthy();
    expect(screen.getByText("Reconnect now")).toBeTruthy();
  });
});
