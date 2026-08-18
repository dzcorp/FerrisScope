import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { tokens } from "../theme";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { CloudIdentityNote } from "./CloudIdentityNote";
import type { ConnectHint } from "../types";

const t = tokens("dark");

const GCLOUD: ConnectHint = {
  provider: "gcloud",
  title: "Unpinned Google account",
  detail:
    "This context has no --account, so it authenticates as your active gcloud account.",
  authenticated_as: "ops@example.net",
  identities: ["dev@example.com", "ops@example.net"],
  active_identity: "dev@example.com",
  pin: {
    noun: "account",
    effects: [
      "add --account to this context's exec entry in your kubeconfig",
      "keep a .ferrisscope-backup copy of the kubeconfig",
      "delete ~/.kube/gke_gcloud_auth_plugin_cache",
    ],
  },
  reauth: null,
  unblock: null,
};

const AWS: ConnectHint = {
  provider: "aws",
  title: "Unpinned AWS profile",
  detail: "This context names no profile, so it authenticates as dev.",
  authenticated_as: "arn:aws:sts::111122223333:assumed-role/Dev/session",
  identities: ["default", "dev"],
  active_identity: "dev",
  pin: {
    noun: "profile",
    effects: [
      "set AWS_PROFILE in this context's exec env block in your kubeconfig",
      "keep a .ferrisscope-backup copy of the kubeconfig",
    ],
  },
  reauth: null,
  unblock: null,
};

const AZURE: ConnectHint = {
  provider: "azure",
  title: "Ambient Azure account",
  detail:
    "kubelogin has no per-context account flag, so switch with `az account set --subscription <id>` and reconnect.",
  authenticated_as: "ops@example.net",
  identities: ["guest@example.com", "ops@example.net"],
  active_identity: "ops@example.net",
  // The whole point of the Azure case: nothing to write, so no button.
  pin: null,
  reauth: null,
  unblock: null,
};

// A lapsed Google session: the plugin never produced a token, so there is no
// apiserver identity to report and nothing a pin could fix.
const REAUTH: ConnectHint = {
  provider: "gcloud",
  title: "Google session expired",
  detail:
    "The Google session for ops@example.net has expired, so gke-gcloud-auth-plugin could not mint a token. Run the command below in a terminal, then reconnect.",
  authenticated_as: null,
  identities: ["dev@example.com", "ops@example.net"],
  active_identity: "dev@example.com",
  pin: null,
  reauth: {
    command: "gcloud auth login --account=ops@example.net",
    account: "ops@example.net",
  },
  unblock: null,
};

const BLOCKED: ConnectHint = {
  provider: "gcloud",
  title: "macOS blocked the auth plugin",
  detail:
    'The OS refused to run `/Users/u/Downloads/google-cloud-sdk/bin/gcloud` ("Operation not permitted"), so no token could be minted.',
  authenticated_as: null,
  identities: [],
  active_identity: null,
  pin: null,
  reauth: null,
  unblock: {
    path: "/Users/u/Downloads/google-cloud-sdk/bin/gcloud",
    settings_url:
      "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders",
    command:
      "xattr -r -d com.apple.quarantine '/Users/u/Downloads/google-cloud-sdk'",
  },
};

const REASON =
  'apiserver liveness probe failed: User "ops@example.net" ... Forbidden';

function renderNote(onReconnect = () => {}) {
  return render(
    <CloudIdentityNote
      t={t}
      contextId="default::prod"
      reason={REASON}
      onReconnect={onReconnect}
    />,
  );
}

beforeEach(() => {
  resetMockInvoke();
});

