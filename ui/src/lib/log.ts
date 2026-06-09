// Error sinks for fire-and-forget promises. A bare `.catch(() => {})`
// makes failures invisible — broken prefs, dead listeners, and refused
// commands all look like "nothing happened". Route every intentional
// swallow through one of these so the failure is at least on the console
// (logErr), or also surfaced to the operator (reportErr) when silent
// failure would leave unexplained empty state.

import { toast } from "./dialog";

/** `.catch` sink that logs the failure under a stable scope tag. */
export function logErr(scope: string): (e: unknown) => void {
  return (e) => {
    // eslint-disable-next-line no-console
    console.warn(`[${scope}]`, e);
  };
}

/**
 * `.catch` sink that logs AND shows a warn toast. For data flows whose
 * silent failure strands the operator (prefs, saved views, restored
 * port-forwards): the headline says what's missing, the body carries
 * the raw error for the notifications panel.
 */
export function reportErr(
  scope: string,
  headline: string,
): (e: unknown) => void {
  return (e) => {
    // eslint-disable-next-line no-console
    console.warn(`[${scope}]`, e);
    toast.warn(`${headline}\n${String(e)}`);
  };
}
