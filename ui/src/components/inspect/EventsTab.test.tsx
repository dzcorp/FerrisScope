import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetMockInvoke, setMockInvoke } from "../../test/tauri-mock";
import { EventsTab } from "./EventsTab";
import { tokens } from "../../theme";
import type { InspectSubject } from ".";

afterEach(() => {
  cleanup();
  resetMockInvoke();
});

const t = tokens("dark");

function subject(name: string, uid: string): InspectSubject {
  return {
    sid: `ctx::${uid}`,
    uid,
    clusterId: "ctx",
    clusterName: "prod",
    colorIdx: 0,
    namespace: "default",
    name,
  };
}

const A = subject("web-a", "uid-a");
const B = subject("web-b", "uid-b");

function event(uid: string, involved: string, reason: string, seen: string) {
  return {
    uid,
    involved_uid: involved,
    type: "Normal",
    reason,
    message: `${reason} happened`,
    count: 1,
    last_seen: seen,
  };
}

async function mount(
  handler: (args: Record<string, unknown>) => unknown,
  subjects: InspectSubject[] = [A, B],
) {
  setMockInvoke((cmd, args) => {
    if (cmd !== "list_object_events_cmd") throw new Error(`bad cmd: ${cmd}`);
    return handler(args ?? {});
  });
  await act(async () => {
    render(<EventsTab t={t} mode="dark" subjects={subjects} />);
  });
}

describe("EventsTab", () => {
  it("merges every subject's events newest-first", async () => {
    await mount((args) =>
      args.uid === "uid-a"
        ? [event("e1", "uid-a", "ScaledUp", "2026-08-25T10:00:00Z")]
        : [event("e2", "uid-b", "Killing", "2026-08-25T11:00:00Z")],
    );
    const rows = screen.getAllByText(/happened$/);
    expect(rows).toHaveLength(2);
    // Newest first: uid-b's 11:00 event precedes uid-a's 10:00 one.
    expect(rows[0]?.textContent).toContain("Killing");
    expect(rows[1]?.textContent).toContain("ScaledUp");
  });

  it("tags each row with the object it belongs to", async () => {
    await mount((args) =>
      args.uid === "uid-a"
        ? [event("e1", "uid-a", "ScaledUp", "2026-08-25T10:00:00Z")]
        : [],
    );
    expect(screen.getByText("web-a")).toBeInTheDocument();
  });

  // One object's events failing shouldn't blank the others'.
  it("warns for a failed subject while still rendering the rest", async () => {
    await mount((args) => {
      if (args.uid === "uid-b") throw new Error("forbidden");
      return [event("e1", "uid-a", "ScaledUp", "2026-08-25T10:00:00Z")];
    });
    expect(screen.getByText("ScaledUp happened")).toBeInTheDocument();
    expect(screen.getByText(/web-b: .*forbidden/)).toBeInTheDocument();
  });

  // A proxy that ignores the field selector would hand back the namespace.
  it("drops rows whose involved_uid doesn't match the subject", async () => {
    await mount(
      () => [event("e9", "someone-else", "Unrelated", "2026-08-25T10:00:00Z")],
      [A],
    );
    expect(screen.getByText("No events")).toBeInTheDocument();
  });

  // Gating the initial load on document.hidden (not just the poll) left the
  // tab stuck on "Loading events…" until the window was visible AND a 10s
  // tick landed.
  it("still fetches when the window is backgrounded", async () => {
    const spy = vi
      .spyOn(document, "hidden", "get")
      .mockReturnValue(true);
    try {
      await mount(
        () => [event("e1", "uid-a", "ScaledUp", "2026-08-25T10:00:00Z")],
        [A],
      );
      expect(screen.getByText("ScaledUp happened")).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  // Absent timestamps sorted lexically landed at the bottom regardless of the
  // event's real time.
  it("orders by parsed timestamp, not string compare", async () => {
    await mount(
      () => [
        event("e1", "uid-a", "Older", "2026-08-25T09:00:00Z"),
        event("e2", "uid-a", "Newer", "2026-08-25T10:00:00Z"),
      ],
      [A],
    );
    const rows = screen.getAllByText(/happened$/);
    expect(rows[0]?.textContent).toContain("Newer");
  });

  it("shows an empty state when nothing has events", async () => {
    await mount(() => []);
    expect(screen.getByText("No events")).toBeInTheDocument();
  });
});
