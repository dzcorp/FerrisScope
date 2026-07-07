// Notifications panel: a logged notification keeps its one-line headline but
// hides structured context (kube context/cluster/namespace/kind/resource) behind
// an expander. Bare notifications with nothing extra stay static (no toggle).

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NotificationsPanel } from "./NotificationsPanel";
import { useAppStore } from "../store";
import type { Notification } from "../store";

function seed(notes: Notification[]) {
  useAppStore.setState({ notificationsOpen: true, notifications: notes });
}

afterEach(cleanup);

const withMeta: Notification = {
  id: "n1",
  tone: "ok",
  text: "Evicted pod default/nginx-7f",
  createdAt: 1_700_000_000_000,
  meta: {
    context: "prod-eu-1",
    cluster: "gke_acme_prod",
    namespace: "default",
    kind: "Pod",
    name: "nginx-7f",
  },
};

describe("NotificationsPanel expandable rows", () => {
  it("hides structured detail until the row is expanded", () => {
    seed([withMeta]);
    render(<NotificationsPanel mode="dark" />);

    // Headline is always visible; the context detail is behind the expander.
    expect(screen.getByText("Evicted pod default/nginx-7f")).toBeTruthy();
    expect(screen.queryByText("prod-eu-1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Evicted pod/ }));

    // Now the structured rows and their labels are revealed.
    expect(screen.getByText("Context")).toBeTruthy();
    expect(screen.getByText("prod-eu-1")).toBeTruthy();
    expect(screen.getByText("Namespace")).toBeTruthy();
    expect(screen.getByText("default")).toBeTruthy();
    // Absolute timestamp is appended to the detail box.
    expect(screen.getByText("Time")).toBeTruthy();
  });

  it("shows no expander for a bare notification with no meta or body", () => {
    seed([{ id: "n2", tone: "info", text: "plain notice", createdAt: 1 }]);
    render(<NotificationsPanel mode="dark" />);

    expect(screen.getByText("plain notice")).toBeTruthy();
    // The headline is a static div, not a toggle button.
    expect(screen.queryByRole("button", { name: /plain notice/ })).toBeNull();
  });
});
