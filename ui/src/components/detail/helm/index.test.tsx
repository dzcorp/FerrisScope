import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HelmActions, HelmReleaseSummary, useHelmRelease } from ".";
import { VALUES_CONFIRM } from "./useHelmRelease";
import { useAppStore } from "../../../store";
import { tokens } from "../../../theme";
import { resetMockInvoke, setMockInvoke } from "../../../test/tauri-mock";
import type { HelmReleaseDetail, HelmRollbackResult, HelmUpgradeResult } from "../../../types";

vi.mock("@monaco-editor/react", () => ({
  default: ({
    value,
    onChange,
    options,
  }: {
    value: string;
    onChange?: (v: string) => void;
    options?: { readOnly?: boolean };
  }) => (
    <textarea
      data-testid="monaco"
      value={value}
      readOnly={options?.readOnly}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

function release(): HelmReleaseDetail {
  const entry = (revision: number, status: string, chart_version: string) => ({
    revision,
    status,
    updated: "2026-01-02T00:00:00Z",
    description: `Revision ${revision}`,
    chart: `podinfo-${chart_version}`,
    chart_version,
    app_version: `app-${chart_version}`,
  });
  return {
    name: "web",
    namespace: "prod",
    revision: 3,
    status: "deployed",
    description: "Upgrade complete",
    first_deployed: "2026-01-01T00:00:00Z",
    last_deployed: "2026-01-02T00:00:00Z",
    deleted: null,
    notes: "Visit http://web.prod",
    chart: "podinfo-6.5.0",
    chart_name: "podinfo",
    chart_version: "6.5.0",
    app_version: "6.5.0",
    chart_description: "demo chart",
    chart_home: "https://podinfo.dev",
    chart_icon: null,
    chart_sources: [],
    chart_keywords: ["demo"],
    values_user: { replicaCount: 2 },
    values_chart_defaults: { replicaCount: 1 },
    manifest: "kind: Service\n",
    hooks: [],
    resources: [
      {
        group: "apps",
        kind: "Deployment",
        namespace: "prod",
        name: "web-podinfo",
        local: true,
        sync: null,
        health: null,
        message: null,
        prune: false,
      },
    ],
    hooks_resources: [
      {
        group: "batch",
        kind: "Job",
        namespace: "prod",
        name: "web-migrate",
        local: true,
        sync: null,
        health: null,
        message: "pre-install · Succeeded",
        prune: false,
      },
    ],
    cards: [
      { label: "Status", status: "deployed", value: null, caption: "Upgrade complete", at: null },
      { label: "Revision", status: null, value: "3", caption: null, at: null },
    ],
    history: [entry(3, "deployed", "6.5.0"), entry(2, "superseded", "6.4.0"), entry(1, "superseded", "6.3.0")],
    helm_available: true,
    update_available: { source: "podinfo", version: "6.6.0", app_version: "6.6.0" },
  };
}

type Call = { cmd: string; args: Record<string, unknown> | undefined };

function stub(
  d: HelmReleaseDetail | (() => HelmReleaseDetail) = release(),
  results: {
    upgrade?: () => HelmUpgradeResult | Promise<HelmUpgradeResult>;
    rollback?: () => HelmRollbackResult;
  } = {},
) {
  const calls: Call[] = [];
  setMockInvoke((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "get_helm_release_detail_cmd") return typeof d === "function" ? d() : d;
    if (cmd === "resolve_object_statuses_cmd") return { items: [] };
    if (cmd === "upgrade_helm_release_cmd")
      return (results.upgrade ?? (() => ({ kind: "upgraded", revision: 4, status: "deployed", elapsed_ms: 5, helm_stdout: "{}" })))();
    if (cmd === "helm_rollback_cmd")
      return (results.rollback ?? (() => ({ kind: "rolled_back", revision: 4, elapsed_ms: 5, helm_stdout: "{}" })))();
    if (cmd === "helm_repo_update_cmd") return 42;
    throw new Error(`Unexpected command ${cmd}`);
  });
  return calls;
}

const of = (calls: Call[], cmd: string) => calls.filter((c) => c.cmd === cmd);
const lastToast = () => useAppStore.getState().toasts.at(-1);

async function answerConfirm(accepted = true) {
  await waitFor(() => expect(useAppStore.getState().modals.length).toBeGreaterThan(0));
  const modal = useAppStore.getState().modals.at(-1)!;
  act(() => {
    useAppStore.setState({ modals: [] });
    modal.resolve(accepted);
  });
  return modal;
}

function Harness({ namespace = "prod", detailVersion = 0 }: { namespace?: string | null; detailVersion?: number }) {
  const ctl = useHelmRelease({ clusterId: "ctx", namespace, name: "web", detailVersion }, true);
  if (!ctl) return null;
  return (
    <>
      <HelmActions t={tokens("light")} mode="light" ctl={ctl} />
      <HelmReleaseSummary ctl={ctl} clusterId="ctx" />
    </>
  );
}

beforeEach(() => {
  resetMockInvoke();
  useAppStore.setState((s) => ({
    kinds: [],
    kindClusters: {},
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

describe("Helm release summary", () => {
  it("renders cards, notes, resources, hooks and history", async () => {
    stub();
    render(<Harness />);
    const status = await screen.findByRole("listitem", { name: "Status" });
    expect(within(status).getByText("deployed")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Notes" })).getByText("Visit http://web.prod")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Managed resources" })).getByText("web-podinfo")).toBeInTheDocument();
    const hooks = screen.getByRole("region", { name: "Hooks" });
    expect(within(hooks).getByText("web-migrate")).toBeInTheDocument();
    expect(within(hooks).getByText("pre-install · Succeeded")).toBeInTheDocument();
    const history = screen.getByRole("table", { name: "History" });
    const rows = within(history).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("current")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("6.4.0")).toBeInTheDocument();
    expect(within(rows[1]!).getByRole("button", { name: "Rollback" })).toBeEnabled();
  });

  it("renders the header actions", async () => {
    stub();
    render(<Harness />);
    expect(await screen.findByRole("button", { name: "Upgrade to 6.6.0" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Rollback…" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Update repos" })).toBeEnabled();
  });

  it("hides upgrade and notes when not applicable", async () => {
    const d = release();
    d.update_available = null;
    d.notes = "  ";
    stub(d);
    render(<Harness />);
    await screen.findByRole("button", { name: "Rollback…" });
    expect(screen.queryByRole("button", { name: /Upgrade to/ })).toBeNull();
    expect(screen.queryByRole("region", { name: "Notes" })).toBeNull();
  });

  it("shows an error with retry, and never fetches without a namespace", async () => {
    setMockInvoke(() => {
      throw new Error("403 forbidden");
    });
    const { unmount } = render(<Harness />);
    expect(await screen.findByText("Access denied")).toBeInTheDocument();
    stub();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("listitem", { name: "Status" })).toBeInTheDocument();
    unmount();
    const calls = stub();
    render(<Harness namespace={null} />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(of(calls, "get_helm_release_detail_cmd")).toHaveLength(0);
  });

  it("keeps the last good detail and an in-progress edit when a refetch fails", async () => {
    let fail = false;
    const calls: Call[] = [];
    setMockInvoke((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "resolve_object_statuses_cmd") return { items: [] };
      if (fail) throw new Error("connection reset");
      return release();
    });
    const { rerender } = render(<Harness />);
    const values = await screen.findByRole("region", { name: "Values" });
    fireEvent.click(within(values).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(values).getByTestId("monaco"), { target: { value: "replicaCount: 5\n" } });
    fail = true;
    rerender(<Harness detailVersion={1} />);
    expect(await screen.findByText(/Couldn't refresh/)).toBeInTheDocument();
    expect(within(values).getByTestId("monaco")).toHaveValue("replicaCount: 5\n");
  });
});

describe("Helm release actions", () => {
  it("upgrades to the latest chart with current values after confirming", async () => {
    const calls = stub();
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to 6.6.0" }));
    const modal = await answerConfirm();
    expect(modal.body).toMatch(/keeps its current user values/);
    await waitFor(() => expect(of(calls, "upgrade_helm_release_cmd")).toHaveLength(1));
    expect(of(calls, "upgrade_helm_release_cmd")[0]!.args).toEqual({
      clusterId: "ctx",
      namespace: "prod",
      name: "web",
      valuesYaml: "replicaCount: 2\n",
      chartSource: "podinfo",
      chartVersion: "6.6.0",
    });
    await waitFor(() => expect(lastToast()?.tone).toBe("ok"));
    expect(lastToast()?.text).toMatch(/Upgraded web to revision 4/);
    await waitFor(() => expect(of(calls, "get_helm_release_detail_cmd").length).toBeGreaterThan(1));
  });

  it("does nothing when the confirmation is declined", async () => {
    const calls = stub();
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to 6.6.0" }));
    await answerConfirm(false);
    await waitFor(() => expect(screen.getByRole("button", { name: "Upgrade to 6.6.0" })).toBeEnabled());
    expect(of(calls, "upgrade_helm_release_cmd")).toHaveLength(0);
  });

  it("surfaces a failed upgrade inline with stderr and a toast", async () => {
    stub(release(), {
      upgrade: () => ({ kind: "failed", message: "UPGRADE FAILED: timed out", helm_stderr: "Error: context deadline exceeded", elapsed_ms: 9 }),
    });
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to 6.6.0" }));
    await answerConfirm();
    await waitFor(() => expect(lastToast()?.tone).toBe("bad"));
    expect(lastToast()?.text).toMatch(/Upgrade of web failed/);
    const block = await screen.findByRole("region", { name: "Upgrade failed" });
    expect(within(block).getByText("Error: context deadline exceeded")).toBeInTheDocument();
    fireEvent.click(within(block).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region", { name: "Upgrade failed" })).toBeNull();
  });

  it("routes a helm-missing result to Settings", async () => {
    stub(release(), { upgrade: () => ({ kind: "helm_missing" }) });
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to 6.6.0" }));
    await answerConfirm();
    await waitFor(() => expect(lastToast()?.tone).toBe("bad"));
    expect(lastToast()?.text).toMatch(/helm CLI not found/);
    expect(lastToast()?.route).toEqual({ section: "tools", anchor: "helm" });
  });

  it("rolls back to the revision picked in the dialog", async () => {
    const calls = stub();
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Rollback…" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: "Revision 2" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).queryByRole("radio", { name: "Revision 3" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Revision 1" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Roll back to 1" }));
    await waitFor(() => expect(of(calls, "helm_rollback_cmd")).toHaveLength(1));
    expect(of(calls, "helm_rollback_cmd")[0]!.args).toEqual({
      clusterId: "ctx",
      namespace: "prod",
      name: "web",
      revision: 1,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(lastToast()?.text).toMatch(/Rolled back web to revision 1 \(now revision 4\)/);
  });

  it("opens the same dialog from a history row and keeps it open on failure", async () => {
    const calls = stub(release(), {
      rollback: () => ({ kind: "failed", message: "no revision", helm_stderr: "", elapsed_ms: 1 }),
    });
    render(<Harness />);
    const history = await screen.findByRole("table", { name: "History" });
    fireEvent.click(within(within(history).getAllByRole("row")[2]!).getByRole("button", { name: "Rollback" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Roll back to 2" }));
    await waitFor(() => expect(of(calls, "helm_rollback_cmd")).toHaveLength(1));
    expect(of(calls, "helm_rollback_cmd")[0]!.args?.revision).toBe(2);
    await waitFor(() => expect(lastToast()?.tone).toBe("bad"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("runs helm repo update and refetches", async () => {
    const calls = stub();
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Update repos" }));
    await waitFor(() => expect(lastToast()?.text).toMatch(/Helm repos updated in 42 ms/));
    expect(of(calls, "helm_repo_update_cmd")).toHaveLength(1);
    await waitFor(() => expect(of(calls, "get_helm_release_detail_cmd").length).toBeGreaterThan(1));
  });
});

describe("Helm release gating", () => {
  it("disables writes on a degraded cluster", async () => {
    stub();
    render(<Harness />);
    await screen.findByRole("button", { name: "Rollback…" });
    act(() => useAppStore.setState({ clusterHealth: { ctx: "unavailable" } }));
    expect(screen.getByRole("button", { name: "Rollback… — Cluster unavailable" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Upgrade to 6.6.0 — Cluster unavailable" })).toBeDisabled();
    expect(screen.getByText("read-only · cluster unavailable")).toBeInTheDocument();
  });

  it("disables helm actions and offers setup when the CLI is missing", async () => {
    const d = release();
    d.helm_available = false;
    stub(d);
    render(<Harness />);
    expect(await screen.findByRole("button", { name: "Rollback… — helm CLI not found" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Update repos — helm CLI not found" })).toBeDisabled();
    const history = screen.getByRole("table", { name: "History" });
    expect(within(within(history).getAllByRole("row")[2]!).getByRole("button", { name: "Rollback" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Set up helm…" }));
    expect(useAppStore.getState().settingsTarget).toEqual({ section: "tools", anchor: "helm" });
  });

  it("blocks writes while a helm operation is pending", async () => {
    const d = release();
    d.status = "pending-upgrade";
    stub(d);
    render(<Harness />);
    expect(
      await screen.findByRole("button", { name: "Rollback… — Release has an operation in progress" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Update repos" })).toBeEnabled();
    expect(screen.getByText("read-only · operation in progress")).toBeInTheDocument();
  });
});

describe("Helm values editing", () => {
  it("validates YAML before saving", async () => {
    const calls = stub();
    render(<Harness />);
    const values = await screen.findByRole("region", { name: "Values" });
    fireEvent.click(within(values).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(values).getByTestId("monaco"), { target: { value: "replicaCount: [1" } });
    expect(within(values).getByText(/YAML parse error/)).toBeInTheDocument();
    expect(within(values).queryByRole("button", { name: /Save|Apply/ })).toBeNull();
    fireEvent.change(within(values).getByTestId("monaco"), { target: { value: "- a\n" } });
    expect(within(values).getByText(/must be a YAML mapping/)).toBeInTheDocument();
    expect(of(calls, "upgrade_helm_release_cmd")).toHaveLength(0);
  });

  it("confirms and upgrades with exactly the edited values", async () => {
    const calls = stub();
    render(<Harness />);
    const values = await screen.findByRole("region", { name: "Values" });
    fireEvent.click(within(values).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(values).getByTestId("monaco"), { target: { value: "replicaCount: 5\n" } });
    fireEvent.click(within(values).getByRole("button", { name: "Save (1)" }));
    const modal = await answerConfirm();
    expect(modal.body).toBe(VALUES_CONFIRM);
    await waitFor(() => expect(of(calls, "upgrade_helm_release_cmd")).toHaveLength(1));
    expect(of(calls, "upgrade_helm_release_cmd")[0]!.args).toMatchObject({
      valuesYaml: "replicaCount: 5\n",
      chartSource: null,
      chartVersion: null,
    });
    await waitFor(() => expect(within(values).getByRole("button", { name: "Edit" })).toBeInTheDocument());
  });

  it("blocks upgrade-to-latest while a values edit is open", async () => {
    stub();
    render(<Harness />);
    const values = await screen.findByRole("region", { name: "Values" });
    fireEvent.click(within(values).getByRole("button", { name: "Edit" }));
    expect(
      screen.getByRole("button", { name: "Upgrade to 6.6.0 — Save or cancel the values edit first" }),
    ).toBeDisabled();
  });

  it("warns when the release moved on mid-edit and offers reload / apply anyway", async () => {
    let revision = 3;
    const calls = stub(() => ({ ...release(), revision }));
    const { rerender } = render(<Harness />);
    const values = await screen.findByRole("region", { name: "Values" });
    fireEvent.click(within(values).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(values).getByTestId("monaco"), { target: { value: "replicaCount: 7\n" } });
    revision = 4;
    rerender(<Harness detailVersion={1} />);
    expect(await within(values).findByText(/changed to revision 4 since you started editing revision 3/)).toBeInTheDocument();
    expect(within(values).queryByRole("button", { name: /^Save/ })).toBeNull();
    fireEvent.click(within(values).getByRole("button", { name: "Apply anyway" }));
    await answerConfirm();
    await waitFor(() => expect(of(calls, "upgrade_helm_release_cmd")).toHaveLength(1));
    expect(of(calls, "upgrade_helm_release_cmd")[0]!.args?.valuesYaml).toBe("replicaCount: 7\n");
  });

  it("reload discards the stale draft", async () => {
    let revision = 3;
    stub(() => ({ ...release(), revision }));
    const { rerender } = render(<Harness />);
    const values = await screen.findByRole("region", { name: "Values" });
    fireEvent.click(within(values).getByRole("button", { name: "Edit" }));
    revision = 4;
    rerender(<Harness detailVersion={1} />);
    fireEvent.click(await within(values).findByRole("button", { name: "Reload" }));
    expect(within(values).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(values).queryByText(/since you started editing/)).toBeNull();
  });
});
