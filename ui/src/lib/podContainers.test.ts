// Reading a pod row's containers off the watcher projection. The row arrives as
// loose JSON from the backend, so the interesting cases are all about shape
// drift and about the init/sidecar/main split that decides which surfaces may
// offer which container.

import { describe, it, expect } from "vitest";
import {
  containerKindSuffix,
  containerLabel,
  defaultLogContainer,
  execContainers,
  orderContainers,
  rowLogContainers,
} from "./podContainers";
import type { LogContainer } from "../types";

const c = (name: string, kind: LogContainer["kind"]): LogContainer => ({
  name,
  kind,
});

describe("rowLogContainers", () => {
  it("reads name + kind off container_states", () => {
    expect(
      rowLogContainers({
        container_states: [
          { name: "migrate", kind: "init", state: "Terminated" },
          { name: "logship", kind: "sidecar", state: "Running" },
          { name: "app", kind: "main", state: "Running" },
        ],
      }),
    ).toEqual([c("migrate", "init"), c("logship", "sidecar"), c("app", "main")]);
  });

  it("returns an empty list when the field is missing or not an array", () => {
    // A pod row whose spec hasn't landed yet, and a projection that drifted.
    expect(rowLogContainers({})).toEqual([]);
    expect(rowLogContainers({ container_states: null })).toEqual([]);
    expect(rowLogContainers({ container_states: "app" })).toEqual([]);
  });

  it("drops entries with no usable name and tolerates junk", () => {
    expect(
      rowLogContainers({
        container_states: [
          null,
          "app",
          { kind: "main" },
          { name: "", kind: "main" },
          { name: "real", kind: "main" },
        ],
      }),
    ).toEqual([c("real", "main")]);
  });

  it("degrades an unrecognised kind to main rather than dropping it", () => {
    // A future container class should still stream, just without a badge.
    expect(
      rowLogContainers({
        container_states: [{ name: "app", kind: "something-new" }],
      }),
    ).toEqual([c("app", "main")]);
  });
});

describe("orderContainers", () => {
  it("sorts main → sidecar → init, keeping manifest order within a rank", () => {
    const input = [
      c("migrate", "init"),
      c("logship", "sidecar"),
      c("app", "main"),
      c("seed", "init"),
      c("envoy", "main"),
    ];
    expect(orderContainers(input)).toEqual([
      c("app", "main"),
      c("envoy", "main"),
      c("logship", "sidecar"),
      c("migrate", "init"),
      c("seed", "init"),
    ]);
  });

  it("does not mutate its input", () => {
    const input = [c("migrate", "init"), c("app", "main")];
    const copy = [...input];
    orderContainers(input);
    expect(input).toEqual(copy);
  });
});

describe("defaultLogContainer", () => {
  it("opens on the app container even when an init container is declared first", () => {
    // The regression this whole change exists for: with init containers now in
    // the list, naive `containers[0]` would open on a terminated container.
    expect(
      defaultLogContainer([c("migrate", "init"), c("app", "main")]),
    ).toBe("app");
  });

  it("falls back to a sidecar, then an init container, then null", () => {
    expect(
      defaultLogContainer([c("migrate", "init"), c("logship", "sidecar")]),
    ).toBe("logship");
    expect(defaultLogContainer([c("migrate", "init")])).toBe("migrate");
    expect(defaultLogContainer([])).toBeNull();
  });
});

describe("execContainers", () => {
  it("keeps main and sidecar, drops init", () => {
    // `kubectl exec` into a terminated init container always fails, so the
    // shell affordances must not offer one.
    expect(
      execContainers([
        c("migrate", "init"),
        c("logship", "sidecar"),
        c("app", "main"),
      ]),
    ).toEqual([c("app", "main"), c("logship", "sidecar")]);
  });

  it("returns empty for an init-only pod", () => {
    expect(execContainers([c("migrate", "init")])).toEqual([]);
  });
});

describe("labels", () => {
  it("leaves main unadorned and badges the rest", () => {
    expect(containerKindSuffix("main")).toBe("");
    expect(containerLabel(c("app", "main"))).toBe("app");
    expect(containerLabel(c("logship", "sidecar"))).toBe("logship (sidecar)");
    expect(containerLabel(c("migrate", "init"))).toBe("migrate (init)");
  });
});
