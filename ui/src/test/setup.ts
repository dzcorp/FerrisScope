// Vitest setup — runs once per test file before any test executes.
//
// What's wired up here:
//   - jest-dom matchers (toBeInTheDocument, etc.) on Vitest's expect
//   - a small ResizeObserver shim so components that use TanStack Virtual
//     don't blow up under jsdom
//   - a stable Date.now baseline that helpers like ageFromIso can rely on
//     when a test wants to (overrideable per-test via vi.setSystemTime).

import "@testing-library/jest-dom/vitest";

// jsdom doesn't ship ResizeObserver. Headless render of any virtualised
// table would otherwise throw at mount time.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverShim {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverShim;
}

// matchMedia shim — some components peek at prefers-color-scheme.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
