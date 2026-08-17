import { describe, it, expect } from "vitest";
import { isPermanentConnectFailure } from "./connectFailure";

// The message shape that actually reaches the frontend: connect_context wraps
// the kube error, which Debug-prints the whole Status struct.
const RBAC_403 =
  'apiserver liveness probe failed: ApiError: namespaces is forbidden: User "ops@example.net" ' +
  'cannot list resource "namespaces" in API group "" at the cluster scope: Forbidden ' +
  '(Status { status: Some(Failure), code: 403, reason: "Forbidden" })';

describe("isPermanentConnectFailure", () => {
  it("treats an RBAC 403 as permanent", () => {
    // The whole point: retrying this with the same credentials produces the
    // same answer, so auto-reconnect must not spend its budget on it.
    expect(isPermanentConnectFailure(RBAC_403)).toBe(true);
    expect(isPermanentConnectFailure("403 Forbidden")).toBe(true);
  });

  it("treats transient failures as retryable", () => {
    for (const msg of [
      "apiserver did not respond within 8s — cluster may be unreachable",
      "timed out after 15s",
      "error trying to connect: tcp connect error: Connection refused",
      "probe timed out after 4s",
      "hyper::Error(IncompleteMessage)",
    ]) {
      expect(isPermanentConnectFailure(msg), msg).toBe(false);
    }
  });

  it("does not treat a 401 as permanent", () => {
    // A reconnect rebuilds Config and re-runs the exec credential plugin, so an
    // expired token genuinely can heal on retry. Stranding it on a manual
    // banner would be the worse error.
    expect(
      isPermanentConnectFailure('ApiError: Unauthorized (Status { code: 401 })'),
    ).toBe(false);
  });

  it("does not match a digit run that merely contains 403", () => {
    // The realistic false positive: a port. Matching it would strand a genuinely
    // transient failure on the manual banner instead of retrying.
    for (const msg of [
      "error trying to connect: tcp connect error: 127.0.0.1:8403: Connection refused",
      "apiserver did not respond: dial tcp 10.40.3.7:6443: i/o timeout",
      "port 40300 unreachable",
    ]) {
      expect(isPermanentConnectFailure(msg), msg).toBe(false);
    }
  });

  it("does not mistake a 422 field-immutability error for an RBAC denial", () => {
    // Kubernetes embeds "Forbidden:" inside 422 validation messages. Matching
    // that as an authorization failure would suppress retries for something
    // that isn't an auth problem at all.
    expect(
      isPermanentConnectFailure(
        'Pod "x" is invalid: spec: Forbidden: pod updates may not change fields other than image',
      ),
    ).toBe(false);
    expect(
      isPermanentConnectFailure("spec.selector: Forbidden: field is immutable"),
    ).toBe(false);
  });
  it("treats a lapsed cloud session as permanent", () => {
    // Retrying cannot renew a session — only an interactive login can — and the
    // retry banner hides the note that says so.
    for (const msg of [
      "cloud session expired for a@example.com — run `gcloud auth login --account=a@example.com` in a terminal",
      "ERROR: (gcloud.config.config-helper) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.",
    ]) {
      expect(isPermanentConnectFailure(msg), msg).toBe(true);
    }
  });

  it("still retries a plain expired token", () => {
    // A 401 heals on reconnect: `Config` is rebuilt and the credential plugin
    // re-runs. Only the reauth wording above is terminal.
    for (const msg of [
      "Unauthorized (401)",
      "the server has asked for the client to provide credentials",
    ]) {
      expect(isPermanentConnectFailure(msg), msg).toBe(false);
    }
  });
});
