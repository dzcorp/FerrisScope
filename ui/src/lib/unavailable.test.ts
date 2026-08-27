import { describe, it, expect } from "vitest";
import { isClusterUnavailableError } from "./unavailable";

describe("isClusterUnavailableError", () => {
  it("matches the backend refusal verbatim", () => {
    expect(
      isClusterUnavailableError(
        "cluster default::gke_prod-1 is unavailable — reconnect first",
      ),
    ).toBe(true);
  });

  it("matches when Tauri has wrapped it in an Error", () => {
    expect(
      isClusterUnavailableError(
        new Error("cluster kind-kind is unavailable — reconnect first"),
      ),
    ).toBe(true);
  });

  it("is insensitive to the dash style and case", () => {
    expect(
      isClusterUnavailableError("Cluster x IS UNAVAILABLE - RECONNECT FIRST"),
    ).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(isClusterUnavailableError("unknown kind: widgets")).toBe(false);
    expect(
      isClusterUnavailableError('pods is forbidden: User "x" cannot list'),
    ).toBe(false);
    // "unavailable" alone is a common apiserver word (503, metrics-server) —
    // only the paired refusal means the entry gate is closed.
    expect(
      isClusterUnavailableError("the server is currently unavailable"),
    ).toBe(false);
    expect(isClusterUnavailableError(null)).toBe(false);
    expect(isClusterUnavailableError(undefined)).toBe(false);
  });
});
