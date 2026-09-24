import { describe, it, expect } from "vitest";
import {
  buildSession,
  parseSession,
  restoreSlice,
  snapshotSlice,
  SESSION_VERSION,
  YAML_PERSIST_CAP,
  YAML_SESSION_BUDGET,
} from "./session";
import { makeChatTab, makeTerminalTab, makeYamlTab } from "../components/Dock";
import type { DockTab, Drawer } from "../store";

const logs: Drawer = {
  kind: "logs",
  targets: [{ clusterId: "c1", kindId: "pods", namespace: "ns", name: "api-0" }],
};

function slice(dockTabs: DockTab[], extra: Partial<Parameters<typeof snapshotSlice>[0]> = {}) {
  return {
    dockTabs,
    dockActive: { bottom: null, right: null },
    dockMin: { bottom: false, right: false },
    drawer: null,
    tray: [],
    ...extra,
  };
}

describe("session snapshot", () => {
  it("keeps shells, YAML text and chat sessions; drops exec and kubectl terminals", () => {
    const shell = makeTerminalTab({ mode: "shell", clusterId: "c1", namespace: "ns" }, "prod");
    const exec = makeTerminalTab(
      { mode: "exec", clusterId: "c1", namespace: "ns", pod: "p", container: null },
      "prod",
    );
    const debug = makeTerminalTab(
      { mode: "kubectl", clusterId: "c1", namespace: null, args: ["debug"], label: "debug" },
      "prod",
    );
    const yaml = { ...makeYamlTab("c1"), state: { ...makeYamlTab("c1").state, content: "kind: X", pristine: false } };
    const chat = { ...makeChatTab("c1", "prod"), state: { clusterId: "c1", contextLabel: "prod", sessionId: "s-1", chatId: "live" } };
    const snap = snapshotSlice(
      slice([shell, exec, debug, yaml, chat], {
        dockActive: { bottom: yaml.id, right: chat.id },
        dockMin: { bottom: false, right: true },
      }),
    );
    expect(snap.dock.map((d) => d.kind)).toEqual(["terminal", "yaml", "chat"]);
    expect(snap.active).toEqual({ bottom: 1, right: 2 });
    expect(JSON.stringify(snap)).not.toContain("live");
  });

  it("skips YAML buffers over the persist cap", () => {
    const huge = { ...makeYamlTab("c1"), state: { ...makeYamlTab("c1").state, content: "x".repeat(YAML_PERSIST_CAP + 1) } };
    expect(snapshotSlice(slice([huge])).dock).toEqual([]);
  });

  it("caps total YAML across tabs, spending the budget on the active tab first", () => {
    const big = (cid: string) => ({
      ...makeYamlTab(cid),
      state: { ...makeYamlTab(cid).state, content: "x".repeat(YAML_PERSIST_CAP) },
    });
    const n = Math.ceil(YAML_SESSION_BUDGET / YAML_PERSIST_CAP);
    const bg = { id: "bg", selectedContext: "c2", selectedVirtualContextId: null, scopeExtras: [], slice: slice(Array.from({ length: n }, () => big("c2"))) as never };
    const file = buildSession({
      openTabs: [bg, { id: "a", selectedContext: "c1", selectedVirtualContextId: null, scopeExtras: [], slice: slice([]) as never }],
      activeTabId: "a",
      ...slice([big("c1")]),
    });
    expect(Object.keys(file.tabs)).toEqual(["bg", "a"]);
    expect(file.tabs["a"]!.dock).toHaveLength(1);
    expect(file.tabs["bg"]!.dock).toHaveLength(n - 1);
    expect(JSON.stringify(file).length).toBeLessThan(4 * 1024 * 1024);
  });

  it("round-trips through JSON with fresh dock ids and remapped active tabs", () => {
    const shell = makeTerminalTab({ mode: "shell", clusterId: "c1", namespace: null }, "prod");
    const yaml = { ...makeYamlTab("c1"), state: { ...makeYamlTab("c1").state, content: "a: 1", pristine: false } };
    const chat = { ...makeChatTab("c1", "prod"), state: { clusterId: "c1", contextLabel: "prod", sessionId: "s-1" } };
    const file = buildSession({
      openTabs: [],
      activeTabId: "t1",
      ...slice([shell, yaml, chat], {
        dockActive: { bottom: shell.id, right: chat.id },
        dockMin: { bottom: true, right: false },
        drawer: logs,
        tray: [{ id: "x", drawer: logs }],
      }),
    });
    expect(file).toEqual({ version: SESSION_VERSION, tabs: {} });

    const snap = snapshotSlice(
      slice([shell, yaml, chat], {
        dockActive: { bottom: shell.id, right: chat.id },
        dockMin: { bottom: true, right: false },
        drawer: logs,
        tray: [{ id: "x", drawer: logs }],
      }),
    );
    const back = restoreSlice(JSON.parse(JSON.stringify(snap)))!;
    expect(back.dockTabs.map((t) => t.kind)).toEqual(["terminal", "yaml", "chat"]);
    expect(back.dockTabs.some((t) => [shell.id, yaml.id, chat.id].includes(t.id))).toBe(false);
    expect(back.dockActive).toEqual({ bottom: back.dockTabs[0]!.id, right: back.dockTabs[2]!.id });
    expect(back.dockMin).toEqual({ bottom: true, right: false });
    expect(back.dockTabs[1]!.state).toMatchObject({ content: "a: 1", pristine: false, clusterId: "c1" });
    expect(back.dockTabs[2]!.state).toMatchObject({ sessionId: "s-1", chatId: null });
    expect(back.drawer).toEqual(logs);
    expect(back.tray.map((i) => i.drawer)).toEqual([logs]);
  });

  it("uses each tab's own slice; the active one from the live mirror", () => {
    const bg = makeYamlTab("c2");
    const live = makeYamlTab("c1");
    const file = buildSession({
      openTabs: [
        { id: "a", selectedContext: "c1", selectedVirtualContextId: null, scopeExtras: [], slice: slice([]) as never },
        { id: "b", selectedContext: "c2", selectedVirtualContextId: null, scopeExtras: [], slice: slice([bg]) as never },
      ],
      activeTabId: "a",
      ...slice([live]),
    });
    expect(Object.keys(file.tabs)).toEqual(["a", "b"]);
    expect(file.tabs["a"]!.dock).toHaveLength(1);
    expect(file.tabs["b"]!.dock[0]).toMatchObject({ kind: "yaml", clusterId: "c2" });
  });
});

