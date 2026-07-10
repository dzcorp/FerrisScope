import { describe, it, expect } from "vitest";
import { PROVIDER_ORDER } from "./providers";
import type { ProviderKind } from "../types";

describe("PROVIDER_ORDER", () => {
  it("has no duplicate provider kinds", () => {
    expect(new Set(PROVIDER_ORDER).size).toBe(PROVIDER_ORDER.length);
  });

  it("leads with the free-tier default so fresh installs can chat", () => {
    // OpenCode Zen works without a key — it must be first so a brand-new
    // user sees a usable provider at the top of both surfaces.
    expect(PROVIDER_ORDER[0]).toBe("opencode_zen");
  });

  it("covers every ProviderKind exactly once", () => {
    // Mirror of the union in types.ts. `satisfies Record<ProviderKind, ...>`
    // in providers.ts guarantees this at compile time; this asserts the same
    // set at runtime so a drift in either list fails loudly.
    const expected: ProviderKind[] = [
      "opencode_zen",
      "openai",
      "anthropic",
      "open_router",
      "zai",
      "minimax",
      "groq",
      "deepseek",
      "mistral",
      "together",
      "ollama",
    ];
    expect([...PROVIDER_ORDER].sort()).toEqual([...expected].sort());
  });
});
