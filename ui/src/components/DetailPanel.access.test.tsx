import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { resetMockInvoke, setMockInvoke } from "../test/tauri-mock";
import { resetEventMock } from "../test/tauri-event-mock";
import { resetAccessCache } from "../lib/access";
import { DetailPanel } from "./DetailPanel";
import type { ResourceKind } from "../types";

const HELM: ResourceKind = {
  id: "helm_releases",
  group: "",
  version: "v1",
  kind: "HelmRelease",
  plural: "releases",
  namespaced: true,
  category: "apps" as ResourceKind["category"],
  columns: [],
};

afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetEventMock();
  resetAccessCache();
});

const NODES: ResourceKind = { ...HELM, id: "nodes", kind: "Node", plural: "nodes", namespaced: false, category: "cluster" as ResourceKind["category"] };
const CONFIGMAPS: ResourceKind = { ...HELM, id: "configmaps", kind: "ConfigMap", plural: "configmaps", category: "config" as ResourceKind["category"] };

/// Denies `denied` actions, allows the rest; records what was asked.
function answer(denied: string[]) {
  const asked: { kindId: string; action: string; namespace: string | null; name: string | null }[] = [];
  setMockInvoke((cmd, args) => {
    if (cmd !== "access_check_cmd") return null;
    const rs = args?.requests as typeof asked;
    asked.push(...rs);
    return rs.map((r) =>
      denied.includes(r.action) ? { state: "denied", reason: `cannot ${r.action} ${r.kindId}` } : { state: "allowed" },
    );
  });
  return asked;
}

async function mount(kind: ResourceKind, namespace: string | null, name: string) {
  await act(async () => {
    render(
      <DetailPanel
        mode="dark"
        clusterId="ctx"
        kind={kind}
        target={{ clusterId: "ctx", uid: "u1", namespace, name }}
        row={null}
        onClose={() => {}}
      />,
    );
  });
}

describe("DetailPanel access gates", () => {
  it("node header: denied verbs are grayed out with the reason, allowed ones stay live", async () => {
    const asked = answer(["drain", "delete"]);
    await mount(NODES, null, "n1");
    expect(
      await screen.findByRole("button", { name: "Drain node — cordon and evict pods — Not permitted: cannot drain nodes" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete… — Not permitted: cannot delete nodes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cordon node — block new scheduling" })).toBeEnabled();
    expect(asked.every((r) => r.name === "n1")).toBe(true);
  });

  it("generic kinds gate Delete on the object it would delete", async () => {
    const asked = answer(["delete"]);
    await mount(CONFIGMAPS, "team", "cfg");
    expect(
      await screen.findByRole("button", { name: "Delete… — Not permitted: cannot delete configmaps" }),
    ).toBeDisabled();
    expect(asked).toContainEqual({ kindId: "configmaps", action: "delete", namespace: "team", name: "cfg" });
  });

  // Helm asks for helm verbs only; a gate it never asked for reads open.
  it("a restored drawer on a tab its kind has no gate for still renders", async () => {
    setMockInvoke((cmd, args) =>
      cmd === "access_check_cmd"
        ? (args?.requests as unknown[]).map(() => ({ state: "denied", reason: "no" }))
        : null,
    );
    await act(async () => {
      render(
        <DetailPanel
          mode="dark"
          clusterId="ctx"
          kind={HELM}
          target={{ clusterId: "ctx", uid: "u1", namespace: "ns", name: "web" }}
          row={null}
          initialView={{ tab: "yaml" }}
          onClose={() => {}}
        />,
      );
    });
    expect(screen.getByLabelText("Close")).toBeTruthy();
  });
});
