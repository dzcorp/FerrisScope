import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { resetMockInvoke, setMockInvoke } from "../test/tauri-mock";
import { ObjectEvents } from "./DetailPanel";

afterEach(() => {
  cleanup();
  resetMockInvoke();
});

describe("ObjectEvents", () => {
  it("uses the server-filtered object Events command instead of a global subscription", async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    setMockInvoke((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd !== "list_object_events_cmd") {
        throw new Error(`unexpected command: ${cmd}`);
      }
      return [
        {
          uid: "event-uid",
          involved_uid: "pod-uid",
          type: "Normal",
          reason: "Started",
          message: "Started container api",
          count: 3,
          last_seen: "2026-07-15T08:07:00Z",
        },
      ];
    });

    await act(async () => {
      render(
        <ObjectEvents
          mode="dark"
          clusterId="ctx"
          targetNamespace="production"
          targetUid="pod-uid"
        />,
      );
    });

    expect(await screen.findByText("Started container api")).toBeInTheDocument();
    expect(screen.getByText("Normal")).toBeInTheDocument();
    expect(calls).toEqual([
      {
        cmd: "list_object_events_cmd",
        args: {
          clusterId: "ctx",
          namespace: "production",
          uid: "pod-uid",
        },
      },
    ]);
  });
});
