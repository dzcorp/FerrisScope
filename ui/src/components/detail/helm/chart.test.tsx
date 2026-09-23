import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HelmChartSummary } from "./chart";
import { useAppStore } from "../../../store";
import { resetMockInvoke, setMockInvoke } from "../../../test/tauri-mock";
import type { HelmChartDetail, HelmInstallResult, ResourceKind } from "../../../types";

vi.mock("@monaco-editor/react", () => ({
  default: ({ value, onChange }: { value: string; onChange?: (v: string) => void }) => (
    <textarea data-testid="monaco" value={value} onChange={(e) => onChange?.(e.target.value)} />
  ),
}));

const UID = "helm:chart:cluster:podinfo:6.5.0";

function chart(): HelmChartDetail {
  return {
    source: "cluster",
    chart_name: "podinfo",
    chart_version: "6.5.0",
    app_version: "6.5.0",
    description: "demo chart",
    home: "https://podinfo.dev",
    icon: null,
    sources: [],
    keywords: ["demo"],
    default_values_yaml: "replicaCount: 1\n",
    used_by: [{ namespace: "prod", name: "web", revision: 3, status: "deployed", updated: null }],
    helm_available: true,
  };
}

const helmRelease: ResourceKind = {
  id: "helm_releases",
  kind: "HelmRelease",
  group: "",
  version: "v1",
  plural: "secrets",
  namespaced: true,
  category: "Apps",
  columns: [],
};
const fluxRelease: ResourceKind = {
  ...helmRelease,
  id: "wkcrd:flux_helmreleases|helm.toolkit.fluxcd.io|v2|helmreleases|HelmRelease|ns",
  group: "helm.toolkit.fluxcd.io",
  version: "v2",
  plural: "helmreleases",
};

type Call = { cmd: string; args: Record<string, unknown> | undefined };

