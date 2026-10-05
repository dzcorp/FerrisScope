import type { AiSettingsWire, ProviderStatusWire } from "../types";

/// Providers in the backend's display order (`provider_order` on the wire),
/// so Settings → AI and the chat-header switcher render identically.
/// Kinds the backend lists but doesn't describe are skipped.
export function orderedProviders(
  settings: Pick<AiSettingsWire, "providers" | "provider_order">,
): ProviderStatusWire[] {
  return settings.provider_order.flatMap((kind) => {
    const p = settings.providers[kind];
    return p ? [p] : [];
  });
}

/// A provider that can serve a chat right now: switched on and holding a
/// credential (or the free-tier fallback, which `configured` already counts).
export function isProviderUsable(
  p: Pick<ProviderStatusWire, "enabled" | "configured">,
): boolean {
  return p.enabled && p.configured;
}
