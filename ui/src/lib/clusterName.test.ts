import { describe, expect, it } from "vitest";
import {
  clusterLabels,
  labelFor,
  parseContextName,
  type LabelSource,
} from "./clusterName";

// Every fixture below is a real-world shape taken from the provider's own
// documentation, not an invented one — the parser is only worth anything if
// it matches what the CLIs actually write.

const ctx = (
  name: string,
  user: string | null = null,
  id = `default::${name}`,
): LabelSource => ({ id, name, user });

describe("parseContextName — recognised schemes", () => {
  it("splits a GKE context into cluster + project + location", () => {
    const p = parseContextName(
      "gke_production-4f83b34d_us-central1_prod-6",
      null,
    );
    expect(p).toEqual({
      provider: "gke",
      short: "prod-6",
      qualifiers: ["production-4f83b34d", "us-central1"],
    });
  });

  it("keeps hyphenated GKE cluster names whole", () => {
    expect(
      parseContextName(
        "gke_tld-production-d087a553_us-central1_gke-prod-hardworking-goose",
        null,
      ).short,
    ).toBe("gke-prod-hardworking-goose");
  });

  it("splits an EKS cluster ARN into cluster + account + region", () => {
    expect(
      parseContextName(
        "arn:aws:eks:us-east-2:111122223333:cluster/my-eks-cluster",
        null,
      ),
    ).toEqual({
      provider: "eks",
      short: "my-eks-cluster",
      qualifiers: ["111122223333", "us-east-2"],
    });
  });

  it.each([
    ["arn:aws-cn:eks:cn-north-1:111122223333:cluster/prod", "cn-north-1"],
    [
      "arn:aws-us-gov:eks:us-gov-west-1:111122223333:cluster/prod",
      "us-gov-west-1",
    ],
  ])("handles the %s partition", (arn, region) => {
    const p = parseContextName(arn, null);
    expect(p.provider).toBe("eks");
    expect(p.short).toBe("prod");
    expect(p.qualifiers).toEqual(["111122223333", region]);
  });

  it("splits an eksctl context into cluster + region + identity", () => {
    expect(
      parseContextName("admin@my-cluster.eu-north-1.eksctl.io", null),
    ).toEqual({
      provider: "eksctl",
      short: "my-cluster",
      qualifiers: ["eu-north-1", "admin"],
    });
  });

  it("handles the eksctl root-account identity", () => {
    const p = parseContextName(
      "iam-root-account@sigridjin-ekscluster-240413-3.ap-northeast-2.eksctl.io",
      null,
    );
    expect(p.short).toBe("sigridjin-ekscluster-240413-3");
    expect(p.qualifiers).toEqual(["ap-northeast-2", "iam-root-account"]);
  });

  it("parses an eksctl name with no identity prefix", () => {
    expect(parseContextName("my-cluster.eu-north-1.eksctl.io", null)).toEqual({
      provider: "eksctl",
      short: "my-cluster",
      qualifiers: ["eu-north-1"],
    });
  });

  it("reduces an oc login context to the api host", () => {
    expect(
      parseContextName("default/api-ocp-example-com:6443/kubeadmin", null),
    ).toEqual({
      provider: "openshift",
      short: "ocp-example-com",
      qualifiers: ["default", "kubeadmin"],
    });
  });

  it("drops the empty namespace segment of an oc context", () => {
    expect(
      parseContextName("/api-ocp-example-com:6443/kubeadmin", null).qualifiers,
    ).toEqual(["kubeadmin"]);
  });

  it("recovers the AKS resource group from the user entry", () => {
    expect(
      parseContextName("myAKSCluster", "clusterUser_myResourceGroup_myAKSCluster"),
    ).toEqual({
      provider: "aks",
      short: "myAKSCluster",
      qualifiers: ["myResourceGroup"],
    });
  });

  it("recovers a resource group that itself contains underscores", () => {
    // `az` joins on `_` but Azure allows `_` inside a resource-group name, so
    // the group can only be recovered by anchoring on the cluster name.
    expect(
      parseContextName("aks01", "clusterUser_my_rg_01_aks01").qualifiers,
    ).toEqual(["my_rg_01"]);
  });

  it("recovers the region from a DigitalOcean context", () => {
    expect(parseContextName("do-ams3-k8swim", null)).toEqual({
      provider: "digitalocean",
      short: "do-ams3-k8swim",
      qualifiers: ["ams3"],
    });
  });
});

