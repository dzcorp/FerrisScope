import { useCallback, useEffect, useRef, useState } from "react";

// Distance from the bottom (in CSS px) within which the transcript is
// still considered "stuck". Generous so the executing strip wrapping
// to two lines, two stacked approval cards, or a few px of touchpad
// noise can't accidentally disengage follow.
const STICK_THRESHOLD_PX = 120;

// How long after the operator's last scroll-related input we treat
// them as "actively scrolling". Within this window, scroll events
// recompute stickiness from real geometry (so they can drag the
// transcript away from the bottom or back to it), and auto-snap
// pauses (so we don't fight the user's wheel mid-gesture). 300 ms
// covers a typical wheel/touch gesture's tail without feeling laggy.
const USER_INTENT_WINDOW_MS = 300;

// Keys whose default action moves scrollTop. Other keys (typing in an
// input, modifier keys) shouldn't be treated as scroll intent — they
// don't move the viewport, and treating them as intent would let
// keystrokes in unrelated inputs accidentally disengage sticky.
const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

// Stick-to-bottom hook with intent-based engagement.
//
// Sticky engages/disengages ONLY in response to operator scroll
// intent (wheel / touch / arrow keys / scrollbar drag). Programmatic
// scrolls — our own snap-to-bottom, scrollIntoView from the markdown
// renderer, focus-driven scrolls — never toggle sticky off, no matter
// how the geometry happens to land at the moment of the resulting
// `scroll` event. This is the fix for the "stops following on the
// 3rd tool call" symptom: rapid streaming + late virtualizer
// measurements make the geometry briefly read "above threshold" at
// times when the user hasn't actually scrolled, and the previous
// pixel-only check would flip sticky off.
//
// Auto-follow on content growth uses a ResizeObserver on the scroll
// element's children. The observer pauses while user intent is fresh
// so we don't fight the operator's wheel mid-gesture; once their
// gesture's tail expires, the next size change re-pins.
//
// `snapToBottom()` forces an immediate jump and re-engages sticky.
// Used for chat switch and the "Jump to latest" pill.
export function useStickToBottom() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stuckRef = useRef(true);
  const [stuck, setStuck] = useState(true);
  // Monotonic timestamp marking the end of the current user-intent
  // window. `performance.now() < intentExpiresAt` ⇒ operator is
  // (probably) actively scrolling.
  const intentExpiresAtRef = useRef(0);

  const setStuckBoth = useCallback((next: boolean) => {
    if (stuckRef.current === next) return;
    stuckRef.current = next;
    setStuck(next);
  }, []);

  const refreshIntent = useCallback(() => {
    intentExpiresAtRef.current = performance.now() + USER_INTENT_WINDOW_MS;
  }, []);

  const isUserActive = useCallback(
    () => performance.now() < intentExpiresAtRef.current,
    [],
  );

  const snapToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setStuckBoth(true);
  }, [setStuckBoth]);

  // Wire up user-intent listeners. `wheel`, `touchstart`, `touchmove`
  // cover trackpad / touchscreen scrolling. `mousedown` covers
  // scrollbar drag. `keydown` is filtered to nav keys so typing in
  // child inputs doesn't trip intent.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) refreshIntent();
    };
    el.addEventListener("wheel", refreshIntent, { passive: true });
    el.addEventListener("touchstart", refreshIntent, { passive: true });
    el.addEventListener("touchmove", refreshIntent, { passive: true });
    el.addEventListener("mousedown", refreshIntent);
    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("wheel", refreshIntent);
      el.removeEventListener("touchstart", refreshIntent);
      el.removeEventListener("touchmove", refreshIntent);
      el.removeEventListener("mousedown", refreshIntent);
      el.removeEventListener("keydown", onKeyDown);
    };
  }, [refreshIntent]);

  // Scroll handler: only acts when intent is fresh. Programmatic
  // scrolls (our snaps, focus-driven scrolls) fire `scroll` too but
  // are ignored here — we never let geometry alone decide stickiness.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (!isUserActive()) return;
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      setStuckBoth(dist < STICK_THRESHOLD_PX);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [isUserActive, setStuckBoth]);

  // Auto-follow on content growth. Pauses while the operator is
  // actively scrolling — re-pinning under their wheel mid-gesture
  // would feel like the page is fighting them. After their gesture's
  // tail expires, the next resize triggers the re-pin.
  //
  // Two follow-up snaps are scheduled after each main snap:
  //   1. requestAnimationFrame — catches `measureElement` firings
  //      that land *after* the current RO callback (virtualizer
  //      measures a newly-rendered row, totalSize grows, wrapper
  //      resizes, but our RO has already returned for this batch).
  //   2. A second rAF after that — covers markdown / syntax
  //      highlighter resolving on a later frame and growing a
  //      bubble's height.
  // Both are cheap no-ops when nothing changed, and both bail the
  // moment the user disengages sticky or starts scrolling.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const snapIfStuck = () => {
      if (!stuckRef.current) return;
      if (isUserActive()) return;
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (dist > 0) el.scrollTop = el.scrollHeight;
    };
    const ro = new ResizeObserver(() => {
      snapIfStuck();
      requestAnimationFrame(() => {
        snapIfStuck();
        requestAnimationFrame(snapIfStuck);
      });
    });
    const observeAll = () => {
      ro.disconnect();
      // Observe the scroll element too — catches viewport resizes
      // (window resize, dock collapse) that change clientHeight and
      // therefore the bottom-distance, even when no children resized.
      ro.observe(el);
      for (const child of Array.from(el.children)) ro.observe(child);
    };
    observeAll();
    const mo = new MutationObserver(observeAll);
    mo.observe(el, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [isUserActive]);

  return { scrollRef, stuck, snapToBottom };
}
