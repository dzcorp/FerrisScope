import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../api";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { GitOpsActions, GitOpsSummary, argoDeleteItems, useGitOps } from ".";
import { buildSyncOptions, parseSyncOptions } from "./SyncDialog";
import { useAppStore } from "../../../store";
import { tokens } from "../../../theme";
import { resetMockInvoke, setMockInvoke } from "../../../test/tauri-mock";
import type { ArgoExtras, GitOpsDetail, ResourceKind } from "../../../types";
import type { GitOpsController } from "./useGitOps";

const argoKind = "wkcrd:argocd_applications|argoproj.io|v1alpha1|applications|Application|ns";
const fluxKind = "wkcrd:flux_helmreleases|helm.toolkit.fluxcd.io|v2|helmreleases|HelmRelease|ns";
const helmChart: ResourceKind = {
  id: "wkcrd:flux_helmcharts|source.toolkit.fluxcd.io|v1|helmcharts|HelmChart|ns",
  kind: "HelmChart",
  group: "source.toolkit.fluxcd.io",
  version: "v1",
  plural: "helmcharts",
  namespaced: true,
  category: "Apps",
  columns: [],
};

function argo(over: Partial<ArgoExtras> = {}): ArgoExtras {
  return {
    sources: [{ repo: "https://git/app.git", path: "deploy", chart: null, ref: null, target_revision: "main" }],
    sync_options: ["CreateNamespace=true", "Custom=x"],
    retry: null,
    auto_sync: { enabled: false, prune: false, self_heal: false },
    operation_active: false,
    rollback_blocked: null,
    history: [
      { id: 5, revision: "bbb", deployed_at: null, started_at: null, initiated_by: "alice", source: "r", rollback: true },
      { id: 4, revision: "aaa", deployed_at: null, started_at: null, initiated_by: "automated", source: "r", rollback: true },
    ],
    sync_result: [
      { group: "apps", kind: "Deployment", namespace: "prod", name: "web", status: "SyncFailed", message: "boom", hook_type: null, hook_phase: null, sync_phase: "Sync" },
    ],
    images: ["nginx:1.27"],
    urls: ["https://web.example"],
    cascade: true,
    ...over,
  };
}

function detail(kind: "argo" | "flux" = "argo"): GitOpsDetail {
  const base: GitOpsDetail = {
    meta: { name: "app", namespace: "argocd", uid: "u", created_at: null, labels: [], annotations: [], controlled_by: null, generation: 1, managers: [] },
    resource_version: "7",
    notice: null,
    cards: [],
    resources: [
      { group: "apps", kind: "Deployment", namespace: "prod", name: "web", local: true, sync: "OutOfSync", health: "Healthy", message: null, prune: false },
      { group: "", kind: "Service", namespace: "prod", name: "web-svc", local: true, sync: "Synced", health: "Healthy", message: null, prune: false },
    ],
    conditions: [],
    actions: [],
    sections: [],
  };
  if (kind === "argo") {
    base.argo = argo();
    base.actions = [{ id: "sync", label: "Sync", patch: {}, confirmation: null, disabled_reason: null }];
  } else {
    base.flux = {
      source: { group: helmChart.group, kind: "HelmChart", namespace: "flux-system", name: "web-chart" },
      force_reset: true,
      suspended: false,
      failures: 2,
      history: [{ version: 3, status: "deployed", chart: "web", chart_version: "1.2.0", app_version: "2.0", action: "upgrade", deployed_at: null, digest: null }],
    };
    base.actions = [{ id: "reconcile", label: "Reconcile", patch: { metadata: {} }, confirmation: null, disabled_reason: null }];
  }
  return base;
}

let captured: GitOpsController | null = null;
function Harness({ kindId = argoKind }: { kindId?: string }) {
  const ctl = useGitOps({ clusterId: "ctx", kindId, namespace: "argocd", name: "app", detailVersion: 0 }, true);
  captured = ctl;
  if (!ctl) return null;
  return (
    <>
      <GitOpsActions t={tokens("light")} mode="light" ctl={ctl} name="app" clusterId="ctx" />
      <GitOpsSummary ctl={ctl} clusterId="ctx" />
    </>
  );
}

function stub(d: GitOpsDetail, statuses: unknown[] = []) {
  const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
  setMockInvoke((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "get_well_known_detail_cmd") return d;
    if (cmd === "resolve_object_statuses_cmd") return { items: statuses, truncated: false };
    if (cmd === "gitops_run_cmd" || cmd === "merge_patch_resource_cmd") return { kind: "applied", resource_version: "8" };
    if (cmd === "plugin:clipboard-manager|write_text") return undefined;
    if (cmd === "plugin:opener|open_url") return undefined;
    throw new Error(`Unexpected ${cmd}`);
  });
  return calls;
}
const runs = (calls: ReturnType<typeof stub>) => calls.filter((c) => c.cmd === "gitops_run_cmd");