describe("parseContextName — never shortens what it can't prove", () => {
  it.each([
    "",
    "minikube",
    "kind-ruw-e2e",
    "k3d-dev",
    "rancher-desktop",
    // GKE-ish but wrong arity / empty segments.
    "gke_",
    "gke_a_b",
    "gke_a_b_c_d",
    "gke__us-central1_prod",
    "gke_project_us-central1_",
    // ARN-ish but truncated.
    "arn:aws:eks:us-east-1",
    "arn:aws:eks:us-east-1:111122223333:cluster/",
    "arn:aws:ec2:us-east-1:111122223333:instance/i-abc",
    // eksctl-ish but missing a component.
    ".eksctl.io",
    "cluster.eksctl.io",
    "my-cluster.eksctl.io",
    // oc-ish but the middle segment isn't host:port.
    "a/b/c",
    "default/api-ocp-example-com/kubeadmin",
  ])("leaves %o byte-identical", (name) => {
    const p = parseContextName(name, null);
    expect(p.short).toBe(name);
    expect(p.qualifiers).toEqual([]);
  });

  it("never strips the AKS -admin suffix", () => {
    // `foo` and `foo-admin` are different credentials that coexist in one
    // kubeconfig; collapsing them would hide which one is connecting.
    const p = parseContextName(
      "myAKSCluster-admin",
      "clusterAdmin_myResourceGroup_myAKSCluster",
    );
    expect(p.short).toBe("myAKSCluster-admin");
    expect(p.qualifiers).toEqual(["myResourceGroup"]);
  });

  it("ignores a user entry that isn't AKS-shaped", () => {
    expect(parseContextName("prod", "clusterUser_rg_other").provider).toBe(
      "unknown",
    );
    expect(parseContextName("prod", "some-oidc-user").provider).toBe("unknown");
  });

  it("ignores a do- prefix that isn't followed by a region token", () => {
    expect(parseContextName("do-not-shorten-me", null).provider).toBe(
      "unknown",
    );
  });
});

