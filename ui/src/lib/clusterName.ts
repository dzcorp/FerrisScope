// Shortening machine-generated kubeconfig context names. No React — every
// function here is pure and unit-testable, and the memoised entry point is
// shared by the fleet landing, the rail's open-cluster strip, the cluster
// tabs, the command palette and the chat's view context so one cluster reads
// the same everywhere.
//
// Managed-Kubernetes CLIs write context names that encode the whole cloud
// coordinate, not just the cluster. A GKE-heavy kubeconfig is a wall of
// near-identical 50-character strings where only the last token differs:
//
//   gke_production-4f83b34d_us-central1_prod-6
//   gke_production-4f83b34d_us-central1_analytics-2
//
// We strip the coordinate down to the cluster segment and keep what we
// stripped as `qualifiers` — surfaced next to the short name where there's
// room, and used as the fleet landing's sub-grouping key.
//
// The hard rule: a shape we don't recognise is returned BYTE-IDENTICAL. There
// is no heuristic fallback that trims "probably redundant" tokens, because a
// wrong guess here points the operator at the wrong cluster.

import type { ContextInfo } from "../types";

/// The naming scheme a context name was recognised as. `unknown` covers
/// kind / k3d / minikube / Rancher / hand-written contexts — all already
/// short — and anything whose shape drifted from what we parse.
export type ClusterProvider =
  | "gke"
  | "eks"
  | "eksctl"
  | "openshift"
  | "aks"
  | "digitalocean"
  | "unknown";

/// Result of parsing one context name in isolation. `short` equals the input
/// name whenever nothing could be safely stripped.
export type ParsedContext = {
  provider: ClusterProvider;
  short: string;
  /// What was stripped (or, for schemes whose names are already short, what
  /// we learned from elsewhere in the kubeconfig). Most specific first:
  /// project/account before location/region.
  qualifiers: string[];
};

/// A context's display strings, resolved against the whole fleet so the
/// rendered pair is unambiguous.
export type ClusterLabel = {
  /// The original context name. Authoritative — belongs in every tooltip and
  /// every search keyword string.
  full: string;
  /// What to render as the name.
  short: string;
  /// Dim suffix rendered next to `short` where there's horizontal room.
  /// `null` when there's nothing to add.
  qualifier: string | null;
  /// Stable bucket key for the fleet landing's project sub-grouping. `null`
  /// when the context has no qualifier to group by.
  groupKey: string | null;
  /// Human header for that bucket.
  groupLabel: string | null;
};

/// The subset of `ContextInfo` label resolution needs. Taking a structural
/// type (rather than `ContextInfo`) keeps the helper usable from tests and
/// from `clusterTabLabel`, which already threads a narrowed shape around.
export type LabelSource = Pick<ContextInfo, "id" | "name" | "user">;

const EKS_ARN = /^arn:aws[\w-]*:eks:([^:]+):([^:]+):cluster\/(.+)$/;
const EKSCTL_SUFFIX = ".eksctl.io";
const AKS_USER = /^cluster(?:Admin|User)_(.+)$/;
const AKS_ADMIN_SUFFIX = "-admin";
const OPENSHIFT_SERVER = /^[A-Za-z0-9.-]+:\d+$/;
// DigitalOcean regions are a short letter run plus a digit — nyc1, ams3,
// sfo2, blr1. Anchored so a cluster merely *named* `do-something` doesn't
// get mistaken for one.
const DO_PREFIX = /^do-([a-z]{2,5}\d+)-(.+)$/;

function unknown(name: string): ParsedContext {
  return { provider: "unknown", short: name, qualifiers: [] };
}

/// `aws eks update-kubeconfig` defaults both the context and the user name to
/// the cluster ARN. `aws[\w-]*` covers the `aws-cn` and `aws-us-gov`
/// partitions, whose ARNs are otherwise identically shaped.
function parseEksArn(name: string): ParsedContext | null {
  const m = EKS_ARN.exec(name);
  if (!m) return null;
  const [, region, account, cluster] = m;
  if (!region || !account || !cluster) return null;
  return { provider: "eks", short: cluster, qualifiers: [account, region] };
}

