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
import { LogView, type LogViewSource, type LogViewState } from "./LogView";
import { tokens } from "../../theme";
import { setMockInvoke, resetMockInvoke, Channel } from "../../test/tauri-mock";
import type { LogEvent } from "../../types";
import { useAppStore } from "../../store";

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

function srcFor(
  pod: string,
  container: string,
  label = "",
  colorIdx = 0,
): LogViewSource {
  return {
    key: ["ctx", "default", pod, container].join("\u0000"),
    clusterId: "ctx",
    namespace: "default",
    pod,
    container,
    containerKind: "main",
    previous: false,
    tailLines: 200,
    label,
    colorIdx,
  };
}

function renderLogView(
  container: string | null,
  onStateChange?: (s: LogViewState) => void,
) {
  const sources = container ? [srcFor("mypod", container)] : [];
  return render(
    <LogView t={t} sources={sources} onStateChange={onStateChange} />,
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

  it("reopens an interrupted stream after the cluster reconnects, resuming after the last line", async () => {
    const starts: Record<string, unknown>[] = [];
    const stopped: string[] = [];
    let channel: Channel<LogEvent> | null = null;
    setMockInvoke((cmd, args) => {
      if (cmd === "start_log_stream") {
        starts.push(args!);
        channel = args!.onEvent as Channel<LogEvent>;
        return `s${starts.length}`;
      }
      if (cmd === "stop_log_stream") stopped.push(String(args!.streamId));
      return undefined;
    });
    // Deferred rAF: the synchronous stub never clears the pending handle, so
    // only the first flush of a test would land.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queueMicrotask(() => cb(0));
      return 1;
    });
    const emit = (evt: LogEvent) =>
      act(async () => {
        channel!.onmessage(evt);
      });
    const states: LogViewState[] = [];
    await act(async () => {
      renderLogView("app", (st) => states.push(st));
    });
    expect(starts[0]!.resumeAfter).toBeNull();
    await emit({ kind: "line", text: "2026-05-14T10:30:00.500Z before sleep" });
    await emit({ kind: "interrupted", reason: "cluster connection reset" });
    expect(states.at(-1)!.status.kind).toBe("waiting");
    expect(stopped).toEqual(["s1"]);

    useAppStore.setState({ clusterReconnecting: { ctx: true } });
    await act(async () => useAppStore.getState().clearClusterHealth("ctx"));
    expect(starts).toHaveLength(1);

    useAppStore.setState({ clusterReconnecting: {} });
    await act(async () => useAppStore.getState().clearClusterHealth("ctx"));
    expect(starts).toHaveLength(2);
    expect(starts[1]!.resumeAfter).toBe("2026-05-14T10:30:00.500Z");
    expect(states.at(-1)!.status.kind).toBe("streaming");
    // line + "connection lost" + "reconnected"
    expect(states.at(-1)!.lineCount).toBe(3);
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

// Multi-stream mock: one Channel per started stream, keyed by pod name, so
// aggregated tests can drive each source independently. Also services the
// Download path (`plugin:dialog|save` + `save_text_file`).
function mockLogStreams(savePath: string | null = "/tmp/out.log") {
  const channels = new Map<string, Channel<LogEvent>>();
  const stopped: string[] = [];
  let saved: { path: string; contents: string } | null = null;
  let seq = 0;
  setMockInvoke((cmd, args) => {
    if (cmd === "start_log_stream") {
      channels.set(String(args!.pod), args!.onEvent as Channel<LogEvent>);
      return `s${++seq}`;
    }
    if (cmd === "stop_log_stream") {
      stopped.push(String(args!.streamId));
      return undefined;
    }
    if (cmd === "plugin:dialog|save") return savePath;
    if (cmd === "save_text_file") {
      saved = {
        path: String(args!.path),
        contents: String(args!.contents),
      };
      return undefined;
    }
    return undefined;
  });
  return {
    emit: (pod: string, evt: LogEvent) =>
      act(() => channels.get(pod)!.onmessage(evt)),
    get startedPods() {
      return [...channels.keys()];
    },
    stopped,
    get saved() {
      return saved;
    },
  };
}

describe("LogView (aggregated sources)", () => {
  const twoSources = [
    srcFor("api-0", "app", "api-0", 0),
    srcFor("web-0", "app", "web-0", 1),
  ];

  it("opens one stream per source and interleaves their lines", async () => {
    const m = mockLogStreams();
    const states: LogViewState[] = [];
    await act(async () => {
      render(
        <LogView
          t={t}
          sources={twoSources}
          onStateChange={(s) => states.push(s)}
        />,
      );
    });
    expect(m.startedPods.sort()).toEqual(["api-0", "web-0"]);
    await m.emit("api-0", { kind: "batch", lines: ["from api"] });
    await m.emit("web-0", { kind: "batch", lines: ["from web"] });
    expect(states.at(-1)!.status.kind).toBe("streaming");
    // Interleaved buffer content is asserted via the Download export below —
    // the synchronous-rAF test stub only flushes the first paint, so
    // `lineCount` undercounts here (see the find-bar test's comment).
    expect(states.at(-1)!.lineCount).toBeGreaterThan(0);
  });

  it("keeps streaming while one source ends, ends once all do", async () => {
    const m = mockLogStreams();
    const states: LogViewState[] = [];
    await act(async () => {
      render(
        <LogView
          t={t}
          sources={twoSources}
          onStateChange={(s) => states.push(s)}
        />,
      );
    });
    await m.emit("api-0", { kind: "ended", reason: "container exited" });
    expect(states.at(-1)!.status.kind).toBe("streaming");
    await m.emit("web-0", { kind: "ended", reason: "container exited" });
    expect(states.at(-1)!.status.kind).toBe("ended");
  });

  it("labels per-source end markers", async () => {
    const m = mockLogStreams("/tmp/markers.log");
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<LogView t={t} sources={twoSources} />);
    });
    await m.emit("api-0", { kind: "ended", reason: "container exited" });
    // Buffer content is asserted via the export (the virtualized body
    // renders nothing under jsdom's zero-height scroll element).
    await act(async () => {
      fireEvent.click(utils.getByText("Download"));
    });
    expect(m.saved!.contents).toContain(
      "— [api-0] stream ended: container exited",
    );
  });

  it("stops every stream on unmount", async () => {
    const m = mockLogStreams();
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<LogView t={t} sources={twoSources} />);
    });
    await act(async () => {
      utils.unmount();
    });
    expect(m.stopped.sort()).toEqual(["s1", "s2"]);
  });

  it("Download saves the buffer with source labels via the OS dialog", async () => {
    const m = mockLogStreams("/tmp/agg.log");
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<LogView t={t} sources={twoSources} />);
    });
    await m.emit("api-0", { kind: "line", text: "alpha" });
    await m.emit("web-0", { kind: "line", text: "beta" });
    await act(async () => {
      fireEvent.click(utils.getByText("Download"));
    });
    expect(m.saved).not.toBeNull();
    expect(m.saved!.path).toBe("/tmp/agg.log");
    expect(m.saved!.contents).toContain("[api-0] alpha");
    expect(m.saved!.contents).toContain("[web-0] beta");
  });

  it("renders the buffer-size selector defaulting to 5k lines", async () => {
    mockLogStreams();
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<LogView t={t} sources={twoSources} />);
    });
    expect(utils.getByText("keep")).toBeInTheDocument();
    expect(utils.getByText("5k lines")).toBeInTheDocument();
  });

  it("Download is a no-op when the dialog is cancelled", async () => {
    const m = mockLogStreams(null);
    let utils!: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<LogView t={t} sources={twoSources} />);
    });
    await m.emit("api-0", { kind: "line", text: "alpha" });
    await act(async () => {
      fireEvent.click(utils.getByText("Download"));
    });
    expect(m.saved).toBeNull();
  });

  // The footer chrome (Pause/Find/Download/keep) must follow the app theme via
  // `chromeT` so it adapts to day/night, while the log body stays on the dark
  // console `t`. Regression for "bottom buttons always black regardless of mode".
  it("paints the footer with chromeT, not the console tokens", async () => {
    resetMockInvoke();
    const consoleT = tokens("dark");
    async function pauseBg(chrome: ReturnType<typeof tokens>) {
      let utils!: ReturnType<typeof render>;
      await act(async () => {
        utils = render(
          <LogView t={consoleT} chromeT={chrome} sources={[]} />,
        );
      });
      const bg = utils.getByText("Pause").style.background;
      utils.unmount();
      return bg;
    }
    const lightFooter = await pauseBg(tokens("light"));
    const darkFooter = await pauseBg(tokens("dark"));
    // If the footer still used the console `t` it would ignore `chromeT` and
    // both renders would match the console surface. They differ ⇒ footer honours
    // chromeT and adapts to day/night.
    expect(lightFooter).not.toBe(darkFooter);
    expect(lightFooter).toBeTruthy();
  });
});
