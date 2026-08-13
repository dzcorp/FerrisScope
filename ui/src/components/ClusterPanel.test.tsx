// UnavailableOverlay + ReconnectBanner: behaviour when a cluster's heartbeat
// flips. The load-bearing regression is that the dimmed table stays
// INTERACTIVE (no pointer-events:none) so the operator can still click a row
// into its detail panel while disconnected — and that an active auto-reconnect
// shows the busy progress banner instead of the terminal one.

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { UnavailableOverlay, ReconnectBanner } from "./ClusterPanel";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import type { ContextInfo } from "../types";

const CTX = {
  id: "default::prod",
  name: "prod",
} as ContextInfo;

afterEach(() => {
  cleanup();
  resetMockInvoke();
});

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

  it("offers Diagnose on the terminal banner when given a context", () => {
    // A cluster can go unavailable because the operator's cloud identity
    // drifted mid-session (the heartbeat starts getting 403s) — the same
    // problem the connect-failure banner explains, so it gets the same
    // affordances rather than a dead end.
    setMockInvoke(() => null); // CloudIdentityNote's hint lookup: no note
    render(
      <UnavailableOverlay
        mode="dark"
        unavailable
        reason="namespaces is forbidden: Forbidden"
        onReconnect={() => {}}
        autoReconnect={null}
        diagnoseContext={CTX}
      >
        <button data-testid="row">row</button>
      </UnavailableOverlay>,
    );
    expect(screen.getByRole("button", { name: /diagnose/i })).toBeTruthy();
  });

  it("mounts the cloud-identity note on the terminal banner", async () => {
    // The wiring, not the component. Both are individually well covered, but
    // the seam between them was not: the whole `<CloudIdentityNote>` block
    // could be deleted from ClusterPanel and every test stayed green, so the
    // feature could ship entirely disconnected.
    setMockInvoke((cmd) =>
      cmd === "connect_hint_cmd"
        ? {
            provider: "gcloud",
            title: "Unpinned Google account",
            detail: "This context names no account.",
            authenticated_as: "ops@example.net",
            identities: ["dev@example.com", "ops@example.net"],
            active_identity: "dev@example.com",
            pin: { noun: "account", effects: ["rewrite the kubeconfig"] },
          }
        : null,
    );
    render(
      <UnavailableOverlay
        mode="dark"
        unavailable
        reason="namespaces is forbidden: Forbidden"
        onReconnect={() => {}}
        autoReconnect={null}
        diagnoseContext={CTX}
      >
        <button data-testid="row">row</button>
      </UnavailableOverlay>,
    );
    await waitFor(() =>
      expect(screen.getByRole("note")).toHaveTextContent(
        "Unpinned Google account",
      ),
    );
  });

  it("does not mount the note without a context to identify", async () => {
    // `diagnoseContext` is what carries the context id the hint lookup needs.
    // Without it there is nothing to ask the backend about.
    setMockInvoke(() => {
      throw new Error("connect_hint_cmd must not be called");
    });
    render(
      <UnavailableOverlay
        mode="dark"
        unavailable
        reason="namespaces is forbidden: Forbidden"
        onReconnect={() => {}}
        autoReconnect={null}
      >
        <button data-testid="row">row</button>
      </UnavailableOverlay>,
    );
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("never feeds the note its own placeholder prose", async () => {
    // The terminal banner substitutes app-authored text when the backend gave
    // it no reason. The backend parses the authenticated identity out of the
    // string it receives, so handing it our own sentence would be a lie it has
    // to parse — the note must simply not mount.
    setMockInvoke(() => {
      throw new Error("connect_hint_cmd must not be called");
    });
    render(
      <UnavailableOverlay
        mode="dark"
        unavailable
        reason={null}
        onReconnect={() => {}}
        autoReconnect={null}
        diagnoseContext={CTX}
      >
        <button data-testid="row">row</button>
      </UnavailableOverlay>,
    );
    // The placeholder still shows — it's the banner's job to say *something*.
    expect(screen.getByText(/No response from the apiserver/)).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("hides Diagnose while a retry session is still running", () => {
    // Mid-retry there is nothing to act on yet; the affordance appears once the
    // session gives up and the terminal banner takes over.
    render(
      <UnavailableOverlay
        mode="dark"
        unavailable
        reason="timeout"
        onReconnect={() => {}}
        autoReconnect={{ attempt: 1, max: 3 }}
        diagnoseContext={CTX}
      >
        <button data-testid="row">row</button>
      </UnavailableOverlay>,
    );
    expect(screen.queryByRole("button", { name: /diagnose/i })).toBeNull();
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
