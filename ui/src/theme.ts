// Design tokens for ferrisscope, derived from the Helmsman v2 design system.
// All UI primitives compose these — components don't introduce new colors,
// font sizes, or radii. See design/Helmsman v2 - Design principles.html.

export const FONT_SANS =
  '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const FONT_MONO =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

export type ThemeMode = "light" | "dark";

// Global UI scale (root document.zoom). Bounds chosen so the smallest end
// still leaves header strip controls hit-targets sane and the largest end
// keeps the rail + dock layout from running off screen on a 13" display.
export const UI_SCALE_MIN = 0.7;
export const UI_SCALE_MAX = 1.5;
export const UI_SCALE_STEP = 0.05;
export const UI_SCALE_DEFAULT = 1.0;

export function clampUiScale(v: number): number {
  if (!Number.isFinite(v)) return UI_SCALE_DEFAULT;
  if (v < UI_SCALE_MIN) return UI_SCALE_MIN;
  if (v > UI_SCALE_MAX) return UI_SCALE_MAX;
  // Snap to the nearest step so keyboard nudges and the stepper agree on
  // the value the chip displays (avoids 1.04999999 drift).
  return Math.round(v / UI_SCALE_STEP) * UI_SCALE_STEP;
}

export type Tokens = {
  bg: string;
  surface: string;
  surfaceAlt: string;
  header: string;
  headerAlt: string;
  border: string;
  borderSoft: string;
  text: string;
  textDim: string;
  textMuted: string;
  accent: string;
  accentSoft: string;
  accentHover: string;
  accentActive: string;
  chip: string;
  hover: string;
  btnHover: string;
  rail: string;
  railHover: string;
  scrim: string;
  paletteBg: string;
  paletteBorder: string;
  bulkBg: string;
  // status — structural, identical across themes
  good: string;
  warn: string;
  bad: string;
  info: string;
  unknown: string;
};

const LIGHT: Tokens = {
  bg: "#f7f8fa",
  surface: "#ffffff",
  surfaceAlt: "#f7f8fa",
  header: "#ffffff",
  headerAlt: "#fafbfc",
  border: "#e3e6ec",
  borderSoft: "#eef0f4",
  text: "#11161d",
  textDim: "#525a68",
  textMuted: "#8a93a0",
  accent: "#ce422b",
  accentSoft: "#fbe1da",
  accentHover: "#b03722",
  accentActive: "#912c1a",
  chip: "#eef0f4",
  hover: "rgba(15,20,30,0.035)",
  btnHover: "#f4f6f9",
  rail: "#ffffff",
  railHover: "rgba(15,20,30,0.04)",
  scrim: "rgba(15,20,30,0.22)",
  paletteBg: "rgba(255,255,255,0.97)",
  paletteBorder: "#d6dae2",
  bulkBg: "#11161d",
  good: "#10b981",
  warn: "#f59e0b",
  bad: "#f43f5e",
  info: "#3b82f6",
  unknown: "#94a3b8",
};

const DARK: Tokens = {
  bg: "#0d1014",
  surface: "#161a20",
  surfaceAlt: "#11141a",
  header: "#11141a",
  headerAlt: "#191d24",
  border: "#23282f",
  borderSoft: "#1c2027",
  text: "#e8eaef",
  textDim: "#a0a6b0",
  textMuted: "#6c7280",
  accent: "#f08c6e",
  accentSoft: "rgba(240,140,110,0.16)",
  accentHover: "#d97a5d",
  accentActive: "#b9664c",
  chip: "#1d2128",
  hover: "rgba(255,255,255,0.04)",
  btnHover: "#1c2128",
  rail: "#11141a",
  railHover: "rgba(255,255,255,0.05)",
  scrim: "rgba(8,10,14,0.55)",
  paletteBg: "rgba(20,22,28,0.92)",
  paletteBorder: "#2a2d36",
  bulkBg: "#161a20",
  good: "#10b981",
  warn: "#f59e0b",
  bad: "#f43f5e",
  info: "#3b82f6",
  unknown: "#64748b",
};

export const tokens = (mode: ThemeMode): Tokens =>
  mode === "dark" ? DARK : LIGHT;

// ── Status mapping ─────────────────────────────────────────────────────────
// Maps a Kubernetes status string into the four documented buckets.
// P5: status colour is structural — same meaning everywhere, never reused
// for selection, branding, or links.

export type StatusBucket = "good" | "warn" | "bad" | "info" | "unknown";

const GOOD = new Set([
  "Running",
  "Ready",
  "Active",
  "Available",
  "Bound",
  "healthy",
]);
const WARN = new Set([
  "Pending",
  "Warning",
  "warning",
  "degraded",
  "Updating",
  "Progressing",
]);
const INFO = new Set([
  "ContainerCreating",
  "PodInitializing",
  "Init",
  "Succeeded",
  "Completed",
]);
const BAD = new Set([
  "CrashLoopBackOff",
  "Error",
  "Failed",
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "RunContainerError",
  "OOMKilled",
  "Evicted",
  "NotReady",
  "Unhealthy",
  "Unavailable",
  "DeadlineExceeded",
  "ContainerCannotRun",
  "Terminated",
]);
// Transient: render with a pulsing dot until the state resolves. Per the
// design's `statusIsTransient`, plus the container-level waiting reasons we
// see while pods are coming up.
const TRANSIENT = new Set([
  "ContainerCreating",
  "PodInitializing",
  "Init",
  "Pending",
  "Terminating",
  "Updating",
  "Progressing",
  "Waiting",
  "PodScheduled",
  "ContainerStarting",
]);

export function statusBucket(status: string): StatusBucket {
  if (GOOD.has(status)) return "good";
  if (BAD.has(status)) return "bad";
  if (INFO.has(status)) return "info";
  if (WARN.has(status)) return "warn";
  if (status === "Terminating" || status === "Waiting") return "unknown";
  return "unknown";
}

export function statusIsTransient(status: string): boolean {
  return TRANSIENT.has(status);
}

// Hex color for the status dot — used by StatusPill, container dots, etc.
export function statusDot(status: string, t: Tokens): string {
  switch (statusBucket(status)) {
    case "good":
      return t.good;
    case "warn":
      return t.warn;
    case "bad":
      return t.bad;
    case "info":
      return t.info;
    case "unknown":
      return t.unknown;
  }
}

// Pill background + foreground for a status — softer than the dot.
export function statusFill(
  status: string,
  t: Tokens,
  mode: ThemeMode,
): { bg: string; fg: string } {
  const dark = mode === "dark";
  switch (statusBucket(status)) {
    case "good":
      return {
        bg: dark ? "rgba(16,185,129,0.16)" : "#d1fae5",
        fg: dark ? "#34d399" : "#047857",
      };
    case "warn":
      return {
        bg: dark ? "rgba(251,191,36,0.16)" : "#fef3c7",
        fg: dark ? "#fbbf24" : "#92400e",
      };
    case "bad":
      return {
        bg: dark ? "rgba(244,63,94,0.16)" : "#ffe4e6",
        fg: dark ? "#fb7185" : "#9f1239",
      };
    case "info":
      return {
        bg: dark ? "rgba(59,130,246,0.16)" : "#dbeafe",
        fg: dark ? "#60a5fa" : "#1d4ed8",
      };
    case "unknown":
      return {
        bg: dark ? "rgba(100,116,139,0.16)" : "#e2e8f0",
        fg: dark ? "#94a3b8" : "#475569",
      };
  }
  return { bg: t.chip, fg: t.textDim };
}
