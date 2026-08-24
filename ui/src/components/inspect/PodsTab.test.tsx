import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetMockInvoke, setMockInvoke } from "../../test/tauri-mock";
import { resetEventMock } from "../../test/tauri-event-mock";
import { PodsTab, selectorFrom } from "./PodsTab";
import { tokens } from "../../theme";
import type { DocState, InspectSubject } from ".";

afterEach(() => {
  cleanup();
  resetMockInvoke();
  resetEventMock();
});

const t = tokens("dark");

function subject(
  name: string,
  clusterId = "ctx",
  namespace = "default",
): InspectSubject {
  return {
    sid: `${clusterId}::${name}-uid`,
    uid: `${name}-uid`,
    clusterId,
    clusterName: clusterId,
    colorIdx: 0,
    namespace,
    name,
  };
}

function doc(app: string): DocState {
  return {
    status: "ok",
    doc: { spec: { selector: { matchLabels: { app } } } } as never,
  };
}

function pod(uid: string, name: string, app: string, namespace = "default") {
  return {
    uid,
    name,
    namespace,
    phase: "Running",
    ready: "1/1",
    restarts: 0,
    node: "worker-1",
    creation_timestamp: "2026-08-25T09:00:00Z",
    __labels: { app },
  };
}

async function show(
  subjects: InspectSubject[],
  docs: [string, DocState][],
  podsFor: (name: string) => unknown[],
  onNavigate?: (k: string, ns: string | null, n: string) => void,
) {
  setMockInvoke((cmd, args) => {
    if (cmd === "subscribe_resource") return { rows: [], init_done: true };
    if (cmd === "unsubscribe_resource") return undefined;
    if (cmd === "list_pods_for_workload_cmd")
      return podsFor(String((args ?? {}).name));
    throw new Error(`unexpected command: ${cmd}`);
  });
  await act(async () => {
    render(
      <PodsTab
        t={t}
        mode="dark"
        kindId="deployments"
        subjects={subjects}
        docs={new Map(docs)}
        onNavigate={onNavigate}
      />,
    );
  });
}

describe("selectorFrom", () => {
  it("reads matchLabels off a raw manifest", () => {
    expect(
      selectorFrom({ spec: { selector: { matchLabels: { app: "web" } } } }),
    ).toEqual({ match_labels: [["app", "web"]], match_expressions: 0 });
  });

  it("counts matchExpressions without trying to evaluate them", () => {
    expect(
      selectorFrom({
        spec: {
          selector: {
            matchLabels: { app: "web" },
            matchExpressions: [{ key: "tier", operator: "In", values: ["a"] }],
          },
        },
      }),
    ).toEqual({ match_labels: [["app", "web"]], match_expressions: 1 });
  });

  // A wholly empty selector would match the namespace — refuse it.
  it("returns null for missing, empty or malformed selectors", () => {
    expect(selectorFrom(null)).toBeNull();
    expect(selectorFrom({ spec: {} })).toBeNull();
    expect(selectorFrom({ spec: { selector: {} } })).toBeNull();
    expect(selectorFrom({ spec: { selector: [] } })).toBeNull();
    expect(selectorFrom("nope")).toBeNull();
  });

  it("skips non-string label values rather than stringifying them", () => {
    expect(
      selectorFrom({ spec: { selector: { matchLabels: { app: 3 } } } }),
    ).toBeNull();
  });
});

describe("PodsTab", () => {
  const A = subject("web-a");
  const B = subject("web-b");

  it("unions pods across the selected controllers", async () => {
    await show(
      [A, B],
      [
        [A.sid, doc("a")],
        [B.sid, doc("b")],
      ],
      (name) =>
        name === "web-a"
          ? [pod("p1", "web-a-1", "a")]
          : [pod("p2", "web-b-1", "b")],
    );
    expect(await screen.findByText("web-a-1")).toBeInTheDocument();
    expect(screen.getByText("web-b-1")).toBeInTheDocument();
  });

  // The owner comes from which fetch returned the pod, not from re-matching
  // selectors — that misattributes overlapping ones and returns nothing at all
  // for a matchExpressions selector.
  it("attributes each pod to the controller that returned it", async () => {
    await show(
      [A, B],
      [
        [A.sid, doc("a")],
        [B.sid, doc("b")],
      ],
      (name) =>
        name === "web-a"
          ? [pod("p1", "web-a-1", "a")]
          : [pod("p2", "web-b-1", "b")],
    );
    await screen.findByText("web-a-1");
    expect(screen.getByText("web-a")).toBeInTheDocument();
    expect(screen.getByText("web-b")).toBeInTheDocument();
  });

  it("dedups a pod matched by two controllers", async () => {
    await show(
      [A, B],
      [
        [A.sid, doc("a")],
        [B.sid, doc("a")],
      ],
      () => [pod("p1", "shared-1", "a")],
    );
    expect(await screen.findAllByText("shared-1")).toHaveLength(1);
  });

  // One PodListSection per cluster: a single section binds one cluster's pod
  // stream, so a mixed list would match one cluster's pods against another's
  // selectors.
  it("groups per cluster and labels each group", async () => {
    const far = subject("web-c", "other");
    await show(
      [A, far],
      [
        [A.sid, doc("a")],
        [far.sid, doc("c")],
      ],
      (name) => (name === "web-a" ? [pod("p1", "web-a-1", "a")] : []),
    );
    expect(await screen.findByText("ctx")).toBeInTheDocument();
    expect(screen.getByText("other")).toBeInTheDocument();
  });

  // The tab rendered pod and node names as plain text until onNavigate was
  // plumbed through from App.
  it("navigates to a pod's detail", async () => {
    const onNavigate = vi.fn();
    await show(
      [A],
      [[A.sid, doc("a")]],
      () => [pod("p1", "web-a-1", "a")],
      onNavigate,
    );
    (await screen.findByText("web-a-1")).click();
    expect(onNavigate).toHaveBeenCalledWith("Pod", "default", "web-a-1");
  });

  it("navigates to a node's detail with a null namespace", async () => {
    const onNavigate = vi.fn();
    await show(
      [A],
      [[A.sid, doc("a")]],
      () => [pod("p1", "web-a-1", "a")],
      onNavigate,
    );
    (await screen.findByText("worker-1")).click();
    expect(onNavigate).toHaveBeenCalledWith("Node", null, "worker-1");
  });

  it("explains an unreadable selection rather than blaming the selector", async () => {
    await show([A], [[A.sid, { status: "error", message: "404" }]], () => []);
    expect(
      await screen.findByText("None of the selected manifests could be read."),
    ).toBeInTheDocument();
  });

  it("explains a cluster-scoped selection", async () => {
    const node = { ...subject("node-1"), namespace: null };
    await show([node], [[node.sid, doc("a")]], () => []);
    expect(
      await screen.findByText(
        "These objects are cluster-scoped, so they own no pods.",
      ),
    ).toBeInTheDocument();
  });
});
