import { confirm } from "./dialog";
import { useAppStore, type DockTab } from "../store";

/// Dock tabs whose closing loses something: a live PTY, a chat runtime, or an
/// edited YAML buffer.
export function liveDockTabs(tabs: DockTab[]): DockTab[] {
  return tabs.filter(
    (t) =>
      t.kind === "terminal" ||
      t.kind === "chat" ||
      (t.kind === "yaml" && t.state["pristine"] === false),
  );
}

export function describeLive(tabs: DockTab[]): string {
  const n = (k: DockTab["kind"]) => tabs.filter((t) => t.kind === k).length;
  const parts: string[] = [];
  const add = (count: number, one: string, many: string) => {
    if (count > 0) parts.push(`${count} ${count === 1 ? one : many}`);
  };
  add(n("terminal"), "terminal", "terminals");
  add(n("chat"), "chat", "chats");
  add(n("yaml"), "unsaved YAML buffer", "unsaved YAML buffers");
  return parts.join(", ");
}

/// Close dock tabs, confirming first when any of them holds live work.
export async function closeDockTabs(ids: string[]): Promise<boolean> {
  const s = useAppStore.getState();
  const closing = s.dockTabs.filter((t) => ids.includes(t.id));
  const live = liveDockTabs(closing);
  if (live.length > 0) {
    const ok = await confirm({
      title: closing.length === 1 ? `Close ${closing[0]?.title ?? "tab"}?` : `Close ${closing.length} tabs?`,
      body: `This ends ${describeLive(live)}. This can't be undone.`,
      confirmLabel: "Close",
      cancelLabel: "Keep open",
      tone: "danger",
    });
    if (!ok) return false;
  }
  const store = useAppStore.getState();
  for (const id of ids) store.closeDockTab(id);
  return true;
}
