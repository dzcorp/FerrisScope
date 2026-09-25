// Heavy surfaces loaded on first use instead of at startup, then warmed in
// the background once the app is idle so the first open doesn't wait.
export const loadDetailPanel = () =>
  import("../components/DetailPanel").then((m) => ({ default: m.DetailPanel }));

export const loadSettingsPanel = () =>
  import("../components/SettingsPanel").then((m) => ({ default: m.SettingsPanel }));

export const PREFETCH_DELAY_MS = 4000;

/// Fetch and compile the lazy chunks after startup has settled.
export function prefetchPanels(
  delayMs = PREFETCH_DELAY_MS,
  loaders: Array<() => Promise<unknown>> = [loadDetailPanel, loadSettingsPanel],
): () => void {
  const id = setTimeout(() => {
    for (const load of loaders) void load().catch(() => {});
  }, delayMs);
  return () => clearTimeout(id);
}
