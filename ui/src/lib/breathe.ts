// Drives `.fs-breathe` (the in-progress status bar). A CSS animation
// (WebKitGTK repaints every frame: ~30% CPU on a busy Pods table) and a
// stepped stylesheet rule (each change restyles the whole document: ~24%)
// were too costly, so one timer writes inline opacity on just the breathing
// elements: ~1.7% at 30 fps. Cost follows the element count, not the frame
// rate — which is why container dots don't breathe. Idle while nothing
// breathes or the window is hidden.
export const BREATHE_PERIOD_MS = 1600;
export const BREATHE_FPS = 30;

export function breatheOpacity(nowMs: number): string {
  const phase = (nowMs % BREATHE_PERIOD_MS) / BREATHE_PERIOD_MS;
  return (0.7 + 0.3 * Math.cos(2 * Math.PI * phase)).toFixed(2);
}

export function startBreathe(
  doc: Document = document,
  now: () => number = () => performance.now(),
): () => void {
  if (doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return () => {};
  }
  const live = doc.getElementsByClassName("fs-breathe");
  const id = setInterval(() => {
    if (doc.hidden || live.length === 0) return;
    const opacity = breatheOpacity(now());
    for (let i = 0; i < live.length; i++) {
      (live[i] as HTMLElement).style.opacity = opacity;
    }
  }, 1000 / BREATHE_FPS);
  return () => clearInterval(id);
}