/// eksctl writes `<identity>@<cluster>.<region>.eksctl.io`. The identity is
/// the IAM principal that created the cluster (literally `iam-root-account`
/// when that was the account root user). EKS cluster names can't contain
/// dots, so the region is unambiguously the last dot-segment.
function parseEksctl(name: string): ParsedContext | null {
  if (!name.endsWith(EKSCTL_SUFFIX)) return null;
  const body = name.slice(0, -EKSCTL_SUFFIX.length);
  const at = body.indexOf("@");
  const identity = at > 0 ? body.slice(0, at) : null;
  const rest = at >= 0 ? body.slice(at + 1) : body;
  const dot = rest.lastIndexOf(".");
  if (dot <= 0 || dot === rest.length - 1) return null;
  const cluster = rest.slice(0, dot);
  const region = rest.slice(dot + 1);
  if (!cluster || !region) return null;
  return {
    provider: "eksctl",
    short: cluster,
    qualifiers: identity ? [region, identity] : [region],
  };
}

/// `gcloud container clusters get-credentials` writes
/// `gke_<project>_<location>_<cluster>`. None of the three GCP segments may
/// contain an underscore, so a 4-way split is exact rather than a guess.
function parseGke(name: string): ParsedContext | null {
  const parts = name.split("_");
  if (parts.length !== 4) return null;
  const [head, project, location, cluster] = parts;
  if (head !== "gke") return null;
  if (!project || !location || !cluster) return null;
  return { provider: "gke", short: cluster, qualifiers: [project, location] };
}

/// `oc login` writes `<namespace>/<host-with-dots-dashed>:<port>/<user>`.
/// The namespace segment is empty when no project is selected.
function parseOpenShift(name: string): ParsedContext | null {
  const seg = name.split("/");
  if (seg.length !== 3) return null;
  const namespace = seg[0] ?? "";
  const server = seg[1] ?? "";
  const user = seg[2] ?? "";
  if (!OPENSHIFT_SERVER.test(server)) return null;
  let host = server.replace(/:\d+$/, "");
  if (host.startsWith("api-")) host = host.slice(4);
  if (!host) return null;
  return {
    provider: "openshift",
    short: host,
    qualifiers: [namespace, user].filter((q) => q.length > 0),
  };
}

/// AKS context names are ALREADY the bare cluster name (`myAKSCluster`, or
/// `myAKSCluster-admin` for `--admin` credentials), so there is nothing to
/// shorten. What we recover is the resource group, which `az aks
/// get-credentials` puts only in the user entry — a long-standing gap that
/// makes same-named clusters in two resource groups indistinguishable.
///
/// `-admin` is deliberately NOT stripped: `foo` and `foo-admin` are different
/// credentials that legitimately coexist in one kubeconfig, and collapsing
/// them would hide which one is connecting.
///
/// Resource-group names may themselves contain underscores, so the group is
/// recovered by anchoring on the known cluster name at the end rather than by
/// splitting on `_`.
function parseAks(name: string, user: string | null): ParsedContext | null {
  if (!user) return null;
  const m = AKS_USER.exec(user);
  if (!m) return null;
  const rest = m[1] ?? "";
  const cluster = name.endsWith(AKS_ADMIN_SUFFIX)
    ? name.slice(0, -AKS_ADMIN_SUFFIX.length)
    : name;
  if (!cluster) return null;
  const suffix = `_${cluster}`;
  if (!rest.endsWith(suffix)) return null;
  const group = rest.slice(0, -suffix.length);
  if (!group) return null;
  return { provider: "aks", short: name, qualifiers: [group] };
}

/// `doctl kubernetes cluster kubeconfig save` writes
/// `do-<region>-<cluster>`. Already short enough to leave alone; we only
/// recover the region so the fleet can group by it.
function parseDigitalOcean(name: string): ParsedContext | null {
  const m = DO_PREFIX.exec(name);
  const region = m?.[1];
  if (!region) return null;
  return { provider: "digitalocean", short: name, qualifiers: [region] };
}

