import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetMockInvoke, setMockInvoke } from "../../test/tauri-mock";
import { resetEventMock } from "../../test/tauri-event-mock";
import {
  InspectPanel,
  MAX_INSPECT_SUBJECTS,
  inspectTargetFromSelection,
  type InspectSubject,
  type InspectTarget,
} from ".";
import type { SelectionMeta } from "../../store";

afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetEventMock();
});

function subject(i: number): InspectSubject {
  return {
    sid: `ctx::uid-${i}`,
    uid: `uid-${i}`,
    clusterId: "ctx",
    clusterName: "prod",
    colorIdx: 0,
    namespace: "default",
    name: `web-${i}`,
  };
}

function target(
  kindId: string,
  count: number,
  kindLabel = "Deployment",
): InspectTarget {
  return {
    kindId,
    kindLabel,
    subjects: Array.from({ length: count }, (_, i) => subject(i)),
  };
}

const YAML = "apiVersion: apps/v1\nkind: Deployment\nspec:\n  replicas: 2\n";

function stubYaml(yaml: string | (() => string) = YAML) {
  setMockInvoke((cmd) => {
    if (cmd === "get_resource_yaml_cmd")
      return typeof yaml === "function" ? yaml() : yaml;
    if (cmd === "list_object_events_cmd") return [];
    if (cmd === "subscribe_resource") return { rows: [], init_done: true };
    if (cmd === "unsubscribe_resource") return undefined;
    if (cmd === "list_pods_for_workload_cmd") return [];
    throw new Error(`unexpected command: ${cmd}`);
  });
}

async function open(tgt: InspectTarget, onClose = vi.fn()) {
  await act(async () => {
    render(<InspectPanel mode="dark" target={tgt} onClose={onClose} />);
  });
  return onClose;
}

describe("inspectTargetFromSelection", () => {
  const meta = (name: string): SelectionMeta => ({
    clusterId: "ctx",
    namespace: "default",
    name,
  });

  it("recovers each uid from the selection key", () => {
    const sel = new Map<string, SelectionMeta>([
      ["ctx::uid-a", meta("web-a")],
      ["ctx::uid-b", meta("web-b")],
    ]);
    const tgt = inspectTargetFromSelection(
      sel,
      "deployments",
      "Deployment",
      () => "prod",
      () => 0,
    );
    expect(tgt?.subjects.map((s) => s.uid)).toEqual(["uid-a", "uid-b"]);
  });

  it("refuses a selection of fewer than two", () => {
    const sel = new Map<string, SelectionMeta>([["ctx::uid-a", meta("web-a")]]);
    expect(
      inspectTargetFromSelection(sel, "deployments", "Deployment", () => "p", () => 0),
    ).toBeNull();
  });
});

describe("InspectPanel", () => {
  it("offers a Pods tab for a pod-bearing kind", async () => {
    stubYaml();
    await open(target("deployments", 2));
    expect(screen.getByText("Pods")).toBeInTheDocument();
  });

  it("hides the Pods tab for a kind that owns no pods", async () => {
    stubYaml();
    await open(target("configmaps", 2, "ConfigMap"));
    expect(screen.queryByText("Pods")).not.toBeInTheDocument();
    expect(screen.getByText("Fields")).toBeInTheDocument();
  });

  // The subjects would just be the pods.
  it("hides the Pods tab when inspecting pods themselves", async () => {
    stubYaml();
    await open(target("pods", 2, "Pod"));
    expect(screen.queryByText("Pods")).not.toBeInTheDocument();
  });

  it("caps an oversized selection with a warning, not an error", async () => {
    stubYaml();
    await open(target("deployments", MAX_INSPECT_SUBJECTS + 5));
    expect(
      screen.getByText(
        new RegExp(`first ${MAX_INSPECT_SUBJECTS} of ${MAX_INSPECT_SUBJECTS + 5}`),
      ),
    ).toBeInTheDocument();
    // Still usable — the cap is a bound, not a failure.
    expect(screen.getByText("Fields")).toBeInTheDocument();
  });

  it("warns about one unreadable subject while comparing the rest", async () => {
    let n = 0;
    setMockInvoke((cmd) => {
      if (cmd === "get_resource_yaml_cmd") {
        n += 1;
        if (n === 2) throw new Error("404 not found");
        return YAML;
      }
      return [];
    });
    await open(target("deployments", 2));
    expect(screen.getByText(/404 not found/)).toBeInTheDocument();
    expect(screen.getByText("Fields")).toBeInTheDocument();
  });

  it("surfaces an error with a retry when every subject fails", async () => {
    setMockInvoke((cmd) => {
      if (cmd === "get_resource_yaml_cmd") throw new Error("boom");
      return [];
    });
    await open(target("deployments", 2));
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(screen.queryByText("Differences only")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    stubYaml();
    const onClose = await open(target("deployments", 2));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("names the selection in the header", async () => {
    stubYaml();
    await open(target("deployments", 5));
    expect(screen.getByText("5 Deployments · compared")).toBeInTheDocument();
    expect(screen.getByText("web-0, web-1, web-2 +2")).toBeInTheDocument();
  });
});
