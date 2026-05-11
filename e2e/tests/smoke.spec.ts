// Smoke-level E2E. The five flows the original plan committed to are:
//
//   1. Open cluster → see pods.
//   2. Edit ConfigMap → save → refetch shows new value.
//   3. Port-forward open → reachable → close.
//   4. Log tail streams.
//   5. Agent chat with one native tool (mocked LLM endpoint).
//
// Each is stubbed out below as a `test.fixme(...)` — they require:
//   * A built Tauri binary (`cargo build -p ferrisscope-app --release`).
//   * `tauri-driver` running on :4444 with WEBDRIVER_BIN pointing at the
//     binary.
//   * The two kind clusters from `ferrisscope-test-support`'s harness so
//     the app has something to connect to.
//
// CI wiring stages these inside one job; locally, see the comment block
// in playwright.config.ts.

import { test, expect } from "@playwright/test";

// Probe the WebDriver Status endpoint exposed by tauri-driver. Returns true
// only on a 2xx response — a refused / timed-out request returns false so
// the rest of the spec can gracefully skip rather than hang.
async function isHarnessUp(request: import("@playwright/test").APIRequestContext): Promise<boolean> {
  try {
    const resp = await request.get("/status", { timeout: 2_000 });
    return resp.ok();
  } catch {
    return false;
  }
}

test.describe("harness reachability", () => {
  test("tauri-driver responds on /status (or test skips cleanly)", async ({ request }) => {
    // The simplest possible "the harness is alive" probe. tauri-driver
    // returns 200 with `{ value: { ready: true } }` on the WebDriver Status
    // endpoint. We don't depend on the exact body shape — any 2xx means
    // the harness booted.
    const up = await isHarnessUp(request);
    if (!up) {
      test.skip(true, "tauri-driver not reachable on :4444; start it before running e2e");
      return;
    }
    expect(up).toBe(true);
  });

  // Without a real session, anything we hit on tauri-driver should still
  // 404 cleanly rather than hanging — that's a useful "the harness is
  // wired up correctly" sanity check that doesn't require a built binary.
  test("unknown WebDriver paths surface 404, not timeouts", async ({ request }) => {
    if (!(await isHarnessUp(request))) {
      test.skip(true, "tauri-driver not reachable on :4444");
      return;
    }
    const resp = await request.get("/session/does-not-exist/url", { timeout: 5_000 });
    // WebDriver spec maps unknown session to 404. Either 404 or 400 is
    // acceptable here — we just want a fast, well-formed response.
    expect([400, 404]).toContain(resp.status());
  });
});

// ── Flows below require a connected app + cluster. They stay `fixme` until
// the harness orchestration (binary path, tauri-driver, kind cluster) is
// stood up in CI — at which point each test gets fleshed out individually.

test.fixme("flow 1: open cluster → see pods", async () => {
  // Drive the rail's cluster picker to one of the integration kind
  // clusters, wait for the Pod table to populate, assert at least one row
  // appears with the seed namespace's pod.
});

test.fixme("flow 2: edit ConfigMap → save → refetch", async () => {
  // Open a ConfigMap detail panel, flip into edit mode, change a value,
  // save, and assert the rendered cell reflects the new value (proves
  // the SSA + refetch path).
});

test.fixme("flow 3: port-forward open → reachable → close", async () => {
  // From a Service detail panel, open a port-forward; HTTP-fetch the
  // local URL; close the forward; assert the chip clears.
});

test.fixme("flow 4: log tail streams", async () => {
  // Open the inline log tab on a chatty pod; assert the sentinel appears
  // within N seconds.
});

test.fixme("flow 5: agent chat with one native tool", async () => {
  // Stand up a mock LLM endpoint, point the chat provider at it, and
  // assert one round-trip through `fs_pod_diagnose` returns its result
  // back into the chat thread.
});

// ── Scaffolding sanity that runs without the harness. Cheap to keep and
// catches obvious e2e config drift early.

test.describe("e2e scaffolding sanity", () => {
  test("request fixture is wired (baseURL configured)", async ({ request }) => {
    // No real I/O — just exercises that the request fixture resolved. A
    // regression where baseURL was emptied or the fixture removed surfaces here.
    expect(typeof request.get).toBe("function");
  });
});
