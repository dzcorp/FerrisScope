import { describe, it, expect } from "vitest";
import { isProviderUsable, orderedProviders } from "./providers";
import type { ProviderKind, ProviderStatusWire } from "../types";

function status(kind: ProviderKind): ProviderStatusWire {
  return { kind, display_name: kind } as ProviderStatusWire;
}

describe("orderedProviders", () => {
  const providers = {
    anthropic: status("anthropic"),
    openai: status("openai"),
    opencode_zen: status("opencode_zen"),
  } as Record<ProviderKind, ProviderStatusWire>;

  it("follows the backend order, not the map's key order", () => {
    const out = orderedProviders({
      providers,
      provider_order: ["opencode_zen", "openai", "anthropic"],
    });
    expect(out.map((p) => p.kind)).toEqual(["opencode_zen", "openai", "anthropic"]);
  });

  it("skips kinds the backend ordered but did not describe", () => {
    const out = orderedProviders({
      providers,
      provider_order: ["openai", "google" as ProviderKind, "anthropic"],
    });
    expect(out.map((p) => p.kind)).toEqual(["openai", "anthropic"]);
  });

  it("omits providers missing from the order", () => {
    const out = orderedProviders({ providers, provider_order: ["openai"] });
    expect(out.map((p) => p.kind)).toEqual(["openai"]);
  });
});

describe("isProviderUsable", () => {
  it("needs the provider switched on and connected", () => {
    expect(isProviderUsable({ enabled: true, configured: true })).toBe(true);
    expect(isProviderUsable({ enabled: true, configured: false })).toBe(false);
    // A stored key doesn't make a switched-off provider usable.
    expect(isProviderUsable({ enabled: false, configured: true })).toBe(false);
    expect(isProviderUsable({ enabled: false, configured: false })).toBe(false);
  });
});
