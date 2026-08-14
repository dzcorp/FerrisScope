// Covers the pure selector serializer, the dynamic namespace/service pickers
// (populated live from the cluster, with a text-input fallback), and the submit
// paths for both Localhost (pf_start) and Global/DNS (gf_enable_service) modes.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewForwardForm, kvBufferToSelector } from "./NewForwardForm";

// The Select popover calls scrollIntoView on open; jsdom doesn't implement it.
Element.prototype.scrollIntoView = vi.fn();
import { useAppStore } from "../../store";
import { tokens } from "../../theme";
import { kvBufferFromPairs } from "../detail/edit";
import { setMockInvoke, resetMockInvoke } from "../../test/tauri-mock";
import type { ContextInfo } from "../../types";

const t = tokens("dark");

const ctx: ContextInfo = {
  id: "ctx-a",
  name: "minikube",
  cluster: "minikube",
  user: "minikube",
  namespace: null,
  is_current: true,
  group: "local",
  source_id: "s1",
  source_path: null,
};

type Call = { cmd: string; args: Record<string, unknown> | undefined };

// A responder covering every command the form may fire on mount + submit.
// `over` lets a test shape the namespace/service lists or stub a submit result.
function mockForm(
  calls: Call[],
  over: {
    namespaces?: string[];
    services?: { name: string; ports: { port: number; name: string | null; protocol: string }[] }[];
  } = {},
) {
  setMockInvoke((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "list_namespaces_cmd") return over.namespaces ?? [];
    if (cmd === "list_services_in_namespace_cmd") return over.services ?? [];
    if (cmd === "pf_start")
      return {
        spec: {
          id: "ctx-a::Service/default/api:80",
          cluster_id: "ctx-a",
          target: { kind: "Service", namespace: "default", name: "api" },
          remote_port: 80,
          requested_local_port: null,
          autostart: false,
        },
        actual_local_port: 51080,
        status: { kind: "listening" },
      };
    if (cmd === "gf_enable_service" || cmd === "gf_enable_query")
      return {
        id: "ctx-a::q::default::",
        cluster_id: "ctx-a",
        namespace: "default",
        services: [],
      };
    return undefined;
  });
}

beforeEach(() => {
  useAppStore.setState({
    contexts: [ctx],
    selectedContext: "ctx-a",
    forwards: {},
    globalForwards: {},
  });
});
afterEach(() => resetMockInvoke());

describe("kvBufferToSelector", () => {
  it("joins k=v terms and bare keys", () => {
    const b = kvBufferFromPairs([
      ["app", "api"],
      ["tier", ""],
      ["env", "prod"],
    ]);
    expect(kvBufferToSelector(b)).toBe("app=api,tier,env=prod");
  });

  it("is empty for an empty buffer", () => {
    expect(kvBufferToSelector(kvBufferFromPairs([]))).toBe("");
  });
});

describe("NewForwardForm — simple mode (text fallback)", () => {
  it("with no listable namespaces, fields are text inputs and submit calls pf_start", async () => {
    const calls: Call[] = [];
    mockForm(calls); // empty lists → text inputs

    render(<NewForwardForm t={t} onDone={() => {}} />);

    fireEvent.change(await screen.findByPlaceholderText("default"), {
      target: { value: "default" },
    });
    fireEvent.change(screen.getByPlaceholderText("my-service"), {
      target: { value: "api" },
    });
    fireEvent.change(screen.getByPlaceholderText("80"), {
      target: { value: "80" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));

    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "pf_start")).toBe(true),
    );
    const pf = calls.find((c) => c.cmd === "pf_start")!;
    expect((pf.args!.target as { name: string }).name).toBe("api");
    expect(pf.args!.remotePort).toBe(80);
  });

  it("blocks submit with a validation message when name is missing", async () => {
    const calls: Call[] = [];
    mockForm(calls);
    render(<NewForwardForm t={t} onDone={() => {}} />);
    fireEvent.change(await screen.findByPlaceholderText("default"), {
      target: { value: "default" },
    });
    fireEvent.change(screen.getByPlaceholderText("80"), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(await screen.findByText("Name is required.")).toBeTruthy();
    expect(calls.some((c) => c.cmd === "pf_start")).toBe(false);
  });
});