describe("parseSession", () => {
  it("ignores other versions, junk and malformed entries", () => {
    expect(parseSession(null)).toEqual({});
    expect(parseSession({ version: 999, tabs: {} })).toEqual({});
    const out = parseSession({
      version: SESSION_VERSION,
      tabs: {
        ok: {
          dock: [{ kind: "terminal" }, { kind: "chat", clusterId: "c1" }, 42],
          active: { right: 1 },
          drawer: { kind: "detail", kindId: "pods" },
          tray: [logs, { kind: "nope" }],
        },
        junk: "x",
      },
    });
    expect(Object.keys(out)).toEqual(["ok"]);
    const ok = out["ok"]!;
    expect(ok.dockTabs.map((t) => t.kind)).toEqual(["chat"]);
    expect(ok.dockActive.right).toBe(ok.dockTabs[0]!.id);
    expect(ok.drawer).toBeNull();
    expect(ok.tray.map((i) => i.drawer)).toEqual([logs]);
    expect(ok.dockMin).toEqual({ bottom: false, right: false });
  });
});

describe("restored drawers", () => {
  const tab = (drawer: unknown, tray: unknown[] = []) =>
    parseSession({ version: SESSION_VERSION, tabs: { t: { dock: [], drawer, tray } } })["t"]!;

  it("drops variants whose nested shape would crash drawerKey", () => {
    expect(tab({ kind: "logs", targets: [null] }).drawer).toBeNull();
    expect(tab({ kind: "compare", target: { kindId: "pods", kindLabel: "Pod" } }).drawer).toBeNull();
    expect(tab({ kind: "inspect", target: { kindId: "pods", kindLabel: "Pod", subjects: "x" } }).drawer).toBeNull();
    expect(tab(null, [{ kind: "inspect", target: { kindId: "pods", kindLabel: "Pod", subjects: [{}] } }]).tray).toEqual([]);
  });

  it("keeps a detail's view and trims its history to the cap", () => {
    const ref = (i: number) => ({ kindId: "pods", clusterId: "c1", uid: `u${i}`, namespace: "ns", name: `p${i}` });
    const back = [...Array.from({ length: 60 }, (_, i) => ref(i)), { junk: true }];
    const d = tab({ kind: "detail", ...ref(99), view: { tab: "yaml", scrollTop: 40 }, back, forward: [ref(100)] }).drawer;
    expect(d).toMatchObject({ kind: "detail", uid: "u99", view: { tab: "yaml", scrollTop: 40 } });
    const det = d as Extract<Drawer, { kind: "detail" }>;
    expect(det.back).toHaveLength(50);
    expect(det.back![49]!.uid).toBe("u59");
    expect(det.forward!.map((r) => r.uid)).toEqual(["u100"]);
  });
});
