import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { GitOpsActions, GitOpsSummary, useGitOps } from ".";
import { useAppStore } from "../../../store";
import { tokens } from "../../../theme";
import { resetMockInvoke, setMockInvoke } from "../../../test/tauri-mock";
import type { DetailNavigate } from "..";
import type {
  GitOpsDetail,
  GitOpsField,
  MergePatchResult,
  ResourceKind,
} from "../../../types";

const kindId =
  "wkcrd:flux_kustomizations|kustomize.toolkit.fluxcd.io|v1|kustomizations|Kustomization|ns";
const source: ResourceKind = {
  id: "wkcrd:flux_gitrepositories|source.toolkit.fluxcd.io|v1|gitrepositories|GitRepository|ns",
  kind: "GitRepository",
  group: "source.toolkit.fluxcd.io",
  version: "v1",
  plural: "gitrepositories",
  namespaced: true,
  category: "Apps",
  columns: [],
};
const deployment: ResourceKind = {
  id: "deployments",
  kind: "Deployment",
  group: "apps",
  version: "v1",
  plural: "deployments",
  namespaced: true,
  category: "Workloads",
  columns: [],
};
const value = (label: string, content: string | null): GitOpsField => ({
  label,
  value: content,
  reference: null,
});

function detail(): GitOpsDetail {
  return {
    meta: {
      name: "apps",
      namespace: "flux-system",
      uid: "uid",
      created_at: null,
      labels: [],
      annotations: [],
      controlled_by: null,
      generation: 2,
      managers: [],
    },
    resource_version: "42",
    notice: "Flux owns these resources.",
    cards: [
      {
        label: "Status",
        status: "Ready",
        value: null,
        caption: "Applied revision main@sha1:abc",
        at: null,
      },
      {
        label: "Revision",
        status: null,
        value: "main@sha1:abc",
        caption: "Attempted main@sha1:def",
        at: null,
      },
      { label: "Interval", status: null, value: "10m", caption: null, at: null },
    ],
    resources: [
      {
        group: "apps",
        kind: "Deployment",
        namespace: "prod",
        name: "web",
        local: true,
        sync: null,
        health: null,
        message: null,
        prune: false,
      },
    ],
    conditions: [
      {
        type: "Ready",
        status: "True",
        negative: false,
        reason: "ReconciliationSucceeded",
        message: "Applied revision",
        at: null,
        observed_generation: 1,
      },
    ],
    actions: [
      {
        id: "reconcile",
        label: "Reconcile",
        patch: {
          metadata: {
            annotations: {
              "reconcile.fluxcd.io/requestedAt": "ferrisscope:42",
            },
          },
        },
        confirmation: "Reconciliation may apply and prune resources.",
        disabled_reason: null,
      },
      {
        id: "suspend",
        label: "Suspend",
        patch: { spec: { suspend: true } },
        confirmation: "Pause reconciliation?",
        disabled_reason: null,
      },
    ],
    sections: [
      {
        title: "Build and apply",
        fields: [
          {
            ...value("Source", "GitRepository/flux-system/config"),
            reference: {
              kind: "GitRepository",
              group: source.group,
              namespace: "flux-system",
              name: "config",
              local: true,
            },
          },
          value("Path", "./clusters/production"),
          value("Target namespace", null),
        ],
        items: [],
      },
      { title: "Decryption", fields: [value("Provider", null)], items: [] },
    ],
  };
}

type HarnessProps = {
  name?: string;
  kind?: string;
  onNavigate?: DetailNavigate;
};

function Harness({ name = "apps", kind = kindId, onNavigate }: HarnessProps) {
  const ctl = useGitOps(
    {
      clusterId: "ctx",
      kindId: kind,
      namespace: "flux-system",
      name,
      detailVersion: 0,
    },
    true,
  );
  if (!ctl) return null;
  return (
    <>
      <GitOpsActions t={tokens("light")} mode="light" ctl={ctl} name={name} clusterId="ctx" />
      <GitOpsSummary ctl={ctl} clusterId="ctx" onNavigate={onNavigate} />
    </>
  );
}

beforeEach(() => {
  resetMockInvoke();
  useAppStore.setState((s) => ({
    kinds: [source, deployment],
    kindClusters: { [source.id]: ["ctx"], [deployment.id]: ["ctx"] },
    clusterHealth: {},
    clusterReconnecting: {},
    modals: [],
    toasts: [],
    settings: { ...s.settings, confirmDestructive: true },
  }));
});
afterEach(() => {
  cleanup();
  resetMockInvoke();
});