describe("NewForwardForm — dynamic pickers", () => {
  it("populates the namespace dropdown from the cluster and can toggle to manual", async () => {
    const calls: Call[] = [];
    mockForm(calls, { namespaces: ["default", "kube-system"] });
    render(<NewForwardForm t={t} onDone={() => {}} />);

    // Namespaces loaded → a Select (showing the sentinel) replaces the text input.
    fireEvent.click(await screen.findByText("Select namespace…"));
    expect(await screen.findByRole("option", { name: "default" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "kube-system" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "kube-system" }));

    // Escape hatch: switch the field back to free text.
    fireEvent.click(screen.getByRole("button", { name: "Type manually" }));
    expect(screen.getByPlaceholderText("default")).toBeTruthy();
  });

  it("picking a single-port Service auto-fills the remote port", async () => {
    const calls: Call[] = [];
    mockForm(calls, {
      namespaces: ["default"],
      services: [{ name: "api", ports: [{ port: 8080, name: "http", protocol: "TCP" }] }],
    });
    render(<NewForwardForm t={t} onDone={() => {}} />);

    // Kind defaults to Service. Pick the namespace → services load.
    fireEvent.click(await screen.findByText("Select namespace…"));
    fireEvent.click(await screen.findByRole("option", { name: "default" }));

    // Pick the service → its single port is auto-selected in the port dropdown.
    fireEvent.click(await screen.findByText("Select service…"));
    fireEvent.click(await screen.findByRole("option", { name: "api" }));

    expect(
      await screen.findByText("8080 (http)/TCP"),
    ).toBeTruthy();
  });
});

describe("NewForwardForm — global (DNS) mode", () => {
  it("submitting a single service calls gf_enable_service with the namespace + name", async () => {
    const calls: Call[] = [];
    mockForm(calls); // empty lists → text inputs (manual entry path)
    render(<NewForwardForm t={t} onDone={() => {}} />);

    // Switch to Global mode via the Mode select.
    fireEvent.click(screen.getByText("Localhost (simple)"));
    fireEvent.click(await screen.findByRole("option", { name: "Global (DNS)" }));

    fireEvent.change(await screen.findByPlaceholderText("all namespaces"), {
      target: { value: "default" },
    });
    fireEvent.change(screen.getByPlaceholderText("(or use a selector below)"), {
      target: { value: "api" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));

    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "gf_enable_service")).toBe(true),
    );
    const c = calls.find((c) => c.cmd === "gf_enable_service")!;
    expect(c.args).toMatchObject({
      clusterId: "ctx-a",
      namespace: "default",
      name: "api",
    });
  });
});

describe("NewForwardForm cluster picker labels", () => {
  const GKE_A = "gke_development-d83ab4a8_europe-west4_truenv-03";
  const GKE_B = "gke_development-d83ab4a8_europe-west4_autotest-01";
  const gke = (name: string): ContextInfo => ({
    ...ctx,
    id: `default::${name}`,
    name,
    cluster: name,
  });

  it("labels each cluster with its short name plus the stripped coordinate", async () => {
    // Without the coordinate, every context in one GKE project truncates to
    // the same `gke_development-d83ab4a8…` in this narrow select.
    useAppStore.setState({
      contexts: [gke(GKE_A), gke(GKE_B)],
      selectedContext: `default::${GKE_A}`,
    });
    mockForm([]);
    render(<NewForwardForm t={t} onDone={() => {}} />);

    await waitFor(() =>
      expect(
        screen.getAllByText(
          "truenv-03 · development-d83ab4a8 · europe-west4",
        ).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.queryByText(GKE_A)).toBeNull();
  });

  it("falls back to the full name when shortening is off", async () => {
    useAppStore.getState().patchSettings({ shortenClusterNames: false });
    useAppStore.setState({
      contexts: [gke(GKE_A)],
      selectedContext: `default::${GKE_A}`,
    });
    mockForm([]);
    render(<NewForwardForm t={t} onDone={() => {}} />);
    await waitFor(() =>
      expect(screen.getAllByText(GKE_A).length).toBeGreaterThan(0),
    );
    useAppStore.getState().patchSettings({ shortenClusterNames: true });
  });
});