describe("clusterLabels", () => {
  const FLEET: LabelSource[] = [
    ctx("gke_development-d83ab4a8_europe-west4_truenv-03"),
    ctx("gke_production-4f83b34d_us-central1_prod-6"),
    ctx("gke_production-4f83b34d_us-central1_prod-7"),
    ctx("gke_production-4f83b34d_us-central1_analytics-2"),
    ctx("kind-ruw-e2e"),
  ];

  it("shortens recognised names and leaves the rest alone", () => {
    const labels = clusterLabels(FLEET, true);
    expect(
      labels["default::gke_production-4f83b34d_us-central1_prod-6"]!.short,
    ).toBe("prod-6");
    expect(labels["default::kind-ruw-e2e"]!.short).toBe("kind-ruw-e2e");
    expect(labels["default::kind-ruw-e2e"]!.qualifier).toBeNull();
  });

  it("keeps the full name available for tooltips and search", () => {
    const labels = clusterLabels(FLEET, true);
    expect(
      labels["default::gke_production-4f83b34d_us-central1_prod-6"]!.full,
    ).toBe("gke_production-4f83b34d_us-central1_prod-6");
  });

  it("exposes the stripped coordinate as qualifier + group", () => {
    const l = clusterLabels(FLEET, true)[
      "default::gke_production-4f83b34d_us-central1_prod-6"
    ]!;
    expect(l.qualifier).toBe("production-4f83b34d · us-central1");
    expect(l.groupLabel).toBe("production-4f83b34d · us-central1");
    expect(l.groupKey).toBe("gke|production-4f83b34d|us-central1");
  });

  it("gives contexts from one project the same groupKey and others a different one", () => {
    const labels = clusterLabels(FLEET, true);
    const prod6 =
      labels["default::gke_production-4f83b34d_us-central1_prod-6"]!.groupKey;
    const prod7 =
      labels["default::gke_production-4f83b34d_us-central1_prod-7"]!.groupKey;
    const dev =
      labels["default::gke_development-d83ab4a8_europe-west4_truenv-03"]!
        .groupKey;
    expect(prod6).toBe(prod7);
    expect(dev).not.toBe(prod6);
    expect(labels["default::kind-ruw-e2e"]!.groupKey).toBeNull();
  });

  it("leaves display fields untouched when disabled", () => {
    const labels = clusterLabels(FLEET, false);
    for (const c of FLEET) {
      expect(labels[c.id]!.full).toBe(c.name);
      expect(labels[c.id]!.short).toBe(c.name);
      expect(labels[c.id]!.qualifier).toBeNull();
    }
  });

  it("still resolves grouping keys when shortening is disabled", () => {
    // The two settings are independent: the fleet must be able to bucket by
    // project while rendering full names.
    const labels = clusterLabels(FLEET, false);
    expect(
      labels["default::gke_production-4f83b34d_us-central1_prod-6"]!.groupKey,
    ).toBe("gke|production-4f83b34d|us-central1");
    expect(
      labels["default::gke_production-4f83b34d_us-central1_prod-6"]!.groupKey,
    ).toBe(
      labels["default::gke_production-4f83b34d_us-central1_prod-7"]!.groupKey,
    );
    expect(labels["default::kind-ruw-e2e"]!.groupKey).toBeNull();
  });

  it("re-resolves when the enabled flag flips on the same array", () => {
    const on = clusterLabels(FLEET, true);
    const off = clusterLabels(FLEET, false);
    expect(on["default::kind-ruw-e2e"]!.short).toBe("kind-ruw-e2e");
    expect(
      off["default::gke_production-4f83b34d_us-central1_prod-6"]!.short,
    ).toBe("gke_production-4f83b34d_us-central1_prod-6");
  });

  it("reverts both sides of an ambiguous pair to their full names", () => {
    // Same cluster segment, same project, different provider path: the
    // shortened pair would be indistinguishable, so neither is shortened.
    const fleet: LabelSource[] = [
      ctx("gke_shared_us-central1_prod", null, "a"),
      ctx("gke_shared_us-central1_prod", null, "b"),
    ];
    const labels = clusterLabels(fleet, true);
    expect(labels["a"]!.short).toBe("gke_shared_us-central1_prod");
    expect(labels["b"]!.short).toBe("gke_shared_us-central1_prod");
    expect(labels["a"]!.qualifier).toBeNull();
    // Grouping is unaffected — they really are in the same project.
    expect(labels["a"]!.groupKey).toBe("gke|shared|us-central1");
  });

  it("keeps same-named clusters in different projects distinguishable", () => {
    const fleet: LabelSource[] = [
      ctx("gke_paylnx-production-3s33s33s_us-central1_prod-1", null, "a"),
      ctx("gke_tld-production-d087a553_us-central1_prod-1", null, "b"),
    ];
    const labels = clusterLabels(fleet, true);
    expect(labels["a"]!.short).toBe("prod-1");
    expect(labels["b"]!.short).toBe("prod-1");
    expect(labels["a"]!.qualifier).not.toBe(labels["b"]!.qualifier);
  });

  it("renders a unique short+qualifier pair for every context in a mixed fleet", () => {
    const fleet: LabelSource[] = [
      ...FLEET,
      ctx("arn:aws:eks:us-east-2:111122223333:cluster/prod-6", null, "eks"),
      ctx("admin@prod-6.eu-north-1.eksctl.io", null, "eksctl"),
      ctx("prod-6", "clusterUser_rg-a_prod-6", "aks-a"),
      ctx("prod-6", "clusterUser_rg-b_prod-6", "aks-b"),
      ctx("do-ams3-prod-6", null, "do"),
    ];
    const labels = clusterLabels(fleet, true);
    const rendered = fleet.map((c) => {
      const l = labels[c.id]!;
      return l.qualifier ? `${l.short} · ${l.qualifier}` : l.short;
    });
    expect(new Set(rendered).size).toBe(fleet.length);
  });
});

describe("labelFor", () => {
  it("returns the resolved label when the context exists", () => {
    const labels = clusterLabels(
      [ctx("gke_proj_us-central1_prod", null, "x")],
      true,
    );
    expect(labelFor(labels, "x").short).toBe("prod");
  });

  it("falls back to the supplied name for a context missing from kubeconfig", () => {
    expect(labelFor({}, "default::gone", "gone").short).toBe("gone");
  });

  it("falls back to the id when there is no name either", () => {
    expect(labelFor({}, "default::gone").short).toBe("default::gone");
  });
});
