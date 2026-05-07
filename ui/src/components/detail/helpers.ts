// Pure helpers shared by detail-panel summary components. Kept tiny and
// dependency-free so any kind's summary can use them without pulling React
// or theme tokens.

// Parse a Kubernetes Quantity string (e.g. "100m", "1Gi", "500Mi", "2") to
// a number in base units (cores for cpu, bytes for memory). Returns null
// when the input can't be parsed — callers use this for client-side
// validation only; the apiserver remains the final arbiter.
export function parseQuantity(q: string | null): number | null {
  if (q == null) return null;
  // Char class needs capital K too — K8s allows "1Ki" / "10Ki" for memory.
  // The historical version of this regex (lifted from config/index.tsx) was
  // missing K, which silently dropped Ki-suffixed quantities to null.
  const m = /^(-?\d+(?:\.\d+)?)([numkKMGTPEi]*)$/.exec(q);
  if (!m) return null;
  const num = m[1];
  if (num == null) return null;
  const n = parseFloat(num);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case "":
      return n;
    case "m":
      return n / 1000;
    case "k":
      return n * 1e3;
    case "M":
      return n * 1e6;
    case "G":
      return n * 1e9;
    case "T":
      return n * 1e12;
    case "P":
      return n * 1e15;
    case "E":
      return n * 1e18;
    case "Ki":
      return n * 1024;
    case "Mi":
      return n * 1024 ** 2;
    case "Gi":
      return n * 1024 ** 3;
    case "Ti":
      return n * 1024 ** 4;
    case "Pi":
      return n * 1024 ** 5;
    case "Ei":
      return n * 1024 ** 6;
    case "n":
      return n / 1e9;
    case "u":
      return n / 1e6;
    default:
      return null;
  }
}

// Format a Kubernetes Quantity for display, scaling to a friendlier unit
// based on the resource key. Returns the original string when the value
// can't be parsed (apiserver may surface custom resource shapes we don't
// recognise — show what came over the wire rather than swallowing it).
//
//   formatQuantity("memory", "16384000Ki") → "15.6Gi"
//   formatQuantity("memory", "1073741824") → "1Gi"
//   formatQuantity("cpu", "8000m")          → "8"
//   formatQuantity("cpu", "250m")           → "250m"
//   formatQuantity("ephemeral-storage", "5368709120") → "5Gi"
//   formatQuantity("pods", "110")           → "110"   (pass-through)
export function formatQuantity(key: string, raw: string | null): string {
  if (raw == null) return "—";
  const n = parseQuantity(raw);
  if (n == null) return raw;
  // Strip prefixes like "requests." / "limits." / "count/" so dotted
  // ResourceQuota keys resolve to the underlying resource class.
  const last = key.split(".").pop() ?? key;
  const tail = last.split("/").pop() ?? last;
  if (tail === "cpu") return formatCpu(n);
  if (
    tail === "memory" ||
    tail === "ephemeral-storage" ||
    tail.startsWith("hugepages-") ||
    tail.endsWith("-storage")
  ) {
    return formatBytes(n);
  }
  return raw;
}

// Internal: pretty-print a byte count in the largest binary unit where the
// value stays >= 1. Decimals depend on magnitude — three significant
// figures stays compact in tabular layouts.
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 1024) return `${Math.round(n)}B`;
  const units = ["Ki", "Mi", "Gi", "Ti", "Pi", "Ei"];
  // u tracks the unit index AFTER each division. Start at -1 so the first
  // iteration lands on Ki (units[0]); without that the result is one unit
  // too coarse (1Gi → 1Ti, etc.).
  let v = n;
  let u = -1;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  const decimals = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${trimTrailingZeros(v.toFixed(decimals))}${units[u]}`;
}

// Internal: pretty-print cpu in cores when integer/sub-decimal, millicores
// when fractional. "8000m" → "8", "250m" → "250m", "1.5" → "1.5".
function formatCpu(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n >= 1) {
    if (Number.isInteger(n)) return String(n);
    return trimTrailingZeros(n.toFixed(2));
  }
  return `${Math.round(n * 1000)}m`;
}

function trimTrailingZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

// Format an ISO-8601 timestamp as a relative duration suffix-free string
// ("3m", "5h", "2d"). Returns "—" for inputs that don't parse.
export function ageFromIso(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  let s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
