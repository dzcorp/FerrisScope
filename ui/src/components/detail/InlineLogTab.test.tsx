// InlineLogTab (detail-panel "Logs" tab) — the "Previous" toggle for viewing a
// crashed container's terminated instance (issue #63). The tab builds its
// single source directly from props (no backend pod resolution), so these
// tests only need the Tauri IPC mock.

import { describe, it, expect, afterEach } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { setMockInvoke, resetMockInvoke } from "../../test/tauri-mock";
import { InlineLogTab } from "./InlineLogTab";

type Call = { cmd: string; args?: Record<string, unknown> };

function mockBackend() {
  const calls: Call[] = [];
  let seq = 0;
  setMockInvoke((cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "start_log_stream") return `s${++seq}`;
    if (cmd === "stop_log_stream") return undefined;
    return undefined;
  });
  return { calls };
}

afterEach(() => {
  cleanup();
  resetMockInvoke();
});

function renderTab(containers: string[]) {
  return render(
    <InlineLogTab
      mode="dark"
      clusterId="kc::prod-eu"
      namespace="default"
      name="api-0"
      containers={containers.map((name) => ({ name, kind: "main" as const }))}
    />,
  );
}

describe("InlineLogTab previous-logs toggle", () => {
  it("streams the live instance by default (previous:false, no banner)", async () => {
    const m = mockBackend();
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = renderTab(["app"]);
    });
    const streams = m.calls.filter((c) => c.cmd === "start_log_stream");
    expect(streams).toHaveLength(1);
    expect(streams[0]!.args?.previous).toBe(false);
    expect(streams[0]!.args?.pod).toBe("api-0");
    expect(utils.queryByRole("status")).toBeNull();
  });

  it("toggling 'Previous' restarts the stream against the terminated instance and shows a banner", async () => {
    const m = mockBackend();
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = renderTab(["app"]);
    });

    await act(async () => {
      fireEvent.click(utils.getByRole("button", { name: "Previous" }));
      await Promise.resolve();
    });

    const prev = m.calls
      .filter((c) => c.cmd === "start_log_stream")
      .find((c) => c.args?.previous === true);
    expect(prev?.args?.pod).toBe("api-0");
    // Old live stream is torn down when the source key flips.
    expect(m.calls.some((c) => c.cmd === "stop_log_stream")).toBe(true);
    // Operator sees the warning banner.
    expect(utils.getByRole("status").textContent).toContain(
      "previous terminated instance",
    );

    // aria-pressed reflects the active state.
    expect(
      utils.getByRole("button", { name: "Previous" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
