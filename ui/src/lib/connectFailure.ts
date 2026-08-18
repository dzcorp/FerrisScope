// Is a connect failure worth retrying?
//
// Auto-reconnect exists for *wedged* clusters: a stalled HTTP/2 pool, a dead
// apiserver, a flapping LB. Those recover, and the backend documents a rebuilt
// client as the only clean path out (crates/core/src/health.rs). Retrying is
// the right reflex there.
//
// It is the wrong reflex for an authorization failure. An RBAC 403 is
// deterministic: the same credentials produce the same 403 on attempt 10 as on
// attempt 1. Retrying burns the whole backoff budget (~4 minutes) and — worse —
// holds the UI on the busy "Reconnecting…" banner, which carries neither the
// Diagnose button nor the cloud-identity note that would tell the operator
// their kubeconfig context is authenticating as the wrong account. The one
// screen that explains the failure is the one the retry loop hides.

/// Does this connect failure mean "retrying is unlikely to change anything"?
///
/// Deliberately narrow — only RBAC 403s. In particular a **401 is not**
/// included: a reconnect rebuilds `Config` and re-runs the exec credential
/// plugin, so an expired token genuinely can heal on retry.
///
/// "Permanent" is a judgement about the *common* case, not a guarantee. Some
/// 403s do heal on their own: a freshly granted GCP IAM binding can take
/// minutes to propagate, an authorization webhook that is down returns 403
/// until it recovers, and a corporate proxy serves an HTML 403 when the VPN
/// drops. Those get one attempt instead of ten. That is the deliberate trade:
/// the terminal banner carries a live Reconnect button and the cloud-identity
/// note, so a false "permanent" costs one click, while a false "transient"
/// costs four minutes behind a spinner that explains nothing.
export function isPermanentConnectFailure(message: string): boolean {
  const m = message.toLowerCase();
  // A lapsed cloud session is as deterministic as a 403, and for the same
  // reason: nothing about a retry changes it. The credential plugin refuses to
  // mint a token until the operator completes an identity challenge in a
  // terminal, so ten attempts produce ten identical failures — while hiding the
  // one note that names the account and the command to run.
  if (
    m.includes("cloud session expired") ||
    m.includes("reauthentication failed") ||
    m.includes("cannot prompt during non-interactive")
  ) {
    return true;
  }
  // The OS refusing to execute the credential plugin's helper (macOS TCC on a
  // Downloads install, or a quarantine xattr) is equally deterministic: it
  // heals only when the operator grants access or moves the SDK, and the
  // banner under this flag is the one carrying those remedies. Not the phrase
  // alone — "operation not permitted" is any EPERM (a macOS firewall refusing
  // an outbound connect says the same words, and that one heals on retry), so
  // require a marker tying it to the exec plugin. Both backend renderings
  // (`ExecPluginBlocked`, `ExecPluginFailed`) carry "credential plugin"; the
  // raw plugin stderr carries its own wrapper. Kept in step with
  // `cloud_identity::gcloud::classify_exec_failure`.
  if (
    m.includes("operation not permitted") &&
    (m.includes("credential plugin") ||
      m.includes("while executing") ||
      m.includes("cred.go") ||
      m.includes("/bin/sh:") ||
      m.includes("exit status 126"))
  ) {
    return true;
  }
  // Kubernetes embeds "Forbidden:" *inside* HTTP 422 validation messages to
  // mean "this field can't be changed". That is not an authorization failure
  // and must be excluded first — the same ordering guard `classifyDetailError`
  // (components/ui/atoms.tsx) and `cloud_identity::is_forbidden` both apply.
  //
  // The 422 test needs the same word boundaries as the 403 test below, and for
  // a sharper reason: a 403 message is *full* of long digit runs that can
  // contain "422" by chance — a 12-digit AWS account id in an assumed-role ARN,
  // a 21-digit GCP service-account id, a resourceVersion. A bare
  // `includes("422")` on any of those silently misfiles a real RBAC denial as
  // retryable, which disables both halves of this feature for that operator
  // permanently and invisibly.
  if (
    m.includes("is invalid") ||
    /\b422\b/.test(m) ||
    m.includes("may not change") ||
    m.includes("immutable")
  ) {
    return false;
  }
  // Word boundaries, not bare substrings. `includes("403")` matches the port in
  // "connection refused (127.0.0.1:8403)" — a transient failure that would then
  // be stranded on a manual banner instead of retrying.
  return /\bforbidden\b/.test(m) || /\b403\b/.test(m);
}
