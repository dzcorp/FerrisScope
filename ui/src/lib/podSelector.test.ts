import { describe, expect, it } from "vitest";
import {
  acceptsPodDelta,
  matchesLabelSelector,
  selectorIsClientEvaluable,
} from "./podSelector";
import type { LabelSelectorSummary, ResourceRow } from "../types";

function sel(
  match_labels: [string, string][],
  match_expressions = 0,
): LabelSelectorSummary {
  return { match_labels, match_expressions };
}

function row(
  uid: string,
  labels?: Record<string, string>,
  namespace = "production",
): ResourceRow {
  return { uid, name: uid, namespace, __labels: labels };
}

describe("matchesLabelSelector", () => {
  it("matches when every selector pair is present and equal", () => {
    expect(
      matchesLabelSelector({ app: "web", tier: "fe" }, sel([["app", "web"]])),
    ).toBe(true);
  });

  it("requires ALL pairs, not just one", () => {
    expect(
      matchesLabelSelector(
        { app: "web" },
        sel([
          ["app", "web"],
          ["tier", "fe"],
        ]),
      ),
    ).toBe(false);
  });

  it("rejects a value mismatch", () => {
    expect(matchesLabelSelector({ app: "api" }, sel([["app", "web"]]))).toBe(
      false,
    );
  });

  it("rejects an unlabelled pod", () => {
    expect(matchesLabelSelector(undefined, sel([["app", "web"]]))).toBe(false);
  });

  // An empty selector matching everything would show the operator a whole
  // namespace of pods under one workload — worse than showing none.
  it("matches nothing for an empty or absent selector", () => {
    expect(matchesLabelSelector({ app: "web" }, sel([]))).toBe(false);
    expect(matchesLabelSelector({ app: "web" }, null)).toBe(false);
  });
});

describe("selectorIsClientEvaluable", () => {
  it("is false once matchExpressions are involved", () => {
    expect(selectorIsClientEvaluable(sel([["app", "web"]], 1))).toBe(false);
    expect(selectorIsClientEvaluable(sel([["app", "web"]]))).toBe(true);
    expect(selectorIsClientEvaluable(null)).toBe(false);
  });
});

describe("acceptsPodDelta", () => {
  const s = sel([["app", "web"]]);
  const none: ReadonlySet<string> = new Set();

  it("admits a new pod that matches a plain matchLabels selector", () => {
    expect(acceptsPodDelta(row("p1", { app: "web" }), "production", s, none)).toBe(true);
  });

  it("rejects a new pod that does not match", () => {
    expect(acceptsPodDelta(row("p1", { app: "api" }), "production", s, none)).toBe(false);
  });

  it("drops a known pod once its labels stop matching", () => {
    const known = new Set(["p1"]);
    expect(acceptsPodDelta(row("p1", { app: "api" }), "production", s, known)).toBe(false);
  });

  // The delta stream is cluster-wide while the server-side list is namespaced,
  // so labels alone would pull in `app=web` from staging while the operator is
  // looking at production — and workload panels hide the namespace column, so
  // it would be invisible.
  describe("namespace scoping", () => {
    it("rejects a same-labelled pod from another namespace", () => {
      expect(
        acceptsPodDelta(row("p1", { app: "web" }, "staging"), "production", s, none),
      ).toBe(false);
    });

    it("rejects it even when the uid is already known", () => {
      const known = new Set(["p1"]);
      expect(
        acceptsPodDelta(row("p1", { app: "web" }, "staging"), "production", s, known),
      ).toBe(false);
    });

    // The Node panel matches on node, not namespace — its pods legitimately
    // span every namespace, so it opts out by passing null.
    it("skips the check when the caller passes null", () => {
      expect(
        acceptsPodDelta(row("p1", { app: "web" }, "staging"), null, s, none),
      ).toBe(true);
    });
  });

  // With matchExpressions we cannot evaluate the selector, so the
  // server-fetched list stays authoritative: updates to pods it vouched for
  // are kept, but no unknown pod is admitted on matchLabels alone.
  describe("with matchExpressions present", () => {
    const expr = sel([["app", "web"]], 1);

    it("keeps updating pods the server already vouched for", () => {
      const known = new Set(["p1"]);
      expect(acceptsPodDelta(row("p1", { app: "web" }), "production", expr, known)).toBe(
        true,
      );
    });

    it("refuses to admit an unknown pod", () => {
      expect(acceptsPodDelta(row("p2", { app: "web" }), "production", expr, none)).toBe(
        false,
      );
    });
  });
});
