import { describe, expect, it } from "vitest";
import type { ResourceKind } from "../types";
import { resourceKindLabel, resolveResourceKind } from "./resourceKinds";

const helm: ResourceKind = {
  id: "helm_releases",
  group: "",
  version: "v1",
  kind: "HelmRelease",
  plural: "secrets",
  namespaced: true,
  category: "Apps",
  columns: [],
};
const flux: ResourceKind = {
  ...helm,
  id: "wkcrd:flux_helmreleases|helm.toolkit.fluxcd.io|v2|helmreleases|HelmRelease|ns",
  group: "helm.toolkit.fluxcd.io",
  version: "v2",
  plural: "helmreleases",
};

describe("resource kind presentation and navigation", () => {
  it("distinguishes installed Helm releases from Flux intent", () => {
    expect(resourceKindLabel(helm)).toBe("HelmRelease");
    expect(resourceKindLabel(flux)).toBe("Flux HelmRelease");
    expect(
      resourceKindLabel({ kind: "Application", group: "argoproj.io" }),
    ).toBe("Argo CD Application");
    expect(resourceKindLabel({ kind: "Workflow", group: "argoproj.io" })).toBe(
      "Workflow",
    );
  });

  it("resolves group-qualified references without taking the first kind-name match", () => {
    const availability = { [flux.id]: ["a"] };
    expect(
      resolveResourceKind(
        [helm, flux],
        availability,
        "HelmRelease",
        "a",
        flux.group,
      ),
    ).toBe(flux);
    expect(
      resolveResourceKind([helm, flux], availability, "HelmRelease", "a", ""),
    ).toBe(helm);
    expect(
      resolveResourceKind([helm, flux], availability, "HelmRelease", "a"),
    ).toBeUndefined();
    expect(
      resolveResourceKind(
        [helm, flux],
        availability,
        "HelmRelease",
        "b",
        flux.group,
      ),
    ).toBeUndefined();
    expect(resolveResourceKind([helm], {}, "Missing", "a")).toBeUndefined();
  });

  it("chooses only the version served by the object's cluster", () => {
    const beta = {
      ...flux,
      id: "wkcrd:flux_helmreleases|helm.toolkit.fluxcd.io|v2beta2|helmreleases|HelmRelease|ns",
      version: "v2beta2",
    };
    const availability = { [flux.id]: ["a"], [beta.id]: ["b"] };
    expect(
      resolveResourceKind(
        [flux, beta],
        availability,
        "HelmRelease",
        "b",
        flux.group,
      ),
    ).toBe(beta);
    expect(
      resolveResourceKind(
        [flux, beta],
        { [flux.id]: ["a"], [beta.id]: ["a"] },
        "HelmRelease",
        "a",
        flux.group,
      ),
    ).toBeUndefined();
  });
});