beforeEach(() => {
  resetMockInvoke();
  captured = null;
  useAppStore.setState((s) => ({
    kinds: [helmChart],
    kindClusters: { [helmChart.id]: ["ctx"] },
    clusterHealth: {},
    clusterReconnecting: {},
    modals: [],
    toasts: [],
    settings: { ...s.settings, confirmDestructive: false },
  }));
});
afterEach(() => {
  cleanup();
  resetMockInvoke();
});

describe("sync options helpers", () => {
  it("round-trips known options and keeps unknown ones", () => {
    const p = parseSyncOptions(["CreateNamespace=true", "Validate=false", "PrunePropagationPolicy=background", "Foo=bar"]);
    expect(p.known).toEqual({ CreateNamespace: "true", Validate: "false" });
    expect(p.propagation).toBe("background");
    expect(p.rest).toEqual(["Foo=bar"]);
    expect(buildSyncOptions(p, true, true)).toEqual([
      "CreateNamespace=true",
      "Validate=false",
      "PrunePropagationPolicy=background",
      "Foo=bar",
    ]);
    expect(buildSyncOptions({ known: {}, propagation: "foreground", rest: [] }, true, false)).toEqual([]);
  });
});

describe("Argo sync dialog", () => {
  it("opens from the header and sends a whole-app sync with spec defaults", async () => {
    const calls = stub(detail());
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
    const dialog = screen.getByRole("dialog", { name: "Sync app" });
    expect(within(dialog).getByRole("checkbox", { name: "Auto-create namespace" })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByText("Custom=x")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(runs(calls)).toHaveLength(1));
    expect(runs(calls)[0]?.args?.request).toEqual({
      type: "sync",
      revision: "main",
      revisions: null,
      prune: false,
      dry_run: false,
      force: false,
      apply_only: false,
      sync_options: ["CreateNamespace=true", "Custom=x"],
      resources: [],
      retry: null,
    });
    expect(runs(calls)[0]?.args?.generation).toBe(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("supports selective sync, options, revision override, and retry", async () => {
    const calls = stub(detail());
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("main"), { target: { value: "v2" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Prune" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Dry run" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Server-side apply" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Retry on failure" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Out of sync" }));
    expect(within(dialog).getByText("1 of 2 resources")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Dry run" }));
    await waitFor(() => expect(runs(calls)).toHaveLength(1));
    const req = runs(calls)[0]?.args?.request as Record<string, unknown>;
    expect(req.revision).toBe("v2");
    expect(req.prune).toBe(true);
    expect(req.dry_run).toBe(true);
    expect(req.sync_options).toEqual(["CreateNamespace=true", "ServerSideApply=true", "Custom=x"]);
    expect(req.resources).toEqual([{ group: "apps", kind: "Deployment", name: "web", namespace: "prod" }]);
    expect(req.retry).toEqual({ limit: 2, backoff: { duration: "5s", factor: 2, maxDuration: "3m" } });
  });

  it("blocks submit on invalid retry and empty selection", async () => {
    stub(detail());
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "None" }));
    expect(within(dialog).getByRole("button", { name: "Sync" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "All" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Retry on failure" }));
    fireEvent.change(within(dialog).getAllByDisplayValue("2")[0]!, { target: { value: "x" } });
    expect(within(dialog).getByRole("alert")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Sync" })).toBeDisabled();
  });

  it("opens preselected from a resource row", async () => {
    const calls = stub(detail());
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync Service web-svc…" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("1 of 2 resources")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(runs(calls)).toHaveLength(1));
    expect((runs(calls)[0]?.args?.request as { resources: unknown[] }).resources).toEqual([
      { group: "", kind: "Service", name: "web-svc", namespace: "prod" },
    ]);
  });
});

describe("review regressions", () => {
  it("never widens a partial sync when a refetch drops the selected resource", async () => {
    const d = detail();
    const calls = stub(d);
    const { rerender } = render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync Service web-svc…" }));
    // The pruned Service disappears on the next refetch while the dialog is open.
    d.resources = d.resources!.filter((r) => r.kind !== "Service");
    act(() => captured!.reload());
    rerender(<Harness />);
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Sync" })).toBeDisabled());
    expect(runs(calls)).toHaveLength(0);
  });

  it("blocks a revision override under auto-sync unless dry run", async () => {
    const d = detail();
    d.argo = argo({ auto_sync: { enabled: true, prune: false, self_heal: false } });
    stub(d);
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("main"), { target: { value: "v9" } });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/Auto-sync is on/);
    expect(within(dialog).getByRole("button", { name: "Sync" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Dry run" }));
    expect(within(dialog).getByRole("button", { name: "Dry run" })).toBeEnabled();
  });

  it("accepts unlimited retry and keeps the spec's refresh flag", async () => {
    const d = detail();
    d.argo = argo({ retry: { limit: -1, refresh: true, backoff: { duration: "10s", factor: 3, maxDuration: "5m" } } });
    const calls = stub(d);
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Sync" }));
    await waitFor(() => expect(runs(calls)).toHaveLength(1));
    expect((runs(calls)[0]?.args?.request as { retry: unknown }).retry).toEqual({
      limit: -1,
      refresh: true,
      backoff: { duration: "10s", factor: 3, maxDuration: "5m" },
    });
  });

  it("does not show or act on the previous object's detail after switching targets", async () => {
    let release: (d: GitOpsDetail) => void = () => {};
    setMockInvoke((cmd, args) => {
      if (cmd !== "get_well_known_detail_cmd") return { items: [], truncated: false };
      if ((args as { name: string }).name === "app") return detail();
      return new Promise<GitOpsDetail>((r) => {
        release = r;
      });
    });
    function Switcher({ name }: { name: string }) {
      const ctl = useGitOps({ clusterId: "ctx", kindId: argoKind, namespace: "argocd", name, detailVersion: 0 }, true);
      return ctl ? <GitOpsActions t={tokens("light")} mode="light" ctl={ctl} name={name} clusterId="ctx" /> : null;
    }
    const { rerender } = render(<Switcher name="app" />);
    expect(await screen.findByRole("button", { name: "Sync" })).toBeInTheDocument();
    rerender(<Switcher name="other" />);
    expect(screen.queryByRole("button", { name: "Sync" })).toBeNull();
    await act(async () => release(detail()));
    expect(await screen.findByRole("button", { name: "Sync" })).toBeInTheDocument();
  });
});

describe("Argo panels", () => {
  it("renders overview, last sync result, and history", async () => {
    stub(detail());
    const open = vi.spyOn(api, "openExternal").mockResolvedValue(undefined);
    render(<Harness />);
    expect(await screen.findByText("nginx:1.27")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "web.example" }));
    expect(open).toHaveBeenCalledWith("https://web.example");
    open.mockRestore();
    const result = screen.getByRole("table", { name: "Last sync result" });
    expect(within(result).getByText("boom")).toBeInTheDocument();
    const history = screen.getByRole("table", { name: "Deployment history" });
    expect(within(history).getByText("current")).toBeInTheDocument();
    expect(within(history).getByText("automated")).toBeInTheDocument();
  });

  it("rolls back through the dialog", async () => {
    const calls = stub(detail());
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Rollback" }));
    const dialog = screen.getByRole("dialog", { name: "Roll back app to deployment 4" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Prune" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Rollback" }));
    await waitFor(() => expect(runs(calls)).toHaveLength(1));
    expect(runs(calls)[0]?.args?.request).toEqual({ type: "rollback", id: 4, prune: true, dry_run: false });
  });

  it("disables rollback while auto-sync is on and explains why", async () => {
    const d = detail();
    d.argo = argo({ rollback_blocked: "Disable auto-sync to roll back", auto_sync: { enabled: true, prune: false, self_heal: false } });
    stub(d);
    render(<Harness />);
    expect(await screen.findByRole("button", { name: "Rollback" })).toBeDisabled();
  });

  it("places the automated-sync switches above resources and history", async () => {
    stub(detail());
    render(<Harness />);
    const auto = await screen.findByRole("region", { name: "Automated sync" });
    const resources = screen.getByRole("region", { name: "Managed resources" });
    const history = screen.getByRole("region", { name: "Deployment history" });
    const before = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(auto, resources)).toBe(true);
    expect(before(auto, history)).toBe(true);
  });

  it("toggles auto-sync through a typed request", async () => {
    const calls = stub(detail());
    render(<Harness />);
    const region = await screen.findByRole("region", { name: "Automated sync" });
    fireEvent.click(within(region).getByText("Auto-sync"));
    await waitFor(() => expect(runs(calls)).toHaveLength(1));
    expect(runs(calls)[0]?.args?.request).toEqual({ type: "set_auto_sync", enabled: true, prune: false, self_heal: false });
  });

  it("filters managed resources by state and text", async () => {
    stub(detail());
    render(<Harness />);
    const region = await screen.findByRole("region", { name: "Managed resources" });
    fireEvent.click(within(region).getByRole("button", { name: "Out of sync 1" }));
    expect(within(region).getByText("web")).toBeInTheDocument();
    expect(within(region).queryByText("web-svc")).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: "All 2" }));
    fireEvent.change(within(region).getByPlaceholderText("Filter by kind, namespace, name…"), { target: { value: "service" } });
    expect(within(region).queryByText("web")).toBeNull();
    expect(within(region).getByText("web-svc")).toBeInTheDocument();
  });

  it("builds cascade delete choices", async () => {
    const calls = stub(detail());
    render(<Harness />);
    await screen.findByRole("button", { name: "Sync" });
    const items = argoDeleteItems(captured!, "app");
    const labels = items.map((i) => (i.kind === "item" ? i.label : "—"));
    expect(labels).toEqual([
      "Delete app and its resources",
      "Delete, clean up resources in background",
      "—",
      "Delete Application only (keep resources)",
    ]);
    const keep = items[3];
    await act(async () => keep?.kind === "item" && keep.onClick());
    await waitFor(() => expect(runs(calls)).toHaveLength(1));
    expect(runs(calls)[0]?.args?.request).toEqual({ type: "delete_app", cascade: "non_cascading" });
  });
});

describe("live status", () => {
  it("fills missing health from live cluster state and shows ready counts", async () => {
    const d = detail("flux");
    d.resources = d.resources!.map((r) => ({ ...r, sync: null, health: null }));
    const calls = stub(d, [
      { group: "apps", kind: "Deployment", namespace: "prod", name: "web", kind_id: "deployments", found: true, status: "Progressing", ready: "1/3", error: null },
      { group: "", kind: "Service", namespace: "prod", name: "web-svc", kind_id: "services", found: false, status: "Missing", ready: null, error: null },
    ]);
    render(<Harness kindId={fluxKind} />);
    const region = await screen.findByRole("region", { name: "Managed resources" });
    expect(await within(region).findByText("1/3")).toBeInTheDocument();
    expect(within(region).getByText("Progressing")).toBeInTheDocument();
    expect(within(region).getByText("Missing")).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "Unhealthy 2" })).toBeInTheDocument();
    const req = calls.find((c) => c.cmd === "resolve_object_statuses_cmd");
    expect(req?.args?.refs).toEqual([
      { group: "apps", kind: "Deployment", namespace: "prod", name: "web" },
      { group: "", kind: "Service", namespace: "prod", name: "web-svc" },
    ]);
  });

  it("keeps controller-reported health and skips remote resources", async () => {
    const d = detail();
    d.resources = d.resources!.map((r) => ({ ...r, local: r.kind === "Deployment" }));
    const calls = stub(d, [
      { group: "apps", kind: "Deployment", namespace: "prod", name: "web", kind_id: "deployments", found: true, status: "Progressing", ready: "0/1", error: null },
    ]);
    render(<Harness />);
    const region = await screen.findByRole("region", { name: "Managed resources" });
    expect(await within(region).findByText("0/1")).toBeInTheDocument();
    expect(within(region).queryByText("Progressing")).toBeNull();
    const req = calls.find((c) => c.cmd === "resolve_object_statuses_cmd");
    expect((req?.args?.refs as unknown[]).length).toBe(1);
  });
});

