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

test("e2e harness reachable", async ({ request }) => {
  // The simplest possible "the harness is alive" probe — we GET the
  // WebDriver status endpoint exposed by tauri-driver. This intentionally
  // doesn't open the app; that's covered by the spec'd flows below.
  const status = await request.get("/status").catch(() => null);
  // tauri-driver returns 200 with `{ value: { ready: true } }` on the
  // WebDriver Status endpoint. We don't depend on the exact body shape —
  // any 2xx means the harness booted.
  if (!status) {
    test.skip(true, "tauri-driver not reachable; start it before running e2e");
    return;
  }
  expect(status.ok()).toBe(true);
});

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
