// LogView owns the pod-log streaming lifecycle shared by both surfaces
// (LogPanel overlay + InlineLogTab). These tests pin the status state
// machine the chrome depends on:
//   • opening a stream:           starting → streaming
//   • backend polling a container: → waiting (no line appended)
//   • first output after waiting:  → streaming again
//   • stream end:                  → ended, with a system line appended
//   • no container:                no stream opened at all

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { LogView, type LogViewState } from "./LogView";
import { tokens } from "../../theme";
import { setMockInvoke, resetMockInvoke, Channel } from "../../test/tauri-mock";
import type { LogEvent } from "../../types";

const t = tokens("dark");

// Wire up the `start_log_stream` / `stop_log_stream` IPC pair and capture
// the Channel the component opens, so a test can push LogEvent frames
// through it exactly as the Rust backend would.
function mockLogStream() {
  let channel: Channel<LogEvent> | null = null;
  const stopped: string[] = [];
  setMockInvoke((cmd, args) => {
    if (cmd === "start_log_stream") {
      channel = args!.onEvent as Channel<LogEvent>;
      return "s1";
    }
    if (cmd === "stop_log_stream") {
      stopped.push(String(args!.streamId));
      return undefined;
    }
    return undefined;
  });
  return {
    emit: (evt: LogEvent) => act(() => channel!.onmessage(evt)),
    get started() {
      return channel !== null;
    },
    stopped,
  };
}

function renderLogView(
  container: string | null,
  onStateChange?: (s: LogViewState) => void,
) {
  return render(
    <LogView
      t={t}
      clusterId="ctx"
      namespace="default"
      pod="mypod"
      container={container}
      onStateChange={onStateChange}
    />,
  );
}

beforeEach(() => {
  // Run rAF synchronously so the ring-buffer → setLines flush lands
  // inside the test's `act()` instead of on a deferred jsdom timer.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetMockInvoke();
});

describe("LogView", () => {
  it("does not open a stream when there is no container", async () => {
    const m = mockLogStream();
    await act(async () => {
      renderLogView(null);
    });
    expect(m.started).toBe(false);
  });

  it("transitions starting → streaming once the stream opens", async () => {
    const m = mockLogStream();
    const states: LogViewState[] = [];
    const collect = (s: LogViewState) => states.push(s);
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = renderLogView("app", collect);
    });
    expect(m.started).toBe(true);
    expect(states.at(-1)!.status.kind).toBe("streaming");
    expect(utils.getByText("Waiting for output…")).toBeInTheDocument();
  });

  it("reflects a `waiting` event without appending a log line", async () => {
    const m = mockLogStream();
    const states: LogViewState[] = [];
    const collect = (s: LogViewState) => states.push(s);
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = renderLogView("app", collect);
    });
    await m.emit({
      kind: "waiting",
      reason: "container app is waiting to start: PodInitializing",
    });
    const last = states.at(-1)!;
    expect(last.status).toEqual({
      kind: "waiting",
      reason: "container app is waiting to start: PodInitializing",
    });
    // `waiting` is a status change only — it must not push a line.
    expect(last.lineCount).toBe(0);
    expect(
      utils.getByText("Waiting for container to start…"),
    ).toBeInTheDocument();
    expect(utils.getByText(/PodInitializing/)).toBeInTheDocument();
  });

  it("flips back to streaming when the first line arrives after waiting", async () => {
    const m = mockLogStream();
    const states: LogViewState[] = [];
    const collect = (s: LogViewState) => states.push(s);
    await act(async () => {
      renderLogView("app", collect);
    });
    await m.emit({ kind: "waiting", reason: "PodInitializing" });
    expect(states.at(-1)!.status.kind).toBe("waiting");
    await m.emit({
      kind: "line",
      text: "2026-05-14T10:30:00.000Z hello from the container",
    });
    const last = states.at(-1)!;
    expect(last.status.kind).toBe("streaming");
    expect(last.lineCount).toBe(1);
  });

  it("ends the stream and appends a system line on an `ended` event", async () => {
    const m = mockLogStream();
    const states: LogViewState[] = [];
    const collect = (s: LogViewState) => states.push(s);
    await act(async () => {
      renderLogView("app", collect);
    });
    await m.emit({ kind: "ended", reason: "stream closed" });
    const last = states.at(-1)!;
    expect(last.status).toEqual({ kind: "ended", reason: "stream closed" });
    // Unlike `waiting`, `ended` does append a system line to the body.
    expect(last.lineCount).toBe(1);
  });

  it("Cmd+F opens an in-place find bar that counts matches", async () => {
    const m = mockLogStream();
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = renderLogView("app");
    });
    // A single batch (one ring flush) seeds both lines — emitting two
    // separate `line` events would trip the synchronous-rAF test stub, where
    // requestAnimationFrame returns 0 and the per-line flush guard blocks the
    // second coalesced setLines.
    await m.emit({ kind: "batch", lines: ["hello world", "goodbye world"] });

    const root = utils.container.firstChild as HTMLElement;
    // Closed by default.
    expect(utils.queryByPlaceholderText("Find")).toBeNull();

    await act(async () => {
      fireEvent.keyDown(root, { key: "f", code: "KeyF", metaKey: true });
    });
    const input = utils.getByPlaceholderText("Find") as HTMLInputElement;
    expect(input).toBeInTheDocument();

    // Two lines contain "world" → 1/2 (first match active).
    await act(async () => {
      fireEvent.change(input, { target: { value: "world" } });
    });
    expect(utils.getByText("1/2")).toBeInTheDocument();

    // One line contains "hello" → 1/1.
    await act(async () => {
      fireEvent.change(input, { target: { value: "hello" } });
    });
    expect(utils.getByText("1/1")).toBeInTheDocument();

    // No match → 0/0.
    await act(async () => {
      fireEvent.change(input, { target: { value: "zzz" } });
    });
    expect(utils.getByText("0/0")).toBeInTheDocument();

    // Esc closes the bar.
    await act(async () => {
      fireEvent.keyDown(root, { key: "Escape" });
    });
    expect(utils.queryByPlaceholderText("Find")).toBeNull();
  });

  it("stops the backend stream on unmount", async () => {
    const m = mockLogStream();
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = renderLogView("app");
    });
    await act(async () => {
      utils.unmount();
    });
    expect(m.stopped).toContain("s1");
  });
});