function stub(
  d = detail(),
  patch: () => MergePatchResult | Promise<MergePatchResult> = () => ({
    kind: "applied",
    resource_version: "43",
  }),
) {
  const calls: { cmd: string; args: Record<string, unknown> | undefined }[] =
    [];
  setMockInvoke((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "get_well_known_detail_cmd") return d;
    if (cmd === "gitops_run_cmd") return patch();
    if (cmd === "plugin:clipboard-manager|write_text") return undefined;
    throw new Error(`Unexpected command ${cmd}`);
  });
  return calls;
}

const patches = (calls: ReturnType<typeof stub>) =>
  calls.filter((c) => c.cmd === "gitops_run_cmd");

async function confirmAction(accepted = true) {
  await waitFor(() =>
    expect(useAppStore.getState().modals.length).toBeGreaterThan(0),
  );
  act(() => {
    useAppStore.getState().modals.at(-1)!.resolve(accepted);
  });
}

const lastToast = () => useAppStore.getState().toasts.at(-1);

describe("GitOps summary", () => {
  it("renders status cards with pill, value, and caption", async () => {
    stub();
    render(<Harness />);
    const status = await screen.findByRole("listitem", { name: "Status" });
    expect(within(status).getByText("Ready")).toBeInTheDocument();
    const revision = screen.getByRole("listitem", { name: "Revision" });
    expect(within(revision).getByText("main@sha1:abc")).toBeInTheDocument();
    expect(
      within(revision).getByText("Attempted main@sha1:def"),
    ).toBeInTheDocument();
    expect(screen.getByText("Flux owns these resources.")).toBeInTheDocument();
  });

  it("hides unreported fields and sections that are entirely empty", async () => {
    stub();
    render(<Harness />);
    await screen.findByText("./clusters/production");
    expect(screen.queryByText("Target namespace")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Decryption" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Not reported")).not.toBeInTheDocument();
  });

  it("renders conditions as rows with polarity-aware chips", async () => {
    stub();
    render(<Harness />);
    const conditions = await screen.findByRole("region", { name: "Conditions" });
    expect(within(conditions).getByText("Ready")).toBeInTheDocument();
    expect(within(conditions).getByText("True")).toBeInTheDocument();
    expect(
      within(conditions).getByText("ReconciliationSucceeded"),
    ).toBeInTheDocument();
  });

  it("flags conditions observed at an older generation", async () => {
    stub();
    render(<Harness />);
    const conditions = await screen.findByRole("region", { name: "Conditions" });
    expect(within(conditions).getByText("gen 1 (spec is at 2)")).toBeInTheDocument();
  });

  it("shows sync wave, hook, and API version on managed resources", async () => {
    const d = detail();
    d.resources = [
      { ...d.resources![0]!, kind: "Job", group: "batch", name: "migrate", version: "v1", sync_wave: -1, hook: true },
    ];
    stub(d);
    render(<Harness />);
    const region = await screen.findByRole("region", { name: "Managed resources" });
    const line = within(region).getByText(/wave -1 · hook/);
    expect(line).toHaveAttribute("title", "batch/v1");
  });

  it("omits the conditions section when none are reported", async () => {
    const d = detail();
    d.conditions = [];
    stub(d);
    render(<Harness />);
    await screen.findByText("./clusters/production");
    expect(
      screen.queryByRole("region", { name: "Conditions" }),
    ).not.toBeInTheDocument();
  });

  it("renders structured policy values as copyable sub-rows", async () => {
    const d = detail();
    d.sections.push({
      title: "Sync policy",
      fields: [
        {
          ...value("Automated", '{"prune":true,"selfHeal":false}'),
          entries: [
            ["/prune", "true"],
            ["/selfHeal", "false"],
          ],
        },
      ],
      items: [],
    });
    stub(d);
    render(<Harness />);
    expect(await screen.findByText("/prune")).toBeInTheDocument();
    expect(screen.getByText("/selfHeal")).toBeInTheDocument();
    expect(
      screen.queryByText('{"prune":true,"selfHeal":false}'),
    ).not.toBeInTheDocument();
  });

  it("navigates group-aware references and local managed resources", async () => {
    stub();
    const navigate = vi.fn();
    render(<Harness onNavigate={navigate} />);
    fireEvent.click(await screen.findByText("GitRepository/flux-system/config"));
    expect(navigate).toHaveBeenCalledWith(
      "GitRepository",
      "flux-system",
      "config",
      "ctx",
      source.group,
    );
    fireEvent.click(screen.getByText("web"));
    expect(navigate).toHaveBeenLastCalledWith(
      "Deployment",
      "prod",
      "web",
      "ctx",
      "apps",
    );
  });

  it("keeps remote resources and unavailable kinds copy-only", async () => {
    const d = detail();
    d.resources![0]!.local = false;
    stub(d);
    useAppStore.setState({ kindClusters: { [source.id]: ["other"] } });
    const navigate = vi.fn();
    render(<Harness onNavigate={navigate} />);
    fireEvent.click(await screen.findByText("GitRepository/flux-system/config"));
    fireEvent.click(screen.getByText("web"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("sorts problem resources first and summarises counts", async () => {
    const d = detail();
    const base = d.resources![0]!;
    d.resources = [
      { ...base, name: "ok", sync: "Synced", health: "Healthy" },
      { ...base, name: "drift", sync: "OutOfSync", health: "Healthy" },
      {
        ...base,
        name: "broken",
        sync: "Synced",
        health: "Degraded",
        message: "back-off",
        prune: true,
      },
    ];
    stub(d);
    render(<Harness />);
    const region = await screen.findByRole("region", {
      name: "Managed resources",
    });
    expect(
      within(region).getByText("3 · 1 out of sync · 1 not healthy"),
    ).toBeInTheDocument();
    const rows = within(region).getAllByRole("row");
    expect(rows.map((r) => within(r).getAllByText(/^(ok|drift|broken)$/)[0]!.textContent)).toEqual([
      "broken",
      "drift",
      "ok",
    ]);
    expect(within(rows[0]!).getByText("back-off")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("Prune")).toBeInTheDocument();
  });

  it("limits large resource lists and lets operators expand them", async () => {
    const d = detail();
    d.resources = Array.from({ length: 25 }, (_, i) => ({
      ...d.resources![0]!,
      name: `res-${i}`,
    }));
    stub(d);
    render(<Harness />);
    await screen.findByText("res-0");
    expect(screen.queryByText("res-24")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Show 15 more"));
    expect(screen.getByText("res-24")).toBeInTheDocument();
  });

  it("shows an empty state only for kinds that track resources", async () => {
    const d = detail();
    d.resources = [];
    stub(d);
    const { unmount } = render(<Harness />);
    const region = await screen.findByRole("region", {
      name: "Managed resources",
    });
    expect(within(region).getByText("None reported.")).toBeInTheDocument();
    unmount();
    const none = detail();
    none.resources = null;
    stub(none);
    render(<Harness />);
    await screen.findByText("./clusters/production");
    expect(
      screen.queryByRole("region", { name: "Managed resources" }),
    ).not.toBeInTheDocument();
  });

  it("shows loading and allows retry after a fetch failure", async () => {
    let reject: (e: Error) => void = () => {};
    setMockInvoke(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    render(<Harness />);
    expect(screen.getByText("Loading GitOps resource...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reconcile/ })).toBeNull();
    await act(async () => {
      reject(new Error("403 forbidden"));
    });
    expect(await screen.findByText("Access denied")).toBeInTheDocument();
    stub();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("listitem", { name: "Status" }),
    ).toBeInTheDocument();
  });
});

describe("GitOps actions", () => {
  it("confirms, prevents duplicates, runs the action by id with the seen generation, and refetches", async () => {
    let finish: (r: MergePatchResult) => void = () => {};
    const calls = stub(
      detail(),
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Harness />);
    const button = await screen.findByRole("button", { name: "Reconcile" });
    fireEvent.click(button);
    await confirmAction();
    expect(screen.getByRole("button", { name: /^Suspend/ })).toBeDisabled();
    fireEvent.click(button);
    expect(patches(calls)).toHaveLength(1);
    expect(patches(calls)[0]?.args).toEqual({
      clusterId: "ctx",
      kindId,
      namespace: "flux-system",
      name: "apps",
      request: { type: "action", id: "reconcile" },
      generation: 2,
    });
    await act(async () => {
      finish({ kind: "applied", resource_version: "43" });
    });
    await waitFor(() => expect(lastToast()?.tone).toBe("ok"));
    expect(lastToast()?.text).toMatch(/Reconcile requested for apps/);
    expect(
      calls.filter((c) => c.cmd === "get_well_known_detail_cmd"),
    ).toHaveLength(2);
  });

  it("skips the dialog when destructive confirmations are off", async () => {
    useAppStore.setState((s) => ({
      settings: { ...s.settings, confirmDestructive: false },
    }));
    const calls = stub();
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(useAppStore.getState().modals).toHaveLength(0);
  });

  it("cancels without sending a mutation", async () => {
    const calls = stub();
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Suspend" }));
    await confirmAction(false);
    expect(patches(calls)).toHaveLength(0);
    expect(await screen.findByRole("button", { name: "Suspend" })).toBeEnabled();
  });

  it("does not send a confirmed mutation after switching objects", async () => {
    const calls = stub();
    const { rerender } = render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Suspend" }));
    rerender(<Harness name="different" />);
    await confirmAction();
    expect(patches(calls)).toHaveLength(0);
  });

  it("warns on stale conflicts, reloads, and never force-retries", async () => {
    const calls = stub(detail(), () => ({
      kind: "stale",
      message: "resourceVersion changed",
    }));
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Suspend" }));
    await confirmAction();
    await waitFor(() => expect(lastToast()?.tone).toBe("warn"));
    expect(lastToast()?.text).toMatch(/changed since it was loaded/);
    expect(patches(calls)).toHaveLength(1);
    // Same resourceVersion reloaded: blocked until the object actually moves.
    const waiting = screen.getAllByRole("button", {
      name: /Waiting for the updated object/,
    });
    expect(waiting).toHaveLength(2);
    for (const b of waiting) expect(b).toBeDisabled();
  });

  it("toasts API failures without discarding detail", async () => {
    stub(detail(), () => {
      throw new Error("403 forbidden");
    });
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Suspend" }));
    await confirmAction();
    await waitFor(() => expect(lastToast()?.tone).toBe("bad"));
    expect(lastToast()?.text).toMatch(/403 forbidden/);
    expect(screen.getByText("./clusters/production")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Suspend" })).toBeEnabled();
  });

  it("explains disabled actions and blocks all of them on a degraded cluster", async () => {
    const d = detail();
    d.actions[0]!.disabled_reason = "Resume before requesting reconciliation.";
    stub(d);
    render(<Harness />);
    expect(
      await screen.findByRole("button", {
        name: "Reconcile — Resume before requesting reconciliation.",
      }),
    ).toBeDisabled();
    act(() => useAppStore.setState({ clusterHealth: { ctx: "unavailable" } }));
    expect(
      screen.getByRole("button", { name: "Suspend — Cluster unavailable" }),
    ).toBeDisabled();
  });

  it("renders Argo sync and a refresh menu with hard refresh", async () => {
    const d = detail();
    d.actions = [
      {
        id: "sync",
        label: "Sync",
        patch: { operation: { sync: { revision: "HEAD", prune: false } } },
        confirmation: "Apply the target revision?",
        disabled_reason: null,
      },
      {
        id: "refresh",
        label: "Refresh",
        patch: {
          metadata: { annotations: { "argocd.argoproj.io/refresh": "normal" } },
        },
        confirmation: null,
        disabled_reason: null,
      },
      {
        id: "hard_refresh",
        label: "Hard refresh",
        patch: {
          metadata: { annotations: { "argocd.argoproj.io/refresh": "hard" } },
        },
        confirmation: "Invalidate the cache?",
        disabled_reason: null,
      },
    ];
    const calls = stub(d);
    render(
      <Harness kind="wkcrd:argocd_applications|argoproj.io|v1alpha1|applications|Application|ns" />,
    );
    expect(await screen.findByRole("button", { name: "Sync" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Suspend/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh…" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Hard refresh")).toBeInTheDocument();
    fireEvent.click(within(menu).getByText("Refresh"));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.args?.request).toEqual({ type: "action", id: d.actions[1]!.id });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("disables sync and offers terminate while an operation is running", async () => {
    const d = detail();
    d.actions = [
      {
        id: "sync",
        label: "Sync",
        patch: { operation: { sync: {} } },
        confirmation: null,
        disabled_reason: "A sync operation is already in progress.",
      },
      {
        id: "terminate",
        label: "Terminate sync",
        patch: { status: { operationState: { phase: "Terminating" } } },
        confirmation: "Stop the running sync?",
        disabled_reason: null,
      },
    ];
    const calls = stub(d);
    render(<Harness />);
    expect(
      await screen.findByRole("button", {
        name: "Sync — A sync operation is already in progress.",
      }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Terminate sync" }));
    await confirmAction();
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0]?.args?.request).toEqual({ type: "action", id: d.actions[1]!.id });
  });

  it("renders no actions while the object is terminating", async () => {
    const d = detail();
    d.actions = [];
    stub(d);
    render(<Harness />);
    await screen.findByText("./clusters/production");
    expect(screen.queryByRole("button", { name: /Reconcile|Suspend/ })).toBeNull();
  });
});