describe("CloudIdentityNote", () => {
  it("renders nothing when the backend doesn't recognise the failure", async () => {
    setMockInvoke((cmd) => {
      expect(cmd).toBe("connect_hint_cmd");
      return null;
    });

    const { container } = render(
      <CloudIdentityNote
        t={t}
        contextId="default::prod"
        reason="connection refused"
        onReconnect={() => {}}
      />,
    );

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("renders nothing when the hint lookup itself fails", async () => {
    // A broken hint lookup must never replace the real connect error, which is
    // rendered by the banner above this component.
    setMockInvoke(() => {
      throw new Error("boom");
    });

    const { container } = renderNote();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("passes the error verbatim and renders both identities", async () => {
    let seenArgs: Record<string, unknown> | undefined;
    setMockInvoke((cmd, args) => {
      expect(cmd).toBe("connect_hint_cmd");
      seenArgs = args;
      return GCLOUD;
    });

    renderNote();

    await waitFor(() => {
      expect(screen.getByText(/Unpinned Google account/)).toBeInTheDocument();
    });
    expect(seenArgs).toEqual({ name: "default::prod", error: REASON });
    // Both identities are spelled out — the one the apiserver saw and the one
    // the CLI would hand out now. (Scoped to the note because the same strings
    // also appear as <option>s in the picker below.)
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent("apiserver saw");
    expect(note).toHaveTextContent("ops@example.net");
    expect(note).toHaveTextContent("CLI active");
    expect(note).toHaveTextContent("dev@example.com");
    // The active identity is preselected — "pin me to what I'm on now" is the
    // overwhelmingly likely intent. The `Select` atom is a button, so the
    // selection shows as its label rather than a form value.
    expect(screen.getByRole("combobox")).toHaveTextContent("dev@example.com");
  });

  it("requires the confirm step before pinning, then reconnects", async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    setMockInvoke((cmd, args) => {
      calls.push({ cmd, args });
      return cmd === "connect_hint_cmd" ? GCLOUD : undefined;
    });
    const onReconnect = vi.fn();

    renderNote(onReconnect);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^pin account$/i }),
      ).toBeInTheDocument();
    });

    // First click only opens the confirm — it must not write anything.
    fireEvent.click(screen.getByRole("button", { name: /^pin account$/i }));
    expect(calls.some((c) => c.cmd === "pin_cloud_identity_cmd")).toBe(false);
    // Every backend-declared effect is disclosed before the operator commits.
    for (const effect of GCLOUD.pin?.effects ?? []) {
      expect(screen.getByText(effect)).toBeInTheDocument();
    }

    fireEvent.click(
      screen.getByRole("button", { name: /pin dev@example\.com/i }),
    );

    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
    expect(calls.at(-1)).toEqual({
      cmd: "pin_cloud_identity_cmd",
      args: { name: "default::prod", identity: "dev@example.com" },
    });
  });

  it("blocks a second pin while the first is still in flight", async () => {
    // This button rewrites the operator's kubeconfig. Two concurrent pins would
    // both read the same snapshot, and the second would trip the backend's
    // lost-update guard — surfacing "changed on disk" for what is really just a
    // double-click.
    const calls: string[] = [];
    // Boxed so TypeScript doesn't narrow it to `null` at the call site below —
    // it can't see that the Promise executor runs synchronously.
    const release: { fn: (() => void) | null } = { fn: null };
    setMockInvoke((cmd) => {
      calls.push(cmd);
      if (cmd === "connect_hint_cmd") return GCLOUD;
      return new Promise<void>((resolve) => {
        release.fn = () => resolve();
      });
    });

    renderNote();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^pin account$/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^pin account$/i }));

    const confirm = screen.getByRole("button", {
      name: /pin dev@example\.com/i,
    });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /pinning…/i })).toBeDisabled(),
    );
    // Cancel is disabled too — backing out mid-write would leave the operator
    // with no idea whether the file was rewritten.
    expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /pinning…/i }));
    release.fn?.();
    await waitFor(() =>
      expect(calls.filter((c) => c === "pin_cloud_identity_cmd")).toHaveLength(
        1,
      ),
    );
  });

  it("cancelling the confirm writes nothing", async () => {
    const calls: string[] = [];
    setMockInvoke((cmd) => {
      calls.push(cmd);
      return cmd === "connect_hint_cmd" ? GCLOUD : undefined;
    });

    renderNote();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^pin account$/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^pin account$/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    // Back to the picker, nothing written.
    expect(
      screen.getByRole("button", { name: /^pin account$/i }),
    ).toBeTruthy();
    expect(calls).not.toContain("pin_cloud_identity_cmd");
  });

  it("drops the previous cluster's identities when the context changes", async () => {
    // The note is mounted inside a banner that survives a cluster-tab switch.
    // Leaving the old hint on screen would offer to pin *this* context to an
    // account discovered for a different one.
    setMockInvoke((cmd, args) => {
      if (cmd !== "connect_hint_cmd") return undefined;
      return (args as { name: string }).name === "default::prod"
        ? GCLOUD
        : AWS;
    });

    const { rerender } = render(
      <CloudIdentityNote
        t={t}
        contextId="default::prod"
        reason={REASON}
        onReconnect={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("note")).toHaveTextContent(
        "Unpinned Google account",
      ),
    );

    rerender(
      <CloudIdentityNote
        t={t}
        contextId="default::other"
        reason={REASON}
        onReconnect={() => {}}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("note")).toHaveTextContent(
        "Unpinned AWS profile",
      ),
    );
    expect(screen.getByRole("note")).not.toHaveTextContent(
      "Unpinned Google account",
    );
  });

  it("never preselects an identity the picker cannot show", async () => {
    // gcloud builds `identities` from `legacy_credentials/` and
    // `active_identity` from the configuration file, so `gcloud auth revoke`
    // leaves an active account with no credentials and no matching option.
    // Unclamped, the picker renders blank while the enabled button writes that
    // invisible account into the kubeconfig.
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    setMockInvoke((cmd, args) => {
      calls.push({ cmd, args });
      return cmd === "connect_hint_cmd"
        ? { ...GCLOUD, active_identity: "revoked@example.com" }
        : undefined;
    });

    renderNote();
    await waitFor(() =>
      expect(screen.getByRole("combobox")).toBeInTheDocument(),
    );
    // Falls back to the first offered identity, not the phantom active one.
    expect(screen.getByRole("combobox")).toHaveTextContent("dev@example.com");

    fireEvent.click(screen.getByRole("button", { name: /^pin account$/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /pin dev@example\.com/i }),
    );
    await waitFor(() =>
      expect(calls.at(-1)?.args).toEqual({
        name: "default::prod",
        identity: "dev@example.com",
      }),
    );
  });

  it("pins the identity the operator selected, not the default", async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    setMockInvoke((cmd, args) => {
      calls.push({ cmd, args });
      return cmd === "connect_hint_cmd" ? GCLOUD : undefined;
    });

    renderNote();

    await waitFor(() =>
      expect(screen.getByRole("combobox")).toBeInTheDocument(),
    );
    // jsdom has no layout, so the Select's scroll-into-view is a no-op here.
    Element.prototype.scrollIntoView ??= () => {};
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(
      screen.getByRole("option", { name: "ops@example.net" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^pin account$/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /pin ops@example\.net/i }),
    );

    await waitFor(() => {
      expect(calls.at(-1)?.args).toEqual({
        name: "default::prod",
        identity: "ops@example.net",
      });
    });
  });

  it("takes its wording from the provider — AWS says profile, not account", async () => {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
    setMockInvoke((cmd, args) => {
      calls.push({ cmd, args });
      return cmd === "connect_hint_cmd" ? AWS : undefined;
    });

    renderNote();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^pin profile$/i }),
      ).toBeInTheDocument();
    });
    // No gcloud vocabulary leaks into the AWS case.
    const note = screen.getByRole("note");
    expect(note).not.toHaveTextContent(/account/i);
    expect(note).toHaveTextContent(
      "arn:aws:sts::111122223333:assumed-role/Dev/session",
    );

    fireEvent.click(screen.getByRole("button", { name: /^pin profile$/i }));
    // The AWS confirm must not mention a token cache — there isn't one.
    expect(screen.queryByText(/plugin_cache/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /pin dev/i }));

    await waitFor(() => {
      expect(calls.at(-1)).toEqual({
        cmd: "pin_cloud_identity_cmd",
        args: { name: "default::prod", identity: "dev" },
      });
    });
  });

  it("offers no pin UI at all when the provider has none (Azure)", async () => {
    setMockInvoke((cmd) => {
      expect(cmd).toBe("connect_hint_cmd");
      return AZURE;
    });

    renderNote();

    await waitFor(() => {
      expect(screen.getByText(/Ambient Azure account/)).toBeInTheDocument();
    });
    // No picker, no button — the remedy is prose, because kubelogin has no
    // per-context account flag to write.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("az account set");
  });

  it("surfaces a failed pin without losing the note", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "connect_hint_cmd") return GCLOUD;
      throw new Error("kubeconfig is read-only");
    });

    renderNote();

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /^pin account$/i }),
      ).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /^pin account$/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /pin dev@example\.com/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/kubeconfig is read-only/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Unpinned Google account/)).toBeInTheDocument();
  });
  it("offers the login command when the session lapsed", async () => {
    setMockInvoke((cmd) => {
      expect(cmd).toBe("connect_hint_cmd");
      return REAUTH;
    });
    const onReconnect = vi.fn();

    renderNote(onReconnect);

    await waitFor(() => {
      expect(screen.getByText(/Google session expired/)).toBeInTheDocument();
    });
    const note = screen.getByRole("note");
    // The exact command, including the account flag — an operator with several
    // accounts renewing the wrong one is back where they started.
    expect(note).toHaveTextContent("gcloud auth login --account=ops@example.net");
    // No pin offered: the account is fine, its session isn't, and pinning would
    // edit the kubeconfig for nothing.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^pin/i }),
    ).not.toBeInTheDocument();
    // And no "apiserver saw" row: the plugin failed before any apiserver call.
    expect(note).not.toHaveTextContent("apiserver saw");
    // No retry button of its own — the enclosing banner already carries
    // Reconnect, wired to this same callback.
    expect(
      screen.queryByRole("button", { name: /retry connect/i }),
    ).not.toBeInTheDocument();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("copies the login command on click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    setMockInvoke(() => REAUTH);

    renderNote();

    await waitFor(() => {
      expect(screen.getByText(/Google session expired/)).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByText("gcloud auth login --account=ops@example.net"),
    );
    expect(writeText).toHaveBeenCalledWith(
      "gcloud auth login --account=ops@example.net",
    );
  });
  it("runs the login in a PTY and reconnects when gcloud exits cleanly", async () => {
    let channel: { onmessage: (m: unknown) => void } | undefined;
    let loginArgs: Record<string, unknown> | undefined;
    const closed: unknown[] = [];
    setMockInvoke((cmd, args) => {
      if (cmd === "connect_hint_cmd") return REAUTH;
      if (cmd === "terminal_close") {
        closed.push(args);
        return undefined;
      }
      expect(cmd).toBe("cloud_login_open");
      loginArgs = args;
      channel = args?.onEvent as { onmessage: (m: unknown) => void };
      return "t1";
    });
    const onReconnect = vi.fn();

    renderNote(onReconnect);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^log in$/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /^log in$/i }));

    await waitFor(() => expect(channel).toBeDefined());
    // The failing context's own account, not the CLI's active one.
    expect(loginArgs?.clusterId).toBe("default::prod");
    expect(loginArgs?.account).toBe("ops@example.net");
    // Button locks while the browser round trip is outstanding, so a second
    // click can't spawn a second gcloud.
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /waiting for browser/i }),
      ).toBeDisabled();
    });

    // gcloud's own output is shown verbatim ("aGk=" is "hi").
    channel?.onmessage({ kind: "data", b64: "aGk=" });
    await waitFor(() => {
      expect(screen.getByRole("note")).toHaveTextContent("hi");
    });

    channel?.onmessage({ kind: "exit", code: 0 });
    await waitFor(() => expect(onReconnect).toHaveBeenCalledTimes(1));
    // The session must be closed, not merely detached: the backend keeps its
    // registry entry otherwise, which both leaks the gcloud child and stops the
    // terminal token slot from ever being reclaimed.
    await waitFor(() => expect(closed).toEqual([{ sessionId: "t1" }]));
  });

  it("keeps the failure visible and does not reconnect when gcloud fails", async () => {
    let channel: { onmessage: (m: unknown) => void } | undefined;
    const closed: unknown[] = [];
    setMockInvoke((cmd, args) => {
      if (cmd === "connect_hint_cmd") return REAUTH;
      if (cmd === "terminal_close") {
        closed.push(args);
        return undefined;
      }
      channel = args?.onEvent as { onmessage: (m: unknown) => void };
      return "t2";
    });
    const onReconnect = vi.fn();

    renderNote(onReconnect);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^log in$/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /^log in$/i }));
    await waitFor(() => expect(channel).toBeDefined());

    channel?.onmessage({ kind: "exit", code: 1 });

    await waitFor(() => {
      expect(screen.getByRole("note")).toHaveTextContent(
        "[gcloud exited with code 1]",
      );
    });
    expect(onReconnect).not.toHaveBeenCalled();
    await waitFor(() => expect(closed).toEqual([{ sessionId: "t2" }]));
    // Retryable: the button comes back rather than staying stuck on "Waiting".
    expect(screen.getByRole("button", { name: /^log in$/i })).toBeEnabled();
    // The copyable command is still there as the manual fallback.
    expect(screen.getByRole("note")).toHaveTextContent(
      "gcloud auth login --account=ops@example.net",
    );
  });

  it("shows the spawn error when gcloud can't be started at all", async () => {
    // e.g. the account failed validation, or gcloud isn't on the PATH the app
    // sees. Without this the button would spin forever on a rejected promise.
    setMockInvoke((cmd) => {
      if (cmd === "connect_hint_cmd") return REAUTH;
      throw new Error("spawn: No such file or directory (os error 2)");
    });

    renderNote();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^log in$/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /^log in$/i }));

    await waitFor(() => {
      expect(screen.getByRole("note")).toHaveTextContent("No such file");
    });
    expect(screen.getByRole("button", { name: /^log in$/i })).toBeEnabled();
  });

  it("offers no login button when the failure is drift, not a lapsed session", async () => {
    setMockInvoke(() => GCLOUD);
    renderNote();
    await waitFor(() => {
      expect(screen.getByText(/Unpinned Google account/)).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /^log in$/i }),
    ).not.toBeInTheDocument();
  });
  it("closes the login session when the note unmounts mid-login", async () => {
    // Cluster switch, or a reconnect that succeeded from another path: the
    // note is gone but gcloud is still waiting on a browser. Without a close
    // the registry entry (and the live child) survives until the cluster
    // disconnects — and while it does, the terminal token slot is never
    // reclaimed.
    const closed: unknown[] = [];
    setMockInvoke((cmd, args) => {
      if (cmd === "connect_hint_cmd") return REAUTH;
      if (cmd === "cloud_login_open") return "t7";
      expect(cmd).toBe("terminal_close");
      closed.push(args);
      return undefined;
    });

    const view = renderNote();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^log in$/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /^log in$/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /waiting for browser/i }),
      ).toBeDisabled();
    });

    view.unmount();
    // Whichever side loses the race — unmount before or after the open ack —
    // exactly one close must land.
    await waitFor(() => expect(closed).toEqual([{ sessionId: "t7" }]));
  });

  it("closes the session even when the exit frame outruns the open ack", async () => {
    // A spawn that dies instantly can deliver its exit frame before the invoke
    // promise resolves. The session id only exists on that promise, so the
    // close has to happen when the ack finally lands — otherwise the registry
    // entry leaks and a later Log in click overwrites the only reference.
    const closed: unknown[] = [];
    setMockInvoke((cmd, args) => {
      if (cmd === "connect_hint_cmd") return REAUTH;
      if (cmd === "terminal_close") {
        closed.push(args);
        return undefined;
      }
      expect(cmd).toBe("cloud_login_open");
      const channel = args?.onEvent as { onmessage: (m: unknown) => void };
      channel.onmessage({ kind: "exit", code: 1 });
      return "t8";
    });

    renderNote();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^log in$/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /^log in$/i }));

    await waitFor(() => expect(closed).toEqual([{ sessionId: "t8" }]));
    // And the surface recovered: failure reported, button back for a retry.
    expect(screen.getByRole("note")).toHaveTextContent(
      "[gcloud exited with code 1]",
    );
    expect(screen.getByRole("button", { name: /^log in$/i })).toBeEnabled();
  });

  it("closes an in-flight login when the failure context changes", async () => {
    // A new connect error re-runs the hint lookup and resets the note's state.
    // Forgetting the session id without closing it would orphan the previous
    // attempt's PTY.
    const closed: unknown[] = [];
    setMockInvoke((cmd, args) => {
      if (cmd === "connect_hint_cmd") return REAUTH;
      if (cmd === "cloud_login_open") return "t10";
      expect(cmd).toBe("terminal_close");
      closed.push(args);
      return undefined;
    });

    const view = render(
      <CloudIdentityNote
        t={t}
        contextId="default::prod"
        reason={REASON}
        onReconnect={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^log in$/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /^log in$/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /waiting for browser/i }),
      ).toBeDisabled();
    });

    view.rerender(
      <CloudIdentityNote
        t={t}
        contextId="default::prod"
        reason={`${REASON} (attempt 2)`}
        onReconnect={() => {}}
      />,
    );
    await waitFor(() => expect(closed).toEqual([{ sessionId: "t10" }]));
    // The reset also unsticks the button for the fresh failure.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^log in$/i })).toBeEnabled();
    });
  });

  it("can abandon a login that is going nowhere", async () => {
    // gcloud can sit on a question this surface cannot answer, so the operator
    // needs a way out that doesn't leave a PTY running or the button stuck.
    const closed: unknown[] = [];
    setMockInvoke((cmd, args) => {
      if (cmd === "connect_hint_cmd") return REAUTH;
      if (cmd === "cloud_login_open") return "t9";
      expect(cmd).toBe("terminal_close");
      closed.push(args);
      return undefined;
    });

    renderNote();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^log in$/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /^log in$/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^cancel$/i })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => {
      expect(closed).toEqual([{ sessionId: "t9" }]);
    });
    // Back to the offer, not stuck on "Waiting for browser…", and the Cancel
    // that only belongs to an in-flight login is gone.
    expect(screen.getByRole("button", { name: /^log in$/i })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: /^cancel$/i }),
    ).not.toBeInTheDocument();
  });

  it("offers the privacy grant and quarantine strip when the OS blocked the plugin", async () => {
    const openCalls: string[] = [];
    setMockInvoke((cmd) => {
      if (cmd === "connect_hint_cmd") return BLOCKED;
      openCalls.push(cmd);
      return undefined;
    });

    renderNote();

    await waitFor(() => {
      expect(screen.getByText(/macOS blocked the auth plugin/)).toBeInTheDocument();
    });
    const note = screen.getByRole("note");
    // The exact strip command, targeting the SDK root — copyable verbatim.
    expect(note).toHaveTextContent(
      "xattr -r -d com.apple.quarantine '/Users/u/Downloads/google-cloud-sdk'",
    );
    // Neither a pin nor a login belongs here: no account choice and no gcloud
    // command changes an OS exec refusal.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /log in/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /open privacy settings/i }),
    );
    await waitFor(() => {
      expect(openCalls).toEqual(["open_privacy_settings_cmd"]);
    });
  });

  it("offers grant + restart, and no invented xattr, when the helper is hidden", async () => {
    // The plugin ran but could not see its gcloud: no path was named, so a
    // quarantine strip would have to be guessed. Grant and restart are the
    // honest remedies.
    const HIDDEN: ConnectHint = {
      ...BLOCKED,
      title: "macOS is hiding the gcloud SDK",
      detail:
        "The auth plugin ran, so the SDK is installed — but it could not find the `gcloud` beside it. If you have just granted this app access, restart FerrisScope to pick it up, because reconnecting will keep failing.",
      unblock: { path: null, settings_url: BLOCKED.unblock!.settings_url, command: null },
    };
    const openCalls: string[] = [];
    setMockInvoke((cmd) => {
      if (cmd === "connect_hint_cmd") return HIDDEN;
      openCalls.push(cmd);
      return undefined;
    });

    renderNote();

    await waitFor(() => {
      expect(screen.getByText(/hiding the gcloud SDK/)).toBeInTheDocument();
    });
    const note = screen.getByRole("note");
    expect(note).not.toHaveTextContent("xattr");
    expect(note).toHaveTextContent(/restart/i);
    expect(
      screen.getByRole("button", { name: /open privacy settings/i }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /restart ferrisscope/i }),
    );
    await waitFor(() => {
      expect(openCalls).toEqual(["restart_app_cmd"]);
    });
  });

  it("offers a restart on the blocked note, because a grant misses this process", async () => {
    const openCalls: string[] = [];
    setMockInvoke((cmd) => {
      if (cmd === "connect_hint_cmd") return BLOCKED;
      openCalls.push(cmd);
      return undefined;
    });

    renderNote();

    await waitFor(() => {
      expect(screen.getByText(/macOS blocked the auth plugin/)).toBeInTheDocument();
    });
    // macOS fixes file-access rights at launch, so granting now cannot reach
    // the running app. Telling the operator to "reconnect" sends them in a
    // loop that always refuses; the copy has to say restart.
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(/restart/i);
    expect(note).not.toHaveTextContent(/then reconnect/i);

    fireEvent.click(
      screen.getByRole("button", { name: /restart ferrisscope/i }),
    );
    await waitFor(() => {
      expect(openCalls).toEqual(["restart_app_cmd"]);
    });
  });

  it("drops the strip command from the blocked note when no path was parsed", async () => {
    setMockInvoke(() => ({
      ...BLOCKED,
      unblock: { ...BLOCKED.unblock!, path: null, command: null },
    }));

    renderNote();

    await waitFor(() => {
      expect(screen.getByText(/macOS blocked the auth plugin/)).toBeInTheDocument();
    });
    expect(screen.getByRole("note")).not.toHaveTextContent("xattr");
    // The grant remedy stands on its own.
    expect(
      screen.getByRole("button", { name: /open privacy settings/i }),
    ).toBeInTheDocument();
  });
});
