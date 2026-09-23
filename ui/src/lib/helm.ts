import { dumpYaml, parseYaml, type Json } from "./yamlEdit";

export const MAX_RELEASE_NAME_LEN = 53;
const MAX_NAMESPACE_LEN = 63;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export type ChartUid = { source: string; name: string; version: string };

/** `helm:chart:<source>:<name>:<version>` (see `helm_charts::synthetic_uid`). */
export function parseChartUid(uid: string): ChartUid | null {
  const prefix = "helm:chart:";
  if (!uid.startsWith(prefix)) return null;
  const rest = uid.slice(prefix.length);
  const a = rest.indexOf(":");
  if (a === -1) return null;
  const b = rest.indexOf(":", a + 1);
  if (b === -1) return null;
  const source = rest.slice(0, a);
  const name = rest.slice(a + 1, b);
  const version = rest.slice(b + 1);
  return source && name && version ? { source, name, version } : null;
}

/** Changed-line count; only drives the Save (N) badge. */
export function approxLineDiff(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.split("\n");
  const bl = b.split("\n");
  let n = 0;
  for (let i = 0, len = Math.max(al.length, bl.length); i < len; i += 1) {
    if (al[i] !== bl[i]) n += 1;
  }
  return n;
}

export function valuesToYaml(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && Object.keys(v).length === 0) return "";
  try {
    return dumpYaml(v as Json);
  } catch {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
}

export function suggestReleaseName(chartName: string): string {
  const base = chartName.slice(chartName.lastIndexOf("/") + 1).toLowerCase();
  return base.replace(/[^a-z0-9.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, MAX_RELEASE_NAME_LEN);
}

/** Mirrors `helm::validate_release_name`: dot-separated DNS labels, ≤ 53 chars. */
export function releaseNameError(name: string): string | null {
  if (!name) return "Release name is required.";
  if (name.length > MAX_RELEASE_NAME_LEN)
    return `Release name must be at most ${MAX_RELEASE_NAME_LEN} characters.`;
  if (!name.split(".").every((l) => DNS_LABEL.test(l)))
    return "Use lowercase letters, digits, '-' and '.', starting and ending with a letter or digit.";
  return null;
}

/** DNS-1123 label, ≤ 63 chars. */
export function namespaceError(ns: string): string | null {
  if (!ns) return "Namespace is required.";
  if (ns.length > MAX_NAMESPACE_LEN)
    return `Namespace must be at most ${MAX_NAMESPACE_LEN} characters.`;
  if (!DNS_LABEL.test(ns))
    return "Use lowercase letters, digits and '-', starting and ending with a letter or digit.";
  return null;
}

/** Helm values must be a mapping (or empty, meaning chart defaults). */
export function valuesYamlError(text: string): string | null {
  let v: Json;
  try {
    v = parseYaml(text);
  } catch (e) {
    return `YAML parse error: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v))
    return "Values must be a YAML mapping (key: value).";
  return null;
}

/** A release helm is still installing / upgrading / rolling back / uninstalling. */
export function isPendingStatus(status: string | null | undefined): boolean {
  return !!status && (status.startsWith("pending-") || status === "uninstalling");
}
