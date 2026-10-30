import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { tokens } from "../theme";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { CloudIdentityModal, CloudIdentityPanel } from "./CloudIdentityPanel";
import type { IdentityStatus } from "../types";

const t = tokens("dark");

const PINNED: IdentityStatus = {
  provider: "gcloud",
  detail: "This context is pinned to old@example.com, whatever account gcloud has active.",
  pinned_identity: "old@example.com",
  active_identity: "new@example.com",
  identities: ["new@example.com", "old@example.com"],
  suggested_identity: "new@example.com",
  pin: {
    noun: "account",
    effects: ["replace the account this context's exec entry names"],
  },
  pin_blocked: null,
};

beforeEach(() => {
  resetMockInvoke();
});

describe("CloudIdentityPanel", () => {
  it("repins, then re-reads the status and tells the caller", async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    let status = PINNED;
    setMockInvoke((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "cloud_identity_status_cmd") return status;
      if (cmd === "pin_cloud_identity_cmd") {
        status = { ...PINNED, pinned_identity: "new@example.com", suggested_identity: null };
        return undefined;
      }
      return [];
    });
    const onPinned = vi.fn();

    render(<CloudIdentityPanel t={t} contextId="default::prod" onPinned={onPinned} />);
    await waitFor(() =>
      expect(screen.getByText(/pinned to old@example\.com, whatever/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("combobox")).toHaveTextContent("new@example.com");
    fireEvent.click(screen.getByRole("button", { name: /^pin account$/i }));
    fireEvent.click(screen.getByRole("button", { name: /pin new@example\.com/i }));

    await waitFor(() => expect(onPinned).toHaveBeenCalledTimes(1));
    expect(calls.find((c) => c.cmd === "pin_cloud_identity_cmd")?.args).toEqual({
      name: "default::prod",
      identity: "new@example.com",
    });
    await waitFor(() =>
      expect(
        calls.filter((c) => c.cmd === "cloud_identity_status_cmd"),
      ).toHaveLength(2),
    );
  });

  it("withholds the picker when the pin would be refused", async () => {
    setMockInvoke(() => ({
      ...PINNED,
      pin_blocked: "User 'u' is shared with other-ctx, so a pin here would re-point it too.",
    }));
    render(<CloudIdentityPanel t={t} contextId="default::prod" onPinned={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/shared with other-ctx/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("explains, without a picker, when the provider has no pin", async () => {
    setMockInvoke(() => ({
      ...PINNED,
      provider: "azure",
      detail: "Switch it with `az account set --subscription <id>`.",
      pinned_identity: null,
      pin: null,
    }));
    render(<CloudIdentityPanel t={t} contextId="default::aks" onPinned={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/az account set/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says why there is nothing to change", async () => {
    setMockInvoke(() => null);
    render(<CloudIdentityPanel t={t} contextId="ssh::x" onPinned={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/no cloud identity to change here/i)).toBeInTheDocument(),
    );
  });

  it("surfaces a failed status read", async () => {
    setMockInvoke(() => {
      throw new Error("kubeconfig parse error");
    });
    render(<CloudIdentityPanel t={t} contextId="default::prod" onPinned={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/kubeconfig parse error/)).toBeInTheDocument(),
    );
  });
});

describe("CloudIdentityPanel context switch", () => {
  it("never shows the previous context's identities under a new one", async () => {
    const pending: { fn: ((v: IdentityStatus) => void) | null } = { fn: null };
    setMockInvoke((_cmd, args) => {
      if ((args as { name: string }).name === "default::prod") return PINNED;
      return new Promise<IdentityStatus>((resolve) => {
        pending.fn = resolve;
      });
    });
    const { rerender } = render(
      <CloudIdentityPanel t={t} contextId="default::prod" onPinned={() => {}} />,
    );
    await waitFor(() => expect(screen.getByRole("combobox")).toBeInTheDocument());

    rerender(<CloudIdentityPanel t={t} contextId="default::other" onPinned={() => {}} />);
    await waitFor(() => expect(screen.getByText(/reading kubeconfig/i)).toBeInTheDocument());
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    pending.fn?.({ ...PINNED, detail: "other context" });
    await waitFor(() => expect(screen.getByText("other context")).toBeInTheDocument());
  });
});

describe("CloudIdentityModal", () => {
  it("names the context and closes", async () => {
    setMockInvoke(() => PINNED);
    const onClose = vi.fn();
    render(
      <CloudIdentityModal
        t={t}
        contextId="default::prod"
        contextName="prod"
        onPinned={() => {}}
        onClose={onClose}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Cloud identity");
    expect(dialog).toHaveTextContent("prod");
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
