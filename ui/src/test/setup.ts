// Vitest setup — runs once per test file before any test executes.
//
// What's wired up here:
//   - jest-dom matchers (toBeInTheDocument, etc.) on Vitest's expect
//   - a small ResizeObserver shim so components that use TanStack Virtual
//     don't blow up under jsdom
//   - a stable Date.now baseline that helpers like ageFromIso can rely on
//     when a test wants to (overrideable per-test via vi.setSystemTime).

import "@testing-library/jest-dom/vitest";
import { expect } from "vitest";

// A disabled `Btn` / `IconBtn` with a tooltip is `aria-disabled` rather than
// `disabled` (so the tooltip can explain why). To a user both are disabled;
// make `toBeDisabled` say so too, so `.not.toBeDisabled()` still proves a
// button works.
const inert = (el: unknown): boolean => {
  if (!(el instanceof Element)) throw new TypeError(`expected an Element, got ${String(el)}`);
  return el.matches(":disabled") || el.closest('[aria-disabled="true"]') != null;
};
expect.extend({
  toBeDisabled(received: unknown) {
    const pass = inert(received);
    return {
      pass,
      message: () => `expected element ${pass ? "not " : ""}to be disabled (disabled or aria-disabled)`,
    };
  },
  toBeEnabled(received: unknown) {
    const pass = !inert(received);
    return {
      pass,
      message: () => `expected element ${pass ? "not " : ""}to be enabled (neither disabled nor aria-disabled)`,
    };
  },
});

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
