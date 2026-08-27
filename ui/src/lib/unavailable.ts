// Recognises the backend's "this cluster is wedged" refusal so the UI can
// flip the cluster into its unavailable state from a *command error* alone.
//
// Why it matters: `cluster-health://` is emitted exactly once per wedge and
// is lost on any client not listening at that instant. The subscribe error
// is the one signal that arrives on demand, every time — treating it as a
// health transition is what guarantees a Reconnect affordance instead of a
// bare "Failed to load".
//
// Source of truth: `crates/app/src/commands.rs` —
// `format!("cluster {cluster_id} is unavailable — reconnect first")`.
// Matched loosely (em dash and the cluster id are not part of the test) so a
// reworded backend message doesn't silently drop the banner.
const UNAVAILABLE_RE = /\bis unavailable\b[\s\S]*\breconnect first\b/i;

export function isClusterUnavailableError(err: unknown): boolean {
  if (err == null) return false;
  return UNAVAILABLE_RE.test(typeof err === "string" ? err : String(err));
}