/// Parse one context name in isolation. `user` is the kubeconfig user entry
/// (`ContextInfo.user`) — only AKS needs it, but it's cheap to thread.
///
/// Order matters only in that each branch is anchored tightly enough not to
/// match another scheme's shape; the first match wins.
export function parseContextName(
  name: string,
  user: string | null,
): ParsedContext {
  if (!name) return unknown(name);
  return (
    parseEksArn(name) ??
    parseEksctl(name) ??
    parseGke(name) ??
    parseOpenShift(name) ??
    parseAks(name, user) ??
    parseDigitalOcean(name) ??
    unknown(name)
  );
}

function joinQualifiers(qualifiers: string[]): string | null {
  return qualifiers.length > 0 ? qualifiers.join(" · ") : null;
}

function computeLabels(
  contexts: readonly LabelSource[],
  enabled: boolean,
): Record<string, ClusterLabel> {
  const parsed = contexts.map((c) => ({
    c,
    p: parseContextName(c.name, c.user ?? null),
  }));

  // Uniqueness pass. Shortening is only safe if the rendered pair still
  // identifies exactly one cluster — otherwise a click connects to a
  // different cluster than the operator read. Two contexts that collapse to
  // the same `short · qualifier` both revert to their full names.
  const seen = new Map<string, number>();
  const renderKey = (p: ParsedContext) =>
    `${p.short}|${p.qualifiers.join("|")}`;
  for (const { p } of parsed) {
    const k = renderKey(p);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }

  const out: Record<string, ClusterLabel> = {};
  for (const { c, p } of parsed) {
    const coordinate = joinQualifiers(p.qualifiers);
    // The grouping keys are derived from the PARSE, not from the display
    // decision, so the fleet can bucket by project even with shortening
    // turned off — the two settings are independent.
    const groupKey = coordinate
      ? `${p.provider}|${p.qualifiers.join("|")}`
      : null;
    const shortenable = enabled && (seen.get(renderKey(p)) ?? 0) === 1;
    out[c.id] = {
      full: c.name,
      short: shortenable ? p.short : c.name,
      qualifier: shortenable ? coordinate : null,
      groupKey,
      groupLabel: coordinate,
    };
  }
  return out;
}

// One-entry memo. `contexts` is a stable array reference between store
// updates, so the ~15 call sites that each ask for the map on render share a
// single computation instead of re-parsing the fleet per component.
let memoContexts: readonly LabelSource[] | null = null;
let memoEnabled = false;
let memoResult: Record<string, ClusterLabel> | null = null;

/// Resolve display labels for the whole fleet, keyed by `ContextInfo.id`.
///
/// Always pass the COMPLETE context list, never a filtered or grouped subset:
/// the uniqueness pass is list-aware, so feeding it a subset would let a
/// label change when a search box is typed into.
///
/// `enabled` gates only the DISPLAY fields (`short` / `qualifier`).
/// `groupKey` / `groupLabel` come from the parse either way, so the fleet's
/// project grouping keeps working with shortening turned off.
export function clusterLabels(
  contexts: readonly LabelSource[],
  enabled: boolean,
): Record<string, ClusterLabel> {
  if (memoResult && memoContexts === contexts && memoEnabled === enabled) {
    return memoResult;
  }
  const result = computeLabels(contexts, enabled);
  memoContexts = contexts;
  memoEnabled = enabled;
  memoResult = result;
  return result;
}

/// Label lookup that degrades to the raw id for a context that has vanished
/// from the kubeconfig (a stale tab, a virtual-context member pointing at a
/// removed cluster). Callers rendering a possibly-missing cluster should use
/// this rather than indexing the map directly.
export function labelFor(
  labels: Record<string, ClusterLabel>,
  id: string,
  fallback?: string | null,
): ClusterLabel {
  const hit = labels[id];
  if (hit) return hit;
  const name = fallback ?? id;
  return {
    full: name,
    short: name,
    qualifier: null,
    groupKey: null,
    groupLabel: null,
  };
}