describe("Flux actions", () => {
  it("offers reconcile with source, force, and reset", async () => {
    const calls = stub(detail("flux"));
    render(<Harness kindId={fluxKind} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
    const menu = screen.getByRole("menu");
    fireEvent.click(within(menu).getByText("Reconcile with source (HelmChart)"));
    await waitFor(() => expect(runs(calls)).toHaveLength(1));
    expect(runs(calls)[0]?.args?.request).toEqual({
      type: "reconcile",
      force: false,
      reset: false,
      with_source: { kind_id: helmChart.id, namespace: "flux-system", name: "web-chart" },
    });
  });

  it("disables with-source when the source kind is not discovered and renders history", async () => {
    stub(detail("flux"));
    useAppStore.setState({ kinds: [] });
    render(<Harness kindId={fluxKind} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Force upgrade")).toBeInTheDocument();
    expect(within(menu).getByText("Reset retries")).toBeInTheDocument();
    expect(within(menu).getByText(/source kind not discovered/)).toBeInTheDocument();
    const history = screen.getByRole("table", { name: "Release history" });
    expect(within(history).getByText("web@1.2.0")).toBeInTheDocument();
    expect(screen.getByText("1 · 2 failures")).toBeInTheDocument();
  });

  it("sends force upgrade as a typed reconcile", async () => {
    const calls = stub(detail("flux"));
    render(<Harness kindId={fluxKind} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
    fireEvent.click(within(screen.getByRole("menu")).getByText("Force upgrade"));
    await waitFor(() => expect(runs(calls)).toHaveLength(1));
    expect(runs(calls)[0]?.args?.request).toMatchObject({ type: "reconcile", force: true, reset: false, with_source: null });
  });
});


