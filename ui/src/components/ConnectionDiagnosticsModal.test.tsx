import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { tokens } from "../theme";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { ConnectionDiagnosticsModal } from "./ConnectionDiagnosticsModal";
import type { ConnectionDiagnostics } from "../types";

const t = tokens("dark");

const SAMPLE: ConnectionDiagnostics = {
  resolved_path: ["/opt/homebrew/bin", "/usr/bin"],
  exec: {
    command: "gke-gcloud-auth-plugin",
    args: ["--version"],
    resolved_path: null,
    found: false,
  },
  env_presence: [
    { key: "HOME", present: true },
    { key: "AWS_PROFILE", present: false },
  ],
};

beforeEach(() => {
  resetMockInvoke();
});

describe("ConnectionDiagnosticsModal", () => {
  it("calls diagnose_connection_cmd with the context id and renders the result", async () => {
    let seenArgs: Record<string, unknown> | undefined;
    setMockInvoke((cmd, args) => {
      expect(cmd).toBe("diagnose_connection_cmd");
      seenArgs = args;
      return SAMPLE;
    });

    render(
      <ConnectionDiagnosticsModal
        t={t}
        contextId="default::prod"
        contextName="prod"
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("gke-gcloud-auth-plugin")).toBeInTheDocument();
    });
    // The composite id (not the display name) goes to the backend.
    expect(seenArgs).toEqual({ name: "default::prod" });
    // Unfound plugin → warn chip; PATH entries + env chips present.
    expect(screen.getByText("NOT found on PATH")).toBeInTheDocument();
    expect(screen.getByText("/opt/homebrew/bin")).toBeInTheDocument();
    expect(screen.getByText(/HOME/)).toBeInTheDocument();
    expect(screen.getByText(/AWS_PROFILE/)).toBeInTheDocument();
  });

  it("invokes onClose when Close is clicked", async () => {
    setMockInvoke(() => SAMPLE);
    const onClose = vi.fn();
    render(
      <ConnectionDiagnosticsModal
        t={t}
        contextId="default::prod"
        contextName="prod"
        onClose={onClose}
      />,
    );
    await waitFor(() => screen.getByText("gke-gcloud-auth-plugin"));
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces a backend error", async () => {
    setMockInvoke(() => {
      throw new Error("boom: kubeconfig unreadable");
    });
    render(
      <ConnectionDiagnosticsModal
        t={t}
        contextId="default::prod"
        contextName="prod"
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/boom: kubeconfig unreadable/)).toBeInTheDocument();
    });
  });
});