function stub(d: HelmChartDetail = chart(), install: () => HelmInstallResult = () => ({
  kind: "installed",
  revision: 1,
  namespace: "apps",
  release_name: "podinfo",
  status: "deployed",
  elapsed_ms: 5,
  helm_stdout: "{}",
})) {
  const calls: Call[] = [];
  setMockInvoke((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "get_helm_chart_detail_cmd") return d;
    if (cmd === "install_helm_chart_cmd") return install();
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

beforeEach(() => {
  resetMockInvoke();
  useAppStore.setState((s) => ({
    kinds: [helmRelease, fluxRelease],
    kindClusters: { [fluxRelease.id]: ["ctx"] },
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

describe("HelmChartSummary", () => {
  it("survives the loading -> ready transition without a hook-order crash", async () => {
    let resolve: (d: HelmChartDetail) => void = () => {};
    setMockInvoke(() => new Promise((r) => (resolve = r)));
    render(<HelmChartSummary clusterId="ctx" uid={UID} detailVersion={0} />);
    expect(screen.getByText("Loading chart…")).toBeInTheDocument();
    await act(async () => resolve(chart()));
    expect(screen.getByRole("listitem", { name: "Chart" })).toBeInTheDocument();
  });

  it("reports an unparseable uid without fetching", () => {
    const calls = stub();
    render(<HelmChartSummary clusterId="ctx" uid="bogus" detailVersion={0} />);
    expect(screen.getByText(/Cannot parse chart uid/)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("navigates used-by releases to the native HelmRelease kind (group '')", async () => {
    stub();
    const navigate = vi.fn();
    render(<HelmChartSummary clusterId="ctx" uid={UID} detailVersion={0} onNavigate={navigate} />);
    const usedBy = await screen.findByRole("region", { name: "Used by" });
    fireEvent.click(within(usedBy).getByText("web"));
    expect(navigate).toHaveBeenCalledWith("HelmRelease", "prod", "web", "ctx", "");
  });

  it("keeps used-by copy-only when the native kind isn't resolvable", async () => {
    stub();
    useAppStore.setState({ kinds: [fluxRelease] });
    const navigate = vi.fn();
    render(<HelmChartSummary clusterId="ctx" uid={UID} detailVersion={0} onNavigate={navigate} />);
    const usedBy = await screen.findByRole("region", { name: "Used by" });
    fireEvent.click(within(usedBy).getByText("web"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("validates the release name and namespace and warns on a name collision", async () => {
    stub();
    render(<HelmChartSummary clusterId="ctx" uid={UID} detailVersion={0} />);
    const name = await screen.findByRole("textbox", { name: "Release name" });
    const install = screen.getByRole("button", { name: "Install" });
    expect(install).toBeEnabled();
    fireEvent.change(name, { target: { value: "Bad_Name" } });
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(install).toBeDisabled();
    fireEvent.change(name, { target: { value: "web" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Namespace" }), { target: { value: "prod" } });
    expect(screen.getByText(/already exists in prod/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Namespace" }), { target: { value: "a.b" } });
    expect(install).toBeDisabled();
  });

  it("blocks install on invalid values YAML", async () => {
    stub();
    render(<HelmChartSummary clusterId="ctx" uid={UID} detailVersion={0} />);
    fireEvent.change(await screen.findByTestId("monaco"), { target: { value: "a: [" } });
    expect(screen.getByText(/YAML parse error/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
  });

  it("confirms, installs with the form values, toasts, and refetches", async () => {
    const calls = stub();
    render(<HelmChartSummary clusterId="ctx" uid={UID} detailVersion={0} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Namespace" }), { target: { value: "apps" } });
    fireEvent.change(screen.getByTestId("monaco"), { target: { value: "replicaCount: 3\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await answerConfirm();
    await waitFor(() => expect(of(calls, "install_helm_chart_cmd")).toHaveLength(1));
    expect(of(calls, "install_helm_chart_cmd")[0]!.args).toEqual({
      clusterId: "ctx",
      source: "cluster",
      namespace: "apps",
      releaseName: "podinfo",
      chartName: "podinfo",
      chartVersion: "6.5.0",
      valuesYaml: "replicaCount: 3\n",
    });
    await waitFor(() => expect(lastToast()?.tone).toBe("ok"));
    expect(lastToast()?.text).toMatch(/Installed podinfo in apps/);
    await waitFor(() => expect(of(calls, "get_helm_chart_detail_cmd")).toHaveLength(2));
  });

  it("shows helm stderr inline when install fails", async () => {
    stub(chart(), () => ({ kind: "failed", message: "INSTALLATION FAILED", helm_stderr: "Error: quota exceeded", elapsed_ms: 1 }));
    render(<HelmChartSummary clusterId="ctx" uid={UID} detailVersion={0} />);
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await answerConfirm();
    const block = await screen.findByRole("region", { name: "Install failed" });
    expect(within(block).getByText("Error: quota exceeded")).toBeInTheDocument();
    expect(lastToast()?.tone).toBe("bad");
  });

  it("disables the form when degraded or helm is missing", async () => {
    const d = chart();
    d.helm_available = false;
    stub(d);
    const { unmount } = render(<HelmChartSummary clusterId="ctx" uid={UID} detailVersion={0} />);
    expect(await screen.findByRole("textbox", { name: "Release name" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Set up helm…" })).toBeInTheDocument();
    unmount();
    stub();
    useAppStore.setState({ clusterHealth: { ctx: "unavailable" } });
    render(<HelmChartSummary clusterId="ctx" uid={UID} detailVersion={0} />);
    expect(await screen.findByRole("textbox", { name: "Namespace" })).toBeDisabled();
    expect(screen.getByText("Cluster unavailable")).toBeInTheDocument();
  });

  it("resets the install form when a different chart opens", async () => {
    stub();
    const { rerender } = render(<HelmChartSummary clusterId="ctx" uid={UID} detailVersion={0} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Release name" }), { target: { value: "custom" } });
    const other = { ...chart(), chart_name: "redis", chart_version: "18.0.0" };
    stub(other);
    rerender(<HelmChartSummary clusterId="ctx" uid="helm:chart:cluster:redis:18.0.0" detailVersion={0} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Release name" })).toHaveValue("redis"));
  });
});
