import { defineConfig } from "@playwright/test";

// E2E config — drives FerrisScope through tauri-driver, which speaks the
// WebDriver protocol on a local port. tauri-driver expects the packaged
// binary path via the `WEBDRIVER_BIN` env var.
//
// Local run:
//   1. cargo build -p ferrisscope-app --release
//   2. WEBDRIVER_BIN=$PWD/target/release/ferrisscope tauri-driver --port 4444
//   3. cd e2e && npm test
//
// CI: see the `e2e` job in .github/workflows/ci.yml — it bundles the app,
// installs tauri-driver, and orchestrates the Playwright run against a
// kind cluster brought up by the same job.

export default defineConfig({
  testDir: "./tests",
  // E2E flows depend on real cluster state, watcher subscriptions, and
  // multi-second IPC dances. Single-worker keeps assertions stable; the
  // suite runs in seconds anyway.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    // tauri-driver listens here by default. The session script in
    // `tests/_session.ts` is what actually negotiates the WebDriver
    // capabilities since the Playwright API is abstracted over CDP and
    // doesn't natively speak WebDriver to a custom binary — we treat the
    // tauri-driver port as a remote browser instance.
    baseURL: "http://127.0.0.1:4444",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
