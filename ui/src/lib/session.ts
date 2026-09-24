// Snapshot of what each cluster tab was showing, written to session.json and
// replayed on launch. Live handles (PTYs, chat channels) can't survive a
// restart, so only what's needed to recreate them is stored: a shell
// terminal's spawn spec (it restarts as a fresh shell), a YAML buffer's
// text, a chat's session id (history reloads from the backend).

import {
  DETAIL_HISTORY_CAP,
  detailRef,
  placementOf,
  type DetailRef,
  type ClusterTab,
  type DockPlacement,
  type DockTab,
  type Drawer,
  type ScopeSlice,
  type TrayItem,
} from "../store";
import { makeChatTab, makeTerminalTab, makeYamlTab } from "../components/Dock";

export const SESSION_VERSION = 1;
/// Larger buffers aren't persisted, keeping the snapshot well under the
/// backend's 4 MiB file cap and the per-save cost small.
export const YAML_PERSIST_CAP = 256 * 1024;
/// Total YAML kept across all tabs, so the snapshot never reaches the
/// backend cap (a rejected save would freeze the file at an old state).
export const YAML_SESSION_BUDGET = 3 * 1024 * 1024;

type SessionDock =
  | { kind: "terminal"; title: string; clusterId: string; namespace: string | null }
  | {
      kind: "yaml";
      title: string;
      content: string;
      templateId: string | null;
      pristine: boolean;
      clusterId: string | null;
    }
  | { kind: "chat"; clusterId: string; contextLabel: string; sessionId: string | null };

export type SessionTab = {
  dock: SessionDock[];
  // Index into `dock` of each placement's active tab.
  active: Record<DockPlacement, number | null>;
  dockMin: Record<DockPlacement, boolean>;
  drawer: Drawer | null;
  tray: Drawer[];
};

export type SessionFile = { version: number; tabs: Record<string, SessionTab> };

export type SliceView = Pick<ScopeSlice, "dockTabs" | "dockActive" | "dockMin" | "drawer" | "tray">;

const str = (v: unknown): v is string => typeof v === "string";
const obj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function snapshotDock(tab: DockTab, budget: { left: number }): SessionDock | null {
  const st = tab.state;
  if (tab.kind === "terminal") {
    // Only plain shells restart. Re-running an exec into a pod or a
    // `kubectl debug` (which creates a pod) on launch would act on the
    // cluster without the operator asking.
    const spec = st["spec"];
    if (!obj(spec) || spec["mode"] !== "shell" || !str(spec["clusterId"])) return null;
    return {
      kind: "terminal",
      title: tab.title,
      clusterId: spec["clusterId"],
      namespace: str(spec["namespace"]) ? spec["namespace"] : null,
    };
  }
  if (tab.kind === "yaml") {
    const len = str(st["content"]) ? st["content"].length : 0;
    if (len > YAML_PERSIST_CAP || len > budget.left) return null;
    budget.left -= len;
    return {
      kind: "yaml",
      title: tab.title,
      content: str(st["content"]) ? st["content"] : "",
      templateId: str(st["templateId"]) ? st["templateId"] : null,
      pristine: st["pristine"] !== false,
      clusterId: str(st["clusterId"]) ? st["clusterId"] : null,
    };
  }
  if (!str(st["clusterId"])) return null;
  return {
    kind: "chat",
    clusterId: st["clusterId"],
    contextLabel: str(st["contextLabel"]) ? st["contextLabel"] : st["clusterId"],
    sessionId: str(st["sessionId"]) ? st["sessionId"] : null,
  };
}

export function snapshotSlice(s: SliceView, budget = { left: YAML_SESSION_BUDGET }): SessionTab {
  const kept: DockTab[] = [];
  const dock: SessionDock[] = [];
  for (const t of s.dockTabs) {
    const snap = snapshotDock(t, budget);
    if (snap) {
      kept.push(t);
      dock.push(snap);
    }
  }
  const indexOf = (id: string | null) => {
    const i = id == null ? -1 : kept.findIndex((t) => t.id === id);
    return i === -1 ? null : i;
  };
  return {
    dock,
    active: { bottom: indexOf(s.dockActive.bottom), right: indexOf(s.dockActive.right) },
    dockMin: { ...s.dockMin },
    drawer: s.drawer,
    tray: s.tray.map((i) => i.drawer),
  };
}

/// The active tab's live state is the top-level mirror; background tabs keep
/// theirs in `slice`.
export function buildSession(
  s: SliceView & { openTabs: ClusterTab[]; activeTabId: string | null },
): SessionFile {
  const tabs: Record<string, SessionTab> = {};
  const budget = { left: YAML_SESSION_BUDGET };
  // The active tab spends the budget first.
  if (s.activeTabId !== null) tabs[s.activeTabId] = snapshotSlice(s, budget);
  for (const tab of s.openTabs) {
    if (tab.id !== s.activeTabId) tabs[tab.id] = snapshotSlice(tab.slice, budget);
  }
  const order = s.openTabs.map((t) => t.id).filter((id) => tabs[id]);
  return { version: SESSION_VERSION, tabs: Object.fromEntries(order.map((id) => [id, tabs[id]!])) };
}

