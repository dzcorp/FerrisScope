import { describe, it, expect, vi, beforeEach } from "vitest";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import {
  cancelCloudLogin,
  startCloudLogin,
  subscribeCloudLogin,
  type CloudLoginView,
} from "./cloudLogin";

type Frame = { kind: "data"; b64: string } | { kind: "exit"; code: number };

function harness() {
  const opens: { account: unknown; send: (f: Frame) => void }[] = [];
  const closed: string[] = [];
  let seq = 0;
  setMockInvoke((cmd, args) => {
    if (cmd === "terminal_close") {
      closed.push((args as { sessionId: string }).sessionId);
      return undefined;
    }
    expect(cmd).toBe("cloud_login_open");
    const ch = args?.onEvent as { onmessage: (f: Frame) => void };
    opens.push({ account: args?.account, send: (f) => ch.onmessage(f) });
    seq += 1;
    return `s${seq}`;
  });
  return { opens, closed };
}

function follower(account: string | null) {
  const views: CloudLoginView[] = [];
  const onSuccess = vi.fn();
  const off = subscribeCloudLogin(account, {
    onChange: (v) => views.push(v),
    onSuccess,
  });
  return { views, onSuccess, off, last: () => views.at(-1) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetMockInvoke();
});

describe("cloudLogin", () => {
  it("keeps accounts apart and treats null as the active account", async () => {
    const h = harness();
    const a = follower("a@x.io");
    const active = follower(null);
    startCloudLogin("c1", "a@x.io");
    startCloudLogin("c2", null);
    await flush();
    expect(h.opens.map((o) => o.account)).toEqual(["a@x.io", null]);
    expect(a.last()?.running).toBe(true);
    expect(active.last()?.running).toBe(true);
    a.off();
    active.off();
    await flush();
    expect(h.closed.sort()).toEqual(["s1", "s2"]);
  });

  it("cancel stops the login for every follower", async () => {
    const h = harness();
    const a = follower("a@x.io");
    const b = follower("a@x.io");
    startCloudLogin("c1", "a@x.io");
    await flush();
    cancelCloudLogin("a@x.io");
    expect(h.closed).toEqual(["s1"]);
    expect(a.last()?.running).toBe(false);
    expect(b.last()?.running).toBe(false);
    // A late exit frame from the killed process is not a result.
    h.opens[0]!.send({ kind: "exit", code: 0 });
    expect(a.onSuccess).not.toHaveBeenCalled();
    a.off();
    b.off();
  });

  it("starts a fresh process after a failed one", async () => {
    const h = harness();
    const a = follower("a@x.io");
    startCloudLogin("c1", "a@x.io");
    await flush();
    h.opens[0]!.send({ kind: "data", b64: btoa("nope") });
    h.opens[0]!.send({ kind: "exit", code: 2 });
    expect(a.last()).toEqual({
      running: false,
      log: "nope\n[gcloud exited with code 2]",
    });
    startCloudLogin("c1", "a@x.io");
    await flush();
    expect(h.opens).toHaveLength(2);
    expect(a.last()).toEqual({ running: true, log: "" });
    a.off();
  });

  it("closes the session when every follower left before the open ack", async () => {
    const h = harness();
    const a = follower("a@x.io");
    startCloudLogin("c1", "a@x.io");
    a.off();
    await flush();
    expect(h.closed).toEqual(["s1"]);
  });

  it("a newcomer sees the running login's output so far", async () => {
    const h = harness();
    const a = follower("a@x.io");
    startCloudLogin("c1", "a@x.io");
    await flush();
    h.opens[0]!.send({ kind: "data", b64: btoa("open https://x") });
    const b = follower("a@x.io");
    expect(b.last()).toEqual({ running: true, log: "open https://x" });
    a.off();
    b.off();
  });
});