function restoreDock(d: unknown): DockTab | null {
  if (!obj(d)) return null;
  if (d["kind"] === "terminal" && str(d["clusterId"])) {
    const tab = makeTerminalTab(
      {
        mode: "shell",
        clusterId: d["clusterId"],
        namespace: str(d["namespace"]) ? d["namespace"] : null,
      },
      d["clusterId"],
    );
    return str(d["title"]) ? { ...tab, title: d["title"] } : tab;
  }
  if (d["kind"] === "yaml") {
    const tab = makeYamlTab(
      str(d["clusterId"]) ? d["clusterId"] : null,
      str(d["templateId"]) ? d["templateId"] : undefined,
    );
    return {
      ...tab,
      title: str(d["title"]) ? d["title"] : tab.title,
      state: {
        ...tab.state,
        content: str(d["content"]) ? d["content"] : tab.state["content"],
        pristine: d["pristine"] !== false,
      },
    };
  }
  if (d["kind"] === "chat" && str(d["clusterId"])) {
    return makeChatTab(
      d["clusterId"],
      str(d["contextLabel"]) ? d["contextLabel"] : d["clusterId"],
      str(d["sessionId"]) ? d["sessionId"] : undefined,
    );
  }
  return null;
}

const DRAWER_KINDS = new Set(["detail", "logs", "compare", "inspect"]);

const nstr = (v: unknown) => v === null || v === undefined || str(v);
const detailRefOk = (r: unknown): boolean =>
  obj(r) && str(r["kindId"]) && str(r["clusterId"]) && str(r["uid"]) && str(r["name"]) && nstr(r["namespace"]);
const sideOk = (x: unknown): boolean =>
  obj(x) && str(x["clusterId"]) && str(x["name"]) && nstr(x["namespace"]) && typeof x["colorIdx"] === "number";
// Back keeps the newest entries (the tail), forward the nearest (the head).
const history = (v: unknown, keepTail: boolean): DetailRef[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const ok = v.filter(detailRefOk).map((r) => detailRef(r as DetailRef));
  return keepTail ? ok.slice(-DETAIL_HISTORY_CAP) : ok.slice(0, DETAIL_HISTORY_CAP);
};

function restoreDrawer(d: unknown): Drawer | null {
  if (!obj(d) || !str(d["kind"]) || !DRAWER_KINDS.has(d["kind"])) return null;
  switch (d["kind"]) {
    case "detail": {
      if (!detailRefOk(d)) return null;
      const view = obj(d["view"]) ? d["view"] : null;
      return {
        kind: "detail",
        ...detailRef(d as unknown as DetailRef),
        namespace: str(d["namespace"]) ? d["namespace"] : null,
        view: view
          ? {
              tab: str(view["tab"]) ? view["tab"] : undefined,
              scrollTop: typeof view["scrollTop"] === "number" ? view["scrollTop"] : undefined,
            }
          : undefined,
        back: history(d["back"], true),
        forward: history(d["forward"], false),
      };
    }
    case "logs": {
      const targets = d["targets"];
      return Array.isArray(targets) &&
        targets.length > 0 &&
        targets.every((x) => obj(x) && str(x["clusterId"]) && str(x["kindId"]) && str(x["namespace"]) && str(x["name"]))
        ? (d as Drawer)
        : null;
    }
    case "compare": {
      const t = d["target"];
      return obj(t) && str(t["kindId"]) && str(t["kindLabel"]) && sideOk(t["a"]) && sideOk(t["b"]) ? (d as Drawer) : null;
    }
    default: {
      const t = d["target"];
      return obj(t) &&
        str(t["kindId"]) &&
        str(t["kindLabel"]) &&
        Array.isArray(t["subjects"]) &&
        t["subjects"].length > 0 &&
        t["subjects"].every((x) => sideOk(x) && str(x["sid"]) && str(x["uid"]))
        ? (d as Drawer)
        : null;
    }
  }
}

/// Rebuild a tab's slice fields from untrusted JSON. Dock tabs get fresh ids
/// (the id counter restarts every launch); anything malformed is dropped.
export function restoreSlice(raw: unknown): SliceView | null {
  if (!obj(raw)) return null;
  const dockTabs: DockTab[] = [];
  const remap = new Map<number, string>();
  (Array.isArray(raw["dock"]) ? raw["dock"] : []).forEach((d, i) => {
    const tab = restoreDock(d);
    if (tab) {
      remap.set(i, tab.id);
      dockTabs.push(tab);
    }
  });
  const active = obj(raw["active"]) ? raw["active"] : {};
  const min = obj(raw["dockMin"]) ? raw["dockMin"] : {};
  const pick = (p: DockPlacement): string | null => {
    const want = active[p];
    const id = typeof want === "number" ? remap.get(want) : undefined;
    const inPlacement = dockTabs.filter((t) => placementOf(t) === p);
    return inPlacement.find((t) => t.id === id)?.id ?? inPlacement[inPlacement.length - 1]?.id ?? null;
  };
  const tray: TrayItem[] = (Array.isArray(raw["tray"]) ? raw["tray"] : [])
    .map(restoreDrawer)
    .filter((d): d is Drawer => d !== null)
    .map((drawer) => ({ id: crypto.randomUUID(), drawer }));
  const has = (p: DockPlacement) => dockTabs.some((t) => placementOf(t) === p);
  return {
    dockTabs,
    dockActive: { bottom: pick("bottom"), right: pick("right") },
    dockMin: { bottom: has("bottom") && min["bottom"] === true, right: has("right") && min["right"] === true },
    drawer: restoreDrawer(raw["drawer"]),
    tray,
  };
}

export function parseSession(raw: unknown): Record<string, SliceView> {
  if (!obj(raw) || raw["version"] !== SESSION_VERSION || !obj(raw["tabs"])) return {};
  const out: Record<string, SliceView> = {};
  for (const [id, tab] of Object.entries(raw["tabs"])) {
    const slice = restoreSlice(tab);
    if (slice) out[id] = slice;
  }
  return out;
}
