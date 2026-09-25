// Icon set. Solid filled geometric style per icon.md: every glyph is drawn in
// a 24×24 viewBox with `fill="currentColor"`, no strokes. Call sites pick the
// display size; the SVG scales down inside the existing layout boxes.

import type { ReactElement } from "react";

const filled = (
  size: number,
  content: ReactElement | ReactElement[],
): ReactElement => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    {content}
  </svg>
);

export const Icons = {
  pod: filled(
    16,
    <>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 3a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z"
      />
      <circle cx="12" cy="12" r="2.5" />
    </>,
  ),
  deploy: filled(
    16,
    <>
      <rect x="3" y="5" width="18" height="5" rx="1" />
      <rect x="3" y="14" width="18" height="5" rx="1" />
    </>,
  ),
  node: filled(
    16,
    <path d="M4 4h16v6H4V4Zm2 2v2h2V6H6Zm4 0v2h8V6h-8ZM4 14h16v6H4v-6Zm2 2v2h2v-2H6Zm4 0v2h8v-2h-8Z" />,
  ),
  cluster: filled(
    16,
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M9 5h6v2H9zM9 17h6v2H9zM5 9h2v6H5zM17 9h2v6h-2z" />
    </>,
  ),
  network: filled(
    16,
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="3" r="2" />
      <circle cx="4" cy="20" r="2" />
      <circle cx="20" cy="20" r="2" />
      <path d="M11 5h2v6h-2zM10.6 13.5l-7 5.4 1 1.3 7-5.4zM13.4 13.5l7 5.4-1 1.3-7-5.4z" />
    </>,
  ),
  storage: filled(
    16,
    <path d="M12 3c4.4 0 8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3V6c0-1.7 3.6-3 8-3Zm-8 5.2V11c0 1.7 3.6 3 8 3s8-1.3 8-3V8.2c-1.7 1.3-4.8 2-8 2s-6.3-.7-8-2Zm0 5V16c0 1.7 3.6 3 8 3s8-1.3 8-3v-2.8c-1.7 1.3-4.8 2-8 2s-6.3-.7-8-2Z" />,
  ),
  cm: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M5 3h9l5 5v13H5V3Zm9 1.5V8h3.5L14 4.5Z"
    />,
  ),
  secret: filled(
    16,
    <>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M7 11V8a5 5 0 0 1 10 0v3h2v11H5V11h2Zm2 0h6V8a3 3 0 0 0-6 0v3Z"
      />
      <path d="M11.3 16.5h1.4v3h-1.4z" />
      <circle cx="12" cy="16" r="1.3" />
    </>,
  ),
  settings: filled(
    16,
    <>
      <path d="M3 5h7v2H3zM14 5h7v2h-7zM3 11h13v2H3zM19 11h2v2h-2zM3 17h7v2H3zM14 17h7v2h-7z" />
      <circle cx="12" cy="6" r="2.5" />
      <circle cx="17.5" cy="12" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
    </>,
  ),
  search: filled(
    13,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M10 3a7 7 0 1 0 4.2 12.6l4.6 4.6 1.4-1.4-4.6-4.6A7 7 0 0 0 10 3Zm0 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"
    />,
  ),
  // Funnel — used for "filter visible rows". Solid silhouette per icon.md;
  // the upper bowl tapers into the stem so it reads at small sizes (12-14px).
  filter: filled(
    13,
    <path d="M3 4h18v2.5l-7 8V21l-4-2v-4.5l-7-8V4Z" />,
  ),
  close: filled(
    14,
    <path d="M5.6 4.2 4.2 5.6l6.4 6.4-6.4 6.4 1.4 1.4 6.4-6.4 6.4 6.4 1.4-1.4-6.4-6.4 6.4-6.4-1.4-1.4-6.4 6.4z" />,
  ),
  // Linux-style window controls. Drawn at 14px to match the close glyph.
  // `windowMin` is a single horizontal bar; `windowMax` is a hollow square
  // (rendered via even-odd so the inner cutout shows through `fill="currentColor"`).
  windowMin: filled(
    14,
    <rect x="4" y="11" width="16" height="2" />,
  ),
  windowMax: filled(
    14,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M4 4h16v16H4V4Zm2 2v12h12V6H6Z"
    />,
  ),
  copy: filled(
    14,
    <>
      <path d="M9 2h9a2 2 0 0 1 2 2v12h-2V4H9z" />
      <rect x="4" y="6" width="13" height="16" rx="2" />
    </>,
  ),
  pin: filled(
    16,
    <path d="M9 2h6v2l-1 5h3l1 2v2H6v-2l1-2h3l-1-5V2zM11 13h2v9l-1 1-1-1z" />,
  ),
  chevR: filled(
    10,
    <path d="M9 4l8 8-8 8z" />,
  ),
  chevL: filled(
    10,
    <path d="M15 4l-8 8 8 8z" />,
  ),
  chevD: filled(
    10,
    <path d="M4 9l8 8 8-8z" />,
  ),
  trash: filled(
    14,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M9 2h6v2h5v3H4V4h5V2zm-3 7h12l-1 13H7L6 9zm3 2v9h2v-9H9zm4 0v9h2v-9h-2z"
    />,
  ),
  refresh: filled(
    14,
    <path d="M12 4V1L7 5l5 4V6a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" />,
  ),
  // Counter-clockwise arrow around a clock hand: return to an earlier revision.
  rollback: filled(
    14,
    <>
      <path d="M12 4V1L7 5l5 4V6a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" />
      <path d="M11 8h2v4h3v2h-5z" />
    </>,
  ),
  // Up arrow onto a bar: move to a newer version.
  upgrade: filled(
    14,
    <>
      <path d="M12 3l7 7h-4v6H9v-6H5z" />
      <rect x="5" y="18" width="14" height="3" rx="1" />
    </>,
  ),
  // Argo CD / Flux "apply desired state now" — two opposed arrows, distinct
  // from the single-arrow `refresh` (re-read / compare only).
  sync: filled(
    14,
    <>
      <path d="M12 4a8 8 0 0 0-7.4 5h3.3A5 5 0 0 1 12 7a5 5 0 0 1 3.5 1.5L13 11h7V4l-2.4 2.4A8 8 0 0 0 12 4z" />
      <path d="M12 20a8 8 0 0 0 7.4-5h-3.3A5 5 0 0 1 12 17a5 5 0 0 1-3.5-1.5L11 13H4v7l2.4-2.4A8 8 0 0 0 12 20z" />
    </>,
  ),
  shell: filled(
    14,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M3 4h18v16H3V4Zm3 4l-1 1 3 3-3 3 1 1 4-4-4-4zm6 6h6v2h-6v-2z"
    />,
  ),
  logs: filled(
    14,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M5 3h11l3 3v15H5V3zm3 6v2h8V9H8zm0 4v2h8v-2H8zm0 4v2h5v-2H8z"
    />,
  ),
  // Metrics glyph: solid speedometer dome with a negative-space needle +
  // hub, flat bottom. Per icon.md: one filled form, simple cuts only.
  gauge: filled(
    14,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 5a9 9 0 0 1 9 9v3H3v-3a9 9 0 0 1 9-9zm5.66 3.34-6.37 4.96a1.5 1.5 0 1 0 1.41 1.41l4.96-6.37z"
    />,
  ),
  yaml: filled(
    14,
    <path d="M9 6l-7 6 7 6 1.6-1.6L5 12l5.6-4.4zM15 6l-1.6 1.6L19 12l-5.6 4.4L15 18l7-6zM14.5 4l-4 16h-2l4-16z" />,
  ),
  // AI-chat glyph: solid speech bubble with a small tail. 24×24 viewBox per
  // icon.md, currentColor fill, no strokes.
  chat: filled(
    14,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M3 4h18v13H8l-4 4v-4H3V4Zm4 4v2h10V8H7Zm0 4v2h7v-2H7Z"
    />,
  ),
  eye: filled(
    14,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 5C6 5 2 12 2 12s4 7 10 7 10-7 10-7-4-7-10-7zm0 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"
    />,
  ),
  sun: filled(
    14,
    <>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M11 1h2v3h-2zM11 20h2v3h-2zM1 11h3v2H1zM20 11h3v2h-3zM3.5 4.9l1.4-1.4 2.1 2.1-1.4 1.4zM16.9 18.4l1.4-1.4 2.1 2.1-1.4 1.4zM3.5 19.1l2.1-2.1 1.4 1.4-2.1 2.1zM16.9 5.6l2.1-2.1 1.4 1.4-2.1 2.1z" />
    </>,
  ),
  moon: filled(
    14,
    <path d="M21 14a9 9 0 1 1-11-11 7 7 0 0 0 11 11z" />,
  ),
  layers: filled(
    14,
    <path d="M12 2 22 7l-10 5L2 7zm-8 8 8 4 8-4 2 1-10 5L2 11zm0 5 8 4 8-4 2 1-10 5L2 16z" />,
  ),
  plus: filled(
    14,
    <path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z" />,
  ),
  // Chat composer send — an upward arrow (modern composer convention).
  send: filled(
    16,
    <path d="M12 3 21 12h-5v8h-8v-8H3z" />,
  ),
  // Stop / cancel an in-flight stream — a rounded filled square.
  stop: filled(
    14,
    <rect x="6" y="6" width="12" height="12" rx="2" />,
  ),
  // Suspend a Job / CronJob. Paired with `play` for the resume side, so the
  // two read as one toggle: same optical weight, same 12×12 footprint.
  pause: filled(
    14,
    <>
      <rect x="6" y="5" width="4" height="14" rx="1.5" />
      <rect x="14" y="5" width="4" height="14" rx="1.5" />
    </>,
  ),
  // Resume the other half of the pause toggle.
  play: filled(
    14,
    <path d="M7 4.5l13 7.5-13 7.5z" />,
  ),
  // "Run this now, out of schedule" — a CronJob trigger. Deliberately NOT a
  // play triangle: it sits next to the suspend toggle, which shows a play
  // triangle whenever the object is suspended, and two identical glyphs in
  // one button group are unreadable.
  bolt: filled(
    14,
    <path d="M13 2L4 13.5h6L9.5 22 20 10h-6.5z" />,
  ),
  pencil: filled(
    14,
    <path d="M3 17l11-11 4 4-11 11H3v-4zM16 4l2-2 4 4-2 2z" />,
  ),
  check: filled(
    14,
    <path d="M9 16.5l-5.5-5.5 2-2 3.5 3.5L18 4l2 2z" />,
  ),
  // Toast / notification tone glyphs. Drawn so the inner shape (i, !, ×) is
  // punched out of the filled silhouette via `fillRule="evenodd"`, matching
  // the existing solid-fill icon style (no strokes).
  info: filled(
    14,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-1 6h2v2h-2V8Zm0 3h2v7h-2v-7Z"
    />,
  ),
  warn: filled(
    14,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2 22 20H2L12 2Zm-1 7h2v5h-2V9Zm0 7h2v2h-2v-2Z"
    />,
  ),
  error: filled(
    14,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-3.5 5L7 8.5 10.5 12 7 15.5 8.5 17 12 13.5 15.5 17 17 15.5 13.5 12 17 8.5 15.5 7 12 10.5 8.5 7Z"
    />,
  ),
  more: filled(
    14,
    <>
      <circle cx="5" cy="12" r="2.2" />
      <circle cx="12" cy="12" r="2.2" />
      <circle cx="19" cy="12" r="2.2" />
    </>,
  ),
  bell: filled(
    14,
    <path d="M12 2a6 6 0 0 0-6 6v5l-2 3v1h16v-1l-2-3V8a6 6 0 0 0-6-6zm-2 17a2 2 0 1 0 4 0z" />,
  ),
  // Port-forward chip glyph — local ↔ remote arrows. Solid filled per icon.md.
  forward: filled(
    14,
    <>
      <rect x="2" y="6" width="5" height="12" rx="1" />
      <rect x="17" y="6" width="5" height="12" rx="1" />
      <path d="M11 9l-3 3 3 3v-2h2v2l3-3-3-3v2h-2z" />
    </>,
  ),
  // External-open glyph — square + diagonal arrow. Used by the
  // "open in browser" affordance on port-forward rows.
  external: filled(
    14,
    <>
      <path d="M5 5h6v2H7v10h10v-4h2v6H5z" />
      <path d="M14 3h7v7h-2V6.4l-7.3 7.3-1.4-1.4L17.6 5H14z" />
    </>,
  ),
  // Node + pod action glyphs. Single-colour; the caller's tone colours them.
  nodeDrain: filled(
    16,
    <path d="M4 4h16v6H4V4Zm2 2v2h2V6H6Zm4 0v2h8V6h-8ZM11 11h2v5h3l-4 5-4-5h3v-5Z" />,
  ),
  nodeCordon: filled(
    16,
    <>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z"
      />
      <path d="m6.7 5.3 12 12-1.4 1.4-12-12 1.4-1.4Z" />
    </>,
  ),
  nodeUncordon: filled(
    16,
    <>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z"
      />
      <path d="m10.5 15.5-3.5-3.5 1.4-1.4 2.1 2.1 5.1-5.1 1.4 1.4-6.5 6.5Z" />
    </>,
  ),
  // Evict pods — pod cube leaving to the right. Tone comes from the caller.
  podDrain: filled(
    16,
    <>
      <g transform="translate(-1 3) scale(.75)">
        <path d="M12 2 4 6.5v11L12 22l8-4.5v-11L12 2Zm0 2.3 5.5 3.1L12 10.5 6.5 7.4 12 4.3Zm-6 5 5 2.8v6.8l-5-2.8V9.3Zm7 9.6v-6.8l5-2.8v6.8l-5 2.8Z" />
      </g>
      <path d="M15.5 10.5H19V7.5l3.5 4.5-3.5 4.5v-3h-3.5v-3Z" />
    </>,
  ),
  // Apps — package box with a small "+" cap. Used as the category-rail icon
  // for the Apps section (Helm releases today, Argo / Flux later).
  apps: filled(
    16,
    <path d="M12 2 3 6.5 12 11l9-4.5L12 2Zm-9 6 9 4.5V22l-9-4.5V8Zm18 0v9.5L13 22V12.5L21 8Z" />,
  ),
  // Generic CRD fallback — hexagon with square brackets: "some extension".
  crdGeneric: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2 21 7v10l-9 5-9-5V7l9-5ZM7.5 7.5H11v2H9.5v5H11v2H7.5v-9Zm9 0H13v2h1.5v5H13v2h3.5v-9Z" />,
  ),
};

export type IconKey = keyof typeof Icons;

// Per-Kubernetes-kind glyphs. Same solid 24×24 style as the utility icons
// above. Used by the Rail and Command Palette so each kind has its own
// silhouette; unknown kinds (CRDs) fall back to the category icon.
export const KindIcons: Record<string, ReactElement> = {
  Pod: filled(
    16,
    <path d="M12 2 4 6.5v11L12 22l8-4.5v-11L12 2Zm0 2.3 5.5 3.1L12 10.5 6.5 7.4 12 4.3Zm-6 5 5 2.8v6.8l-5-2.8V9.3Zm7 9.6v-6.8l5-2.8v6.8l-5 2.8Z" />,
  ),
  // Pod inside template brackets.
  PodTemplate: filled(
    16,
    <>
      <path d="M2 2h6v2H4v4H2V2Zm14 0h6v6h-2V4h-4V2ZM2 16h2v4h4v2H2v-6Zm18 0h2v6h-6v-2h4v-4Z" />
      <g transform="translate(4.8 4.8) scale(.6)">
        <path d="M12 2 4 6.5v11L12 22l8-4.5v-11L12 2Zm0 2.3 5.5 3.1L12 10.5 6.5 7.4 12 4.3Zm-6 5 5 2.8v6.8l-5-2.8V9.3Zm7 9.6v-6.8l5-2.8v6.8l-5 2.8Z" />
      </g>
    </>,
  ),
  // Rocket — ships a new rollout. Kept away from the sync arrows used by GitOps actions.
  Deployment: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M12 2c3 2 4.5 5.5 4.5 9.5V16h-9v-4.5C7.5 7.5 9 4 12 2Zm0 5.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6Z" />
      <path d="M7.5 11.5 4 15v4.5l3.5-2.5v-5.5Zm9 0L20 15v4.5L16.5 17v-5.5ZM10 17.5h4l-.6 2.5-1.4 2.5-1.4-2.5-.6-2.5Z" />
    </>,
  ),
  // Stacked cards — N identical replicas.
  ReplicaSet: filled(
    16,
    <path d="M3 9h12v12H3V9Zm3-3h12v12h-1.5V7.5H6V6Zm3-3h12v12h-1.5V4.5H9V3Z" />,
  ),
  // Pod on a persistent disk — stable identity plus storage.
  StatefulSet: filled(
    16,
    <>
      <g transform="translate(3.6 -0.8) scale(.7)">
        <path d="M12 2 4 6.5v11L12 22l8-4.5v-11L12 2Zm0 2.3 5.5 3.1L12 10.5 6.5 7.4 12 4.3Zm-6 5 5 2.8v6.8l-5-2.8V9.3Zm7 9.6v-6.8l5-2.8v6.8l-5 2.8Z" />
      </g>
      <path d="M4 17.8c0-1.3 3.6-2.3 8-2.3s8 1 8 2.3v2c0 1.3-3.6 2.3-8 2.3s-8-1-8-2.3v-2Z" />
    </>,
  ),
  // One pod per node — three nodes, each carrying a pod.
  DaemonSet: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M2 5h6v14H2V5Zm3 2.2a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2ZM3.5 15h3v1.5h-3V15ZM9 5h6v14H9V5Zm3 2.2a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2ZM10.5 15h3v1.5h-3V15ZM16 5h6v14h-6V5Zm3 2.2a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2ZM17.5 15h3v1.5h-3V15Z" />,
  ),
  Job: filled(
    16,
    <path d="M8 3h8l1 2h3v17H4V5h3l1-2Zm2.2 11.6-2.8-2.8L6 13.2l4.2 4.2L18 9.6 16.6 8l-6.4 6.6Z" />,
  ),
  CronJob: filled(
    16,
    <path d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Zm-1 4v6l5 3 1-1.7-4-2.3V7h-2Z" />,
  ),
  Node: filled(
    16,
    <path d="M4 4h16v6H4V4Zm2 2v2h2V6H6Zm4 0v2h8V6h-8ZM4 14h16v6H4v-6Zm2 2v2h2v-2H6Zm4 0v2h8v-2h-8Z" />,
  ),
  Namespace: filled(
    16,
    <path d="M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z" />,
  ),
  Event: filled(
    16,
    <path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm1 3-6 8h4l-1 6 7-9h-4l1-5Z" />,
  ),
  Service: filled(
    16,
    <path d="M12 3a3 3 0 0 1 1 5.8V11h5a3 3 0 1 1-2.8 2H8.8A3 3 0 1 1 6 11h5V8.8A3 3 0 0 1 12 3Z" />,
  ),
  Endpoints: filled(
    16,
    <>
      <circle cx="4" cy="6" r="2.5" />
      <circle cx="4" cy="12" r="2.5" />
      <circle cx="4" cy="18" r="2.5" />
      <rect x="8" y="11" width="7" height="2" />
      <circle cx="18" cy="12" r="3.5" />
    </>,
  ),
  EndpointSlice: filled(
    16,
    <path d="M3 8a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8Zm4 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm5 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm5 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />,
  ),
  Ingress: filled(
    16,
    <path d="M11 3h2v9l3-3 1.5 1.5L12 16l-5.5-5.5L8 9l3 3V3ZM4 15h3v3h10v-3h3v6H4v-6Z" />,
  ),
  IngressClass: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2 21 7v10l-9 5-9-5V7l9-5Zm4.8 13.2A6 6 0 1 1 16.8 8l-1.7 1.2A3.8 3.8 0 1 0 15.1 14l1.7 1.2Z" />,
  ),
  NetworkPolicy: filled(
    16,
    <path d="M12 2 20 5v6c0 5.1-3.3 9.3-8 11-4.7-1.7-8-5.9-8-11V5l8-3Z" />,
  ),
  ConfigMap: filled(
    16,
    <path d="M5 2h10l4 4v16H5V2Zm9 1.5V7h3.5L14 3.5ZM9 10l-3 3 3 3 1.3-1.3L8.6 13l1.7-1.7L9 10Zm6 0-1.3 1.3 1.7 1.7-1.7 1.7L15 16l3-3-3-3Z" />,
  ),
  Secret: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M7 10V7a5 5 0 0 1 10 0v3h2v12H5V10h2Zm2 0h6V7a3 3 0 0 0-6 0v3Zm2 5v3h2v-3h-2Z" />,
  ),
  ResourceQuota: filled(
    16,
    <path d="M11 2v11h11A11 11 0 0 1 11 24 11 11 0 0 1 11 2Zm2 0a11 11 0 0 1 9 9h-9V2Z" />,
  ),
  LimitRange: filled(
    16,
    <path d="M4 6h8a3 3 0 0 1 5.8 0H20v2h-2.2A3 3 0 0 1 12 8H4V6Zm0 5h2.2a3 3 0 0 1 5.8 0h8v2h-8a3 3 0 0 1-5.8 0H4v-2Zm0 5h10.2a3 3 0 0 1 5.8 0h0v2h0a3 3 0 0 1-5.8 0H4v-2Z" />,
  ),
  PersistentVolumeClaim: filled(
    16,
    <path d="M11 3c4.4 0 8 1.3 8 3v6.3A6 6 0 0 0 12.3 19H11c-3.9-.2-7-1.4-7-3V6c0-1.7 3.1-3 7-3Zm7 10a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm-.8 6.1-1.7-1.7-1.1 1.1 2.8 2.8 4.5-4.8-1.2-1-3.3 3.6Z" />,
  ),
  PersistentVolume: filled(
    16,
    <path d="M12 3c4.4 0 8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3V6c0-1.7 3.6-3 8-3Zm-8 5.2V11c0 1.7 3.6 3 8 3s8-1.3 8-3V8.2c-1.7 1.3-4.8 2-8 2s-6.3-.7-8-2Zm0 5V16c0 1.7 3.6 3 8 3s8-1.3 8-3v-2.8c-1.7 1.3-4.8 2-8 2s-6.3-.7-8-2Z" />,
  ),
  StorageClass: filled(
    16,
    <path d="M12 3 22 8l-10 5L2 8l10-5Zm0 12 7.5-3.8L22 12.5l-10 5-10-5 2.5-1.3L12 15Zm0 4.5 7.5-3.8L22 17l-10 5-10-5 2.5-1.3 7.5 3.8Z" />,
  ),
  ServiceAccount: filled(
    16,
    <path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm-6 12.2A8 8 0 0 0 18 18.2c-1.4-1.7-3.5-2.7-6-2.7s-4.6 1-6 2.7Z" />,
  ),
  Role: filled(
    16,
    <path d="M12 2 20 5v7c0 4.4-3.2 8.3-8 10-4.8-1.7-8-5.6-8-10V5l8-3Zm0 5a3 3 0 0 0-1 5.8V16h2v-3.2A3 3 0 0 0 12 7Z" />,
  ),
  RoleBinding: filled(
    16,
    <path d="M9.5 7.5 7.4 9.6a3 3 0 0 0 4.2 4.2l1.2-1.2 1.4 1.4-1.2 1.2a5 5 0 0 1-7.1-7.1L8.1 6a5 5 0 0 1 7.1 0l-1.4 1.4a3 3 0 0 0-4.3.1Zm5-1.4a5 5 0 0 1 3.6 8.5L15.9 17a5 5 0 0 1-7.1 0l1.4-1.4a3 3 0 0 0 4.3-.1l2.1-2.1a3 3 0 0 0-4.2-4.2l-1.2 1.2L9.8 9l1.2-1.2a5 5 0 0 1 3.5-1.7Z" />,
  ),
  ClusterRole: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2 20 5v7c0 4.4-3.2 8.3-8 10-4.8-1.7-8-5.6-8-10V5l8-3Zm0 4 1.5 3 3.3.5-2.4 2.3.6 3.2-3-1.5L9 15l.6-3.2-2.4-2.3 3.3-.5L12 6Z" />,
  ),
  // RoleBinding link plus the cluster-wide star.
  ClusterRoleBinding: filled(
    16,
    <>
      <g transform="translate(-1.5 2.5) scale(.85)">
        <path d="M9.5 7.5 7.4 9.6a3 3 0 0 0 4.2 4.2l1.2-1.2 1.4 1.4-1.2 1.2a5 5 0 0 1-7.1-7.1L8.1 6a5 5 0 0 1 7.1 0l-1.4 1.4a3 3 0 0 0-4.3.1Zm5-1.4a5 5 0 0 1 3.6 8.5L15.9 17a5 5 0 0 1-7.1 0l1.4-1.4a3 3 0 0 0 4.3-.1l2.1-2.1a3 3 0 0 0-4.2-4.2l-1.2 1.2L9.8 9l1.2-1.2a5 5 0 0 1 3.5-1.7Z" />
      </g>
      <path d="M19 1.5l1.2 2.4 2.6.4-1.9 1.8.5 2.6-2.4-1.2-2.4 1.2.5-2.6-1.9-1.8 2.6-.4L19 1.5Z" />
    </>,
  ),
  HorizontalPodAutoscaler: filled(
    16,
    <path d="M3 3h2v15h16v2H3V3Zm15.3 4.3 1.4 1.4-4 4-3-3-4.3 4.3-1.4-1.4 5.7-5.7 3 3 2.6-2.6Z" />,
  ),
  PodDisruptionBudget: filled(
    16,
    <path d="M12 2 4 5v6c0 5 3.5 9.4 8 11 4.5-1.6 8-6 8-11V5l-8-3Zm-1 5h2v5h-2V7Zm0 7h2v2h-2v-2Z" />,
  ),
  PriorityClass: filled(
    16,
    <path d="M12 2 15 9h7l-5.7 4.2L18.5 21 12 16.6 5.5 21l2.2-7.8L2 9h7l3-7Z" />,
  ),
  // Stacked cards with a reconcile loop — the legacy ReplicaSet.
  ReplicationController: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M3 9h12v12H3V9Zm6 2.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0 1.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z" />
      <path d="M6 6h12v12h-1.5V7.5H6V6Zm3-3h12v12h-1.5V4.5H9V3Z" />
    </>,
  ),
  // Hourglass — a lease runs out.
  Lease: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M6 2h12v2h-1v3.5L13.5 12l3.5 4.5V20h1v2H6v-2h1v-3.5l3.5-4.5L7 7.5V4H6V2Zm3 2v2.8l3 3.7 3-3.7V4H9Z" />,
  ),
  // Webhook hook with a spark — rewrites the object.
  MutatingWebhookConfiguration: filled(
    16,
    <>
      <path d="M15.5 2H18v12a6 6 0 0 1-12 0v-3.5H3.5l3.75-4.5L11 10.5H8.5V14a3.5 3.5 0 0 0 7 0V2Z" />
      <path d="M11 .5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5Z" />
    </>,
  ),
  ValidatingWebhookConfiguration: filled(
    16,
    <path d="M12 2 4 5v6c0 5 3.5 9.4 8 11 4.5-1.6 8-6 8-11V5l-8-3Zm-1.2 13.4-3.6-3.6L8.6 10.4l2.2 2.2 4.6-4.6 1.4 1.4-6 6Z" />,
  ),
  // Gate cut out of a badge — the class every Gateway picks.
  GatewayClass: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M4 2h16a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm1 4v2h1.5v11h3v-6.5a2.5 2.5 0 0 1 5 0V19h3V8H19V6H5Z" />,
  ),
  // Gate — the entry point for routed traffic.
  Gateway: filled(
    16,
    <path d="M2 4h20v3.5h-2V21h-4.5v-8.5a3.5 3.5 0 0 0-7 0V21H4V7.5H2V4Z" />,
  ),
  // Signpost — routes requests by host and path.
  HTTPRoute: filled(
    16,
    <>
      <path d="M11 2h2v20h-2V2Z" />
      <path d="M13 4h6l3 3-3 3h-6V4Z" />
      <path d="M11 12H5l-3 3 3 3h6v-6Z" />
    </>,
  ),
  // Request/response arrows — an RPC route.
  GRPCRoute: filled(
    16,
    <path d="M3 7h13V4l5 4.5-5 4.5v-3H3V7Zm18 7H8v-3l-5 4.5L8 20v-3h13v-3Z" />,
  ),
  ReferenceGrant: filled(
    16,
    <path d="M9 4h11v8h-3v-3l-7 7-3-3 7-7H9V4ZM4 12h11v8H4v-8Zm2 2v4h7v-4H6Z" />,
  ),
  // Ship's helm wheel — the project's namesake.
  HelmRelease: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z" />
      <circle cx="12" cy="12" r="2.8" />
      <rect x="11" y="1.5" width="2" height="21" rx="1" transform="rotate(0 12 12)" />
      <rect x="11" y="1.5" width="2" height="21" rx="1" transform="rotate(45 12 12)" />
      <rect x="11" y="1.5" width="2" height="21" rx="1" transform="rotate(90 12 12)" />
      <rect x="11" y="1.5" width="2" height="21" rx="1" transform="rotate(135 12 12)" />
    </>,
  ),
  // Folded nautical chart — a Helm chart package.
  HelmChart: filled(
    16,
    <path d="M2 5.5 7.5 3.7v14.8L2 20.3V5.5Zm6.5-1.8 7 1.8v14.8l-7-1.8V3.7Zm8 1.8L22 3.7v14.8l-5.5 1.8V5.5Z" />,
  ),
  // CRD definition itself — square frame with internal schema lines. Used
  // for the `CustomResourceDefinition` kind in the Cluster category. Per the
  // operator's mental model: this is "the schema", distinct from the
  // generic CRD-instance fallback (`Icons.crdGeneric`).
  CustomResourceDefinition: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M3 4h18v16H3V4Zm2 2v12h14V6H5Zm2 2h2v2H7V8Zm4 0h6v2h-6V8Zm-4 4h2v2H7v-2Zm4 0h6v2h-6v-2Zm-4 4h2v2H7v-2Zm4 0h6v2h-6v-2Z"
    />,
  ),
};

// ──────────────────────────────────────────────────────────────────────────
// CrdIcons — ecosystem-specific glyphs for popular CRDs we don't ship as
// well-known overrides on the backend (those are about *projection*, not
// icons). The frontend resolver in `iconResolve.ts` consults this map after
// `KindIcons` and falls back to a token heuristic, then `Icons.crdGeneric`.
//
// All glyphs follow the same solid-filled / monochrome / 24×24 / no-strokes
// rules as `KindIcons` and `Icons` (see `design/icon.md`).
// ──────────────────────────────────────────────────────────────────────────

export const CrdIcons: Record<string, ReactElement> = {
  // Rosette with a check — an issued certificate.
  Certificate: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M12 2a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM8.8 9.2 10 8l1.2 1.2 3-3 1.2 1.2-4.2 4.2-2.4-2.4Z" />
      <path d="M8.5 14.8 7 22l2.5-1.2L11 22.5l1-6.2-3.5-1.5Zm7 0L17 22l-2.5-1.2L13 22.5l-1-6.2 3.5-1.5Z" />
    </>,
  ),
  // Rosette with an up arrow — a pending certificate request.
  CertificateRequest: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M12 2a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm0 3.5 3 3h-2V12h-2V8.5H9l3-3Z" />
      <path d="M8.5 14.8 7 22l2.5-1.2L11 22.5l1-6.2-3.5-1.5Zm7 0L17 22l-2.5-1.2L13 22.5l-1-6.2 3.5-1.5Z" />
    </>,
  ),
  // Issuer — vertical key (the entity that signs certs).
  Issuer: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2a4 4 0 0 1 1 7.9V14h2v2h-2v2h2v2h-2v2h-2V9.9A4 4 0 0 1 12 2Zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"
    />,
  ),
  // ClusterIssuer — cluster-of-dots scaffold + vertical key inside.
  ClusterIssuer: filled(
    16,
    <>
      <circle cx="4" cy="4" r="2" />
      <circle cx="20" cy="4" r="2" />
      <circle cx="4" cy="20" r="2" />
      <circle cx="20" cy="20" r="2" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 5a3 3 0 0 1 1 5.8V14h1.5v1.5H13V17h1.5v1.5H13V20h-2v-9.2A3 3 0 0 1 12 5Zm0 1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"
      />
    </>,
  ),
  // Challenge — flag on a pole (ACME http-01/dns-01 challenge).
  Challenge: filled(
    16,
    <path d="M5 2h2v20H5V2Zm3 1h11l-3 4 3 4H8V3Z" />,
  ),
  // Order — clipboard with lines (an ACME order is a list of authorizations).
  Order: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M9 2h6v2h3v18H6V4h3V2Zm0 2v1h6V4H9Zm-1 5h10v2H8V9Zm0 4h10v2H8v-2Zm0 4h7v2H8v-2Z"
    />,
  ),

  // Prometheus mark — flame over two bars in a disc.
  Prometheus: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 3c.9 2.3 3.5 3.5 3.5 6.5a3.5 3.5 0 0 1-7 0c0-1.5.6-2.6 1.4-3.3.1 1 .5 1.8 1.2 2.2C10.8 8.2 11.2 6.3 12 5Zm-4 11h8v1.5H8V16Zm1.5 2.5h5V20h-5v-1.5Z" />,
  ),
  // Flame forwarding samples — remote-write agent.
  PrometheusAgent: filled(
    16,
    <>
      <path d="M9 2c1 2.6 4 4 4 7.5a4.5 4.5 0 0 1-9 0c0-1.8.8-3.1 1.8-4 .1 1.3.6 2.2 1.5 2.7C7 5.8 7.8 3.6 9 2ZM4.5 16h9v2h-9v-2ZM6 19h6v2H6v-2Z" />
      <path d="M15 11h3.5V8.5L22 12l-3.5 3.5V13H15v-2Z" />
    </>,
  ),
  // PrometheusRule — scroll silhouette with rule lines.
  PrometheusRule: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M5 3h13a2 2 0 0 1 2 2v14a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2Zm10 16V5H6v14a1 1 0 0 0 1 1h8.5a3 3 0 0 1-.5-1ZM8 8h6v2H8V8Zm0 3h6v2H8v-2Zm0 3h4v2H8v-2Z"
    />,
  ),
  // Alertmanager — bell with a notch base (alert routing daemon).
  Alertmanager: filled(
    16,
    <path d="M12 2a6 6 0 0 0-6 6v5l-2 3v1h16v-1l-2-3V8a6 6 0 0 0-6-6Zm-2 17a2 2 0 1 0 4 0h-4Z" />,
  ),
  // Config document with a bell.
  AlertmanagerConfig: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M5 2h10l4 4v16H5V2Zm7 6a3.5 3.5 0 0 0-3.5 3.5v3L7 16v1h10v-1l-1.5-1.5v-3A3.5 3.5 0 0 0 12 8Zm-1.2 10a1.2 1.2 0 0 0 2.4 0h-2.4Z" />,
  ),
  // ServiceMonitor — service tree with a watching eye at the root.
  ServiceMonitor: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M12 4a3 3 0 0 1 1 5.8V11h4a3 3 0 1 1-3 3H10a3 3 0 1 1-3-3h4V9.8A3 3 0 0 1 12 4Zm0 1.8a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z" />,
  ),
  // PodMonitor — pod hex with an eye dot (watches pods).
  PodMonitor: filled(
    16,
    <>
      <path d="M12 2 4 6.5v11L12 22l8-4.5v-11L12 2Zm0 2.3 5.5 3.1L12 10.5 6.5 7.4 12 4.3Zm-6 5 5 2.8v6.8l-5-2.8V9.3Zm7 9.6v-6.8l5-2.8v6.8l-5 2.8Z" />
      <circle cx="12" cy="13" r="1.6" />
    </>,
  ),
  // Probe — concentric arcs (radar/probe).
  Probe: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 21a9 9 0 1 1 9-9h-2.5a6.5 6.5 0 1 0-6.5 6.5V21Zm0-5a4 4 0 1 1 0-8 4 4 0 0 1 4 4h-2a2 2 0 1 0-2 2v2Z"
    />,
  ),
  // ScrapeConfig — dotted scan grid (configures scrape targets).
  ScrapeConfig: filled(
    16,
    <path d="M3 3h2v2H3V3Zm4 0h2v2H7V3Zm4 0h2v2h-2V3Zm4 0h2v2h-2V3Zm4 0h2v2h-2V3ZM3 7h2v2H3V7Zm16 0h2v2h-2V7ZM3 11h2v2H3v-2Zm4 0h6v2H7v-2Zm12 0h2v2h-2v-2ZM3 15h2v2H3v-2Zm16 0h2v2h-2v-2ZM3 19h2v2H3v-2Zm4 0h2v2H7v-2Zm4 0h2v2h-2v-2Zm4 0h2v2h-2v-2Zm4 0h2v2h-2v-2Z" />,
  ),
  // ThanosRuler — stacked flames (Thanos rules across multiple Prometheis).
  ThanosRuler: filled(
    16,
    <>
      <path d="M9 2c1 2 2 3 2 5a2 2 0 1 1-4 0c0-.7.3-1.3.7-2-.7.7-1.4 1.7-1.4 2.8a3 3 0 1 0 6 0c0-2.8-2-3.8-3.3-5.8Z" />
      <path d="M15 8c1 2 2 3 2 5a2 2 0 1 1-4 0c0-.7.3-1.3.7-2-.7.7-1.4 1.7-1.4 2.8a3 3 0 1 0 6 0c0-2.8-2-3.8-3.3-5.8Z" />
      <path d="M5 17h15v2c0 1.1-1.3 2-3 2H8c-1.7 0-3-.9-3-2v-2Z" />
    </>,
  ),

  // Overlay frame over a base.
  Kustomization: filled(
    16,
    <>
      <path d="M3 3h12v12H3V3Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M9 9h12v12H9V9Zm2 2v8h8v-8h-8Z" />
    </>,
  ),

  // === source.toolkit.fluxcd.io ===
  // Bucket — bucket cylinder with handle.
  Bucket: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M8 3h8a3 3 0 0 1 3 3H17a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1H5a3 3 0 0 1 3-3ZM4 8h16l-1.5 13h-13L4 8Z"
    />,
  ),
  // GitRepository — three connected nodes (the git graph silhouette).
  GitRepository: filled(
    16,
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M5 7v9h2V7H5Zm12 0v3l-9 6 1.1 1.7 9.3-6.2A2 2 0 0 0 19 10V7h-2Z" />
    </>,
  ),
  // OCIRepository — stacked container layers (registry image).
  OCIRepository: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M3 4h18v5H3V4Zm0 6h18v5H3v-5Zm0 6h18v4H3v-4Zm3-9h2v1H6V7Zm0 6h2v1H6v-1Zm0 5h2v1H6v-1Z"
    />,
  ),
  // Books on a shelf — a chart repository.
  HelmRepository: filled(
    16,
    <path d="M3 4h3.5v14H3V4Zm4.5 2H11v12H7.5V6Zm4.3.9 3.2-.9 3.4 11.6-3.2.9-3.4-11.6ZM2 19h20v2H2v-2Z" />,
  ),

  // === image.toolkit.fluxcd.io ===
  // ImageRepository — picture frame (image scanner).
  ImageRepository: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M3 4h18v16H3V4Zm2 2v9l4-4 4 4 3-3 4 4V6H5Zm10 1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z"
    />,
  ),
  // ImagePolicy — frame with a check (policy decides the next image).
  ImagePolicy: filled(
    16,
    <>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M3 4h18v12H3V4Zm2 2v6l4-4 4 4 3-3 4 4V6H5Z"
      />
      <path d="M11 18h2v2h-2v-2Zm-3 0h2v2H8v-2Zm6 0h2v2h-2v-2Z" />
    </>,
  ),
  // Image with a refresh badge.
  ImageUpdateAutomation: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M2 3h12v10H2V3Zm2 2v5l2.5-2.5L9 10l1.5-1.5L12 10V5H4Z" />
      <g transform="translate(11.5 11) scale(.55)">
        <path d="M12 4V1L7 5l5 4V6a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" />
      </g>
    </>,
  ),

  // === notification.toolkit.fluxcd.io ===
  // Alert — exclamation in a triangle.
  Alert: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2 22 20H2L12 2Zm-1 6h2v6h-2V8Zm0 8h2v2h-2v-2Z"
    />,
  ),
  // Provider — broadcast tower with concentric waves.
  Provider: filled(
    16,
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M7.7 7.7 6.3 6.3a8 8 0 0 0 0 11.4l1.4-1.4a6 6 0 0 1 0-8.6Zm8.6 0a6 6 0 0 1 0 8.6l1.4 1.4a8 8 0 0 0 0-11.4l-1.4 1.4ZM4.9 4.9 3.5 3.5a12 12 0 0 0 0 17l1.4-1.4a10 10 0 0 1 0-14.2Zm14.2 0a10 10 0 0 1 0 14.2l1.4 1.4a12 12 0 0 0 0-17l-1.4 1.4Z" />
    </>,
  ),
  // Satellite dish — receives inbound webhooks.
  Receiver: filled(
    16,
    <>
      <path d="M3.5 8.5 15.5 20.5A8.5 8.5 0 0 1 3.5 8.5Z" />
      <path d="M9 14 15 8l1 1-6 6-1-1Z" />
      <circle cx="17" cy="7" r="2" />
    </>,
  ),

  // === snapshot.storage.k8s.io ===
  // VolumeSnapshot — disk + camera lens (point-in-time disk capture).
  VolumeSnapshot: filled(
    16,
    <>
      <path d="M12 2c4.4 0 8 1.3 8 3v6.5a6 6 0 0 0-7.8 8.5H12c-4.4 0-8-1.3-8-3V5c0-1.7 3.6-3 8-3Z" />
      <circle cx="17.5" cy="17.5" r="3.5" />
    </>,
  ),
  // VolumeSnapshotClass — disk + tag triangle (snapshot policy class).
  VolumeSnapshotClass: filled(
    16,
    <>
      <path d="M12 2c4.4 0 8 1.3 8 3v6.5l-2.4-2.4-6.5 6.5L12 17.5V19c-4.4 0-8-1.3-8-3V5c0-1.7 3.6-3 8-3Z" />
      <path d="m13.5 13.5 4-4h4v4l-4 4-4-4Zm5-1.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />
    </>,
  ),
  // VolumeSnapshotContent — disk + bytes (the underlying snapshot data).
  VolumeSnapshotContent: filled(
    16,
    <>
      <path d="M12 2c4.4 0 8 1.3 8 3v5h-2c-3.5 0-6 2.5-6 6v3c-4.4 0-8-1.3-8-3V5c0-1.7 3.6-3 8-3Z" />
      <path d="M14 13h8v8h-8v-8Zm2 2v1h1v-1h-1Zm3 0v1h1v-1h-1Zm-3 3v1h1v-1h-1Zm3 0v1h1v-1h-1Z" />
    </>,
  ),

  // === multicluster.x-k8s.io ===
  // ServiceExport — service ring with an outgoing arrow.
  ServiceExport: filled(
    16,
    <>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9 5a3 3 0 0 1 1 5.8V12h4a3 3 0 1 1-3 3H7a3 3 0 1 1-3-3h4v-1.2A3 3 0 0 1 9 5Z"
      />
      <path d="M16 4l5 4-5 4V9h-4V7h4V4Z" />
    </>,
  ),
  // ServiceImport — service ring with an incoming arrow.
  ServiceImport: filled(
    16,
    <>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M15 5a3 3 0 0 1 1 5.8V12h4a3 3 0 1 1-3 3h-4a3 3 0 1 1-3-3h4v-1.2A3 3 0 0 1 15 5Z"
      />
      <path d="M8 4v3H4v2h4v3l-5-4 5-4Z" />
    </>,
  ),

  // === argoproj.io ===
  // Application — app box with a corner indicator.
  Application: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M3 5h18v14H3V5Zm2 2v10h14V7H5Zm2 1h2v2H7V8Zm0 3h6v2H7v-2Zm0 3h4v2H7v-2Z"
    />,
  ),
  // ApplicationSet — three application boxes (a templated set).
  ApplicationSet: filled(
    16,
    <path d="M3 3h7v7H3V3Zm11 0h7v7h-7V3Zm-11 11h7v7H3v-7Zm11 0h7v7h-7v-7Zm2 2v3h3v-3h-3Z" />,
  ),
  // AppProject — folder holding an app card.
  AppProject: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M3 5h7l2 2h9v13H3V5Zm4 6v6h10v-6H7Zm2 2h6v2H9v-2Z" />,
  ),
  // Workflow — three connected nodes (a workflow DAG).
  Workflow: filled(
    16,
    <>
      <circle cx="5" cy="6" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="6" r="2" />
      <circle cx="5" cy="18" r="2" />
      <circle cx="19" cy="18" r="2" />
      <path d="M6.5 7l4.5 4-1.4 1.4L5 8 6.5 7Zm11 0L13 11.6 14.4 13l4.6-4.6L17.5 7Zm-7 7-4.5 3.5 1.2 1.5L13 14.6 11.5 14Zm3 0L18.4 18.5l1.2-1.5L14.5 13.5 13.5 14Z" />
    </>,
  ),
  // Rollout — wave (progressive rollout / canary curve).
  Rollout: filled(
    16,
    <path d="M2 13c0-3 2-5 4.5-5s4 5 6 5 4-5 6-5 3.5 2 3.5 5v3c0-3-1-4-2-4s-2 5-5 5-4-5-6-5-3 1-3 4v-3Z" />,
  ),

  // Three connected stages.
  Pipeline: filled(
    16,
    <path d="M2 9.5h5v5H2v-5Zm7.5 0h5v5h-5v-5Zm7.5 0h5v5h-5v-5ZM7 11.25h2.5v1.5H7v-1.5Zm7.5 0H17v1.5h-2.5v-1.5Z" />,
  ),
  // Stages followed by play.
  PipelineRun: filled(
    16,
    <path d="M2 9.5h5v5H2v-5Zm7 0h5v5H9v-5ZM7 11.25h2v1.5H7v-1.5Zm8.5-4.75L22 12l-6.5 5.5v-11Z" />,
  ),
  // Task — checkbox (a task is a unit of work).
  Task: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M4 4h16v16H4V4Zm6.5 11.5L7 12l1.4-1.4 2.1 2.1 4.5-4.5L16.4 9.6l-5.9 5.9Z"
    />,
  ),
  // TaskRun — task box + play triangle.
  TaskRun: filled(
    16,
    <>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M3 4h12v12H3V4Zm5 9 4-4-1.4-1.4L8 10.2 6.4 8.6 5 10l3 3Z"
      />
      <path d="M14 6l8 6-8 6V6Zm2 4v4l3-2-3-2Z" />
    </>,
  ),
  // ClusterTask — task box on a cluster scaffold.
  ClusterTask: filled(
    16,
    <>
      <circle cx="4" cy="4" r="2" />
      <circle cx="20" cy="4" r="2" />
      <circle cx="4" cy="20" r="2" />
      <circle cx="20" cy="20" r="2" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M7 7h10v10H7V7Zm4.7 7-2.4-2.4 1.4-1.4 1 1 2.6-2.6 1.4 1.4-4 4Z"
      />
    </>,
  ),

  // === velero.io ===
  // Backup — archive box with arrow up (back to storage).
  Backup: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M3 4h18v4H3V4Zm1 6h16v12H4V10Zm8 1.5L8.5 15H11v4h2v-4h2.5L12 11.5Z" />
    </>,
  ),
  // Restore — archive box with arrow down (out of storage).
  Restore: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M3 4h18v4H3V4Zm1 6h16v12H4V10Zm7 2v4H8.5l3.5 3.5 3.5-3.5H13v-4h-2Z" />
    </>,
  ),
  // Calendar — recurring schedule.
  Schedule: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M3 5h18v16H3V5Zm2 5v9h14v-9H5Z" />
      <path d="M7 2h2v5H7V2Zm8 0h2v5h-2V2ZM7 12h4v4H7v-4Z" />
    </>,
  ),
  // BackupStorageLocation — archive + pin marker.
  BackupStorageLocation: filled(
    16,
    <>
      <path d="M3 4h12v3H3V4Zm1 5h10v9H4V9Z" />
      <path d="M19 4a4 4 0 0 0-4 4c0 3 4 7 4 7s4-4 4-7a4 4 0 0 0-4-4Zm0 2.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z" />
    </>,
  ),
  // VolumeSnapshotLocation — disk + pin marker.
  VolumeSnapshotLocation: filled(
    16,
    <>
      <path d="M9 3c3.3 0 6 1.3 6 3v3.5c-3 .5-5 3-5 6.5 0 1 .2 2 .5 2.8C9.6 18.9 9.3 19 9 19c-3.3 0-6-1.3-6-3V6c0-1.7 2.7-3 6-3Z" />
      <path d="M18 11a4 4 0 0 0-4 4c0 3 4 7 4 7s4-4 4-7a4 4 0 0 0-4-4Zm0 2.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z" />
    </>,
  ),

  // Forking route — one host split across destinations.
  VirtualService: filled(
    16,
    <>
      <path d="M11 12h2v10h-2V12Z" />
      <g transform="rotate(-35 12 13)">
        <path d="M11 13V7H8.5L12 2.5 15.5 7H13v6h-2Z" />
      </g>
      <g transform="rotate(35 12 13)">
        <path d="M11 13V7H8.5L12 2.5 15.5 7H13v6h-2Z" />
      </g>
    </>,
  ),
  // DestinationRule — pin (where traffic lands).
  DestinationRule: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2a8 8 0 0 0-8 8c0 6 8 12 8 12s8-6 8-12a8 8 0 0 0-8-8Zm0 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z"
    />,
  ),
  // ServiceEntry — entry door (external service entrance).
  ServiceEntry: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M5 3h12v18H5V3Zm2 2v14h8V5H7Zm6 6v2h2v-2h-2Z"
    />,
  ),
  // Shield with a person — who may call what.
  AuthorizationPolicy: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2 4 5v6c0 5 3.5 9.4 8 11 4.5-1.6 8-6 8-11V5l-8-3Zm0 4.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4ZM8 16.5c0-2.2 1.8-3.8 4-3.8s4 1.6 4 3.8V17H8v-.5Z" />,
  ),
  // PeerAuthentication — two padlocks (mTLS between peers).
  PeerAuthentication: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M2 11V8a3.5 3.5 0 0 1 7 0v3h1.5v9h-10v-9H2Zm2 0h3V8a1.5 1.5 0 0 0-3 0v3Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M15 11V8a3.5 3.5 0 0 1 7 0v3h1.5v9h-10v-9H15Zm2 0h3V8a1.5 1.5 0 0 0-3 0v3Z" />
    </>,
  ),

  // === crossplane.io ===
  // Composition — three offset blocks (composing managed resources).
  Composition: filled(
    16,
    <path d="M3 3h8v8H3V3Zm6 6h8v8H9V9Zm6 6h6v6h-6v-6Z" />,
  ),
  // CompositeResourceDefinition — composition + frame.
  CompositeResourceDefinition: filled(
    16,
    <>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M3 3h18v18H3V3Zm2 2v14h14V5H5Z"
      />
      <path d="M7 7h4v4H7V7Zm6 4h4v4h-4v-4Z" />
    </>,
  ),

  // CiliumNetworkPolicy — shield with a 2×2 endpoint grid cut out.
  CiliumNetworkPolicy: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2 4 5v6c0 5 3.5 9.4 8 11 4.5-1.6 8-6 8-11V5l-8-3ZM8.5 7.5H11V10H8.5V7.5Zm4.5 0h2.5V10H13V7.5ZM8.5 12H11v2.5H8.5V12Zm4.5 0h2.5v2.5H13V12Z" />,
  ),
  // CiliumIdentity — ID badge.
  CiliumIdentity: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M3 5h18v14H3V5Zm5 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 0h5v2h-5V9Zm0 3h4v2h-4v-2ZM5 17c0-1.4 1.3-2.5 3-2.5s3 1.1 3 2.5v1H5v-1Z"
    />,
  ),
  // CiliumEndpoint — endpoint dot with surrounding wires.
  CiliumEndpoint: filled(
    16,
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="3" cy="3" r="2" />
      <circle cx="21" cy="3" r="2" />
      <circle cx="3" cy="21" r="2" />
      <circle cx="21" cy="21" r="2" />
      <path d="M5 5l5 5-1.5 1.5L4 7l1-2Zm14 0l-5 5 1.5 1.5L20 7l-1-2ZM5 19l5-5-1.5-1.5L4 17l1 2Zm14 0l-5-5 1.5-1.5L20 17l-1 2Z" />
    </>,
  ),

  // DatabaseInstance — stack of discs.
  DatabaseInstance: filled(
    16,
    <path d="M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3Zm-8 5.2c1.7 1.3 4.8 2 8 2s6.3-.7 8-2V11c0 1.7-3.6 3-8 3s-8-1.3-8-3V8.2Zm0 5c1.7 1.3 4.8 2 8 2s6.3-.7 8-2V16c0 1.7-3.6 3-8 3s-8-1.3-8-3v-2.8Zm0 5c1.7 1.3 4.8 2 8 2s6.3-.7 8-2V19c0 1.7-3.6 3-8 3s-8-1.3-8-3v-.8Z" />,
  ),
  // === Kyverno (kyverno.io / policies.kyverno.io / reports.kyverno.io / wgpolicyk8s.io) ===
  // Report — document with bar-chart inside.
  Report: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M5 2h11l4 4v16H5V2Zm10 1.5V7h3.5L15 3.5ZM8 17v-2h2v2H8Zm3 0v-5h2v5h-2Zm3 0v-7h2v7h-2Z"
    />,
  ),
  // PolicyReport — clipboard with check (a policy compliance report).
  PolicyReport: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M9 2h6v2h3v18H6V4h3V2Zm0 2v1h6V4H9Zm-1 8 1.4-1.4 2.1 2.1 4.5-4.5L17.4 9.6 11.5 15.5 8 12Z"
    />,
  ),
  // PolicyException — shield with a minus (an exception waives a rule).
  PolicyException: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2 4 5v6c0 5 3.5 9.4 8 11 4.5-1.6 8-6 8-11V5l-8-3Zm-4 9h8v2H8v-2Z"
    />,
  ),
  // Broom — sweeps matching objects away.
  CleanupPolicy: filled(
    16,
    <>
      <path d="M11 2h2v8h-2V2ZM8 10h8v2.5H8V10Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M7 13h10l2.5 9h-15L7 13Zm2.2 3.5.2 4h1.4l-.1-4H9.2Zm4.3 0-.1 4h1.4l.2-4h-1.5Z" />
    </>,
  ),
  // EphemeralReport — clipboard with a clock face.
  EphemeralReport: filled(
    16,
    <>
      <path d="M9 2h6v2h3v9.5a6 6 0 0 0-7.5 7.5H6V4h3V2Zm0 2v1h6V4H9Z" />
      <path d="M16.5 13a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm-.5 1.5v3l2.2 1.3.5-.9-1.7-1V14.5h-1Z" />
    </>,
  ),

  // === RabbitMQ (rabbitmq.com) ===
  // Queue — stacked items waiting in line.
  Queue: filled(
    16,
    <path d="M4 4h16v3H4V4Zm0 5h12v3H4V9Zm0 5h8v3H4v-3Zm0 5h4v3H4v-3Z" />,
  ),
  // Exchange — one input fanned out to several queues.
  Exchange: filled(
    16,
    <path d="M2 11h10v2H2v-2Zm10-6.5h2v15h-2v-15ZM14 4h4V2l4 3-4 3V6h-4V4Zm0 7h4V9l4 3-4 3v-2h-4v-2Zm0 7h4v-2l4 3-4 3v-2h-4v-2Z" />,
  ),
  // Binding — chain link.
  Binding: filled(
    16,
    <path d="M9 6h2v2h-1a3 3 0 1 0 0 6h1v2H10A5 5 0 0 1 10 6Zm5 0h2A5 5 0 0 1 16 16h-2v-2h1a3 3 0 1 0 0-6h-1V6Zm-5 4h6v2H9v-2Z" />,
  ),
  // Globe — global / host-wide scope.
  Globe: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 0a4.5 10 0 1 0 0 20 4.5 10 0 0 0 0-20Zm0 1.5a3 8.5 0 1 0 0 17 3 8.5 0 0 0 0-17ZM2 11.25h5.4v1.5H2v-1.5Zm14.6 0H22v1.5h-5.4v-1.5Zm-7.5 0h5.8v1.5H9.1v-1.5Z" />,
  ),
  // User — single person silhouette (rabbitmq users, generic identity).
  User: filled(
    16,
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7v1H4v-1z" />
    </>,
  ),
  // Permission — horizontal key.
  Permission: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M8 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Z" />
      <path d="M11.5 11H22v2h-2v3h-2v-3h-2v3h-2v-3h-2.5v-2Z" />
    </>,
  ),
  // Federation — multi-cluster connected.
  Federation: filled(
    16,
    <>
      <circle cx="12" cy="3" r="2.5" />
      <circle cx="3" cy="18" r="2.5" />
      <circle cx="21" cy="18" r="2.5" />
      <circle cx="12" cy="13" r="2.5" />
      <path d="M11 6h2v5h-2V6ZM11.4 14.5l-7 4 1 1.7 7-4-1-1.7Zm1.2 0 7 4-1 1.7-7-4 1-1.7Z" />
    </>,
  ),
  // Shovel — grip, shaft and pointed blade.
  Shovel: filled(
    16,
    <path d="M8.5 2h7v2.5H13V12h-2V4.5H8.5V2ZM7 12h10v4.5L12 22l-5-5.5V12Z" />,
  ),
  // Parallel streams.
  SuperStream: filled(
    16,
    <path d="M2 4h13V2l5 3-5 3V6H2V4Zm2 7h13V9l5 3-5 3v-2H4v-2Zm-2 7h11v-2l5 3-5 3v-2H2v-2Z" />,
  ),
  // RabbitmqCluster — cluster of three queue stacks.
  RabbitmqCluster: filled(
    16,
    <path d="M2 4h6v3H2V4Zm0 5h6v3H2V9Zm0 5h6v3H2v-3Zm7-10h6v3H9V4Zm0 5h6v3H9V9Zm0 5h6v3H9v-3Zm7-10h6v3h-6V4Zm0 5h6v3h-6V9Zm0 5h6v3h-6v-3Z" />,
  ),

  // Funnel with traffic dropping in.
  EnvoyFilter: filled(
    16,
    <>
      <path d="M3 8h18v2.5l-7 6.5V22l-4-2v-3L3 10.5V8Z" />
      <circle cx="7" cy="4.5" r="1.5" />
      <circle cx="12" cy="3.5" r="1.5" />
      <circle cx="17" cy="4.5" r="1.5" />
    </>,
  ),
  // Sidecar — main pod with a smaller adjacent pod (sidecar).
  Sidecar: filled(
    16,
    <>
      <path d="M9 4 3 7v8l6 3 6-3V7L9 4Zm0 1.7 4.4 2.5L9 10.7 4.6 8.2 9 5.7Zm-4.5 4 4 2.2v5.4l-4-2.2v-5.4Zm5.5 7.6v-5.4l4-2.2v3.7a4 4 0 0 0-3.5 4 4 4 0 0 0 .1 1l-.6-.3-1-.8Z" />
      <circle cx="17.5" cy="17.5" r="3.5" />
    </>,
  ),
  // Telemetry — chart bars + radar dot.
  Telemetry: filled(
    16,
    <>
      <path d="M3 17h2v4H3v-4Zm4-3h2v7H7v-7Zm4-4h2v11h-2V10Zm4-3h2v14h-2V7Zm4 6h2v8h-2v-8Z" />
      <circle cx="20" cy="4" r="2.5" />
    </>,
  ),
  // WasmPlugin — puzzle piece.
  WasmPlugin: filled(
    16,
    <path d="M3 5h6v2a1.5 1.5 0 1 0 3 0V5h6v6h-2a1.5 1.5 0 1 0 0 3h2v6h-6v-2a1.5 1.5 0 1 0-3 0v2H3v-6h2a1.5 1.5 0 1 0 0-3H3V5Z" />,
  ),
  // Traffic passing through a configured box.
  ProxyConfig: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M8.5 6h7v12h-7V6Zm2 3v1.5h3V9h-3Zm0 4.5V15h3v-1.5h-3Z" />
      <path d="M1.5 11H5V8.5L8 12l-3 3.5V13H1.5v-2Zm14.5 0h3.5V8.5l3 3.5-3 3.5V13H16v-2Z" />
    </>,
  ),
  // WorkloadEntry — pod hex with an outward arrow (external workload).
  WorkloadEntry: filled(
    16,
    <>
      <path d="M9 4 3 7v8l6 3 6-3V7L9 4Zm0 1.7 4.4 2.5L9 10.7 4.6 8.2 9 5.7Zm-4.5 4 4 2.2v5.4l-4-2.2v-5.4Zm5.5 7.6v-5.4l4-2.2v5.4l-4 2.2Z" />
      <path d="M17 8l5 4-5 4v-3h-3v-2h3V8Z" />
    </>,
  ),
  // WorkloadGroup — multiple pod hexes (a group of workloads).
  WorkloadGroup: filled(
    16,
    <path d="M6 2 2 4.5v5L6 12l4-2.5v-5L6 2Zm12 0-4 2.5v5l4 2.5 4-2.5v-5L18 2Zm-6 10-4 2.5v5l4 2.5 4-2.5v-5L12 12Z" />,
  ),

  // === VictoriaMetrics (operator.victoriametrics.com) ===
  // Generic VM kinds — V-shaped flame to read as the VictoriaMetrics ecosystem.
  VictoriaMetrics: filled(
    16,
    <path d="M3 4h4l5 12 5-12h4L13 22h-2L3 4Z" />,
  ),
  // VMCluster — V-shape over a cluster.
  VMCluster: filled(
    16,
    <>
      <path d="M3 2h3l3 7 3-7h3l-4.5 10h-3L3 2Z" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="12" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M8 17h2v2H8v-2Zm6 0h2v2h-2v-2Z" />
    </>,
  ),
  // VMSingle — V-shape with a single dot.
  VMSingle: filled(
    16,
    <>
      <path d="M3 2h3l3 7 3-7h3l-4.5 10h-3L3 2Z" />
      <circle cx="12" cy="18" r="3" />
    </>,
  ),
  // VMAnomaly — V-shape with a warning chart spike.
  VMAnomaly: filled(
    16,
    <>
      <path d="M3 2h3l3 7 3-7h3l-4.5 10h-3L3 2Z" />
      <path d="M2 21l5-7 3 4 3-5 5 8H2Z" />
    </>,
  ),

  // Endpoint — bullseye.
  Endpoint: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4a6 6 0 1 1 0 12 6 6 0 0 1 0-12Zm0 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />,
  ),
  // Listener — speaker / inbound antenna.
  Listener: filled(
    16,
    <path d="M3 9h4l6-5v16l-6-5H3V9Zm14 3a4 4 0 0 0-2-3.5v7a4 4 0 0 0 2-3.5Zm0-7v2.6a6 6 0 0 1 0 8.8V19a8 8 0 0 0 0-14Z" />,
  ),
  // EnvoyCluster — proxy cluster (cluster shape with a small E mark).
  EnvoyCluster: filled(
    16,
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M9 9h6v2h-4v1h3v2h-3v1h4v2H9V9Z"
      />
    </>,
  ),
  // TLSSecret — secret padlock with a small certificate seal corner.
  TLSSecret: filled(
    16,
    <>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M7 11V8a5 5 0 0 1 10 0v3h2v11H5V11h2Zm2 0h6V8a3 3 0 0 0-6 0v3Z"
      />
      <circle cx="19" cy="5" r="3" />
    </>,
  ),

  // Cloud with a check — a provider-managed certificate.
  ManagedCertificate: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M7 19a5 5 0 0 1-.9-9.9A6.5 6.5 0 0 1 18.6 9.5 4.8 4.8 0 0 1 18 19H7Zm1.8-5.3L10 12.5l1.2 1.2 3-3 1.2 1.2-4.2 4.2-2.4-2.4Z" />,
  ),
  // Backend server with tuning sliders.
  BackendConfig: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M3 3h18v7H3V3Zm2.5 2.5v2h2v-2h-2Zm4 0v2h2v-2h-2Z" />
      <path d="M3 13.25h18v1.5H3v-1.5Zm0 5h18v1.5H3v-1.5Z" />
      <circle cx="8" cy="14" r="2.2" />
      <circle cx="16" cy="19" r="2.2" />
    </>,
  ),
  // FrontendConfig — front panel with controls.
  FrontendConfig: filled(
    16,
    <>
      <path d="M3 4h18v16H3V4Zm2 2v12h14V6H5Zm2 2h2v6H7V8Zm4 0h2v6h-2V8Zm4 0h2v6h-2V8Z" />
    </>,
  ),
  // Allowlist — checklist.
  Allowlist: filled(
    16,
    <path d="M1.8 6 3.1 4.7 4.6 6.2 7.6 3.2 8.9 4.5 4.6 8.8 1.8 6Zm8.2-1.25h11v2.5H10v-2.5ZM1.8 12l1.3-1.3 1.5 1.5 3-3 1.3 1.3-4.3 4.3L1.8 12Zm8.2-1.25h11v2.5H10v-2.5ZM1.8 18l1.3-1.3 1.5 1.5 3-3 1.3 1.3-4.3 4.3L1.8 18Zm8.2-1.25h11v2.5H10v-2.5Z" />,
  ),
  // ComputeClass — CPU chip silhouette.
  ComputeClass: filled(
    16,
    <path d="M9 2v2H6a2 2 0 0 0-2 2v3H2v2h2v2H2v2h2v3a2 2 0 0 0 2 2h3v2h2v-2h2v2h2v-2h3a2 2 0 0 0 2-2v-3h2v-2h-2v-2h2V9h-2V6a2 2 0 0 0-2-2h-3V2h-2v2h-2V2h-2Zm-1 6h8v8H8V8Z" />,
  ),
  // ProvisioningRequest — request arrow with a clock.
  ProvisioningRequest: filled(
    16,
    <>
      <path d="M3 11h12l-3-3 1.4-1.4L19.8 12l-5.4 5.4L13 16l3-3H3v-2Z" />
      <circle cx="19" cy="5" r="3" />
    </>,
  ),
  // Membership — two people.
  Membership: filled(
    16,
    <>
      <circle cx="9" cy="8" r="3.5" />
      <circle cx="17.5" cy="9" r="2.5" />
      <path d="M2 21c0-3.5 3-6 7-6s7 2.5 7 6v1H2v-1Zm15.5-7c2.5 0 4.5 2 4.5 4.8V21h-4.2c0-2.7-1-4.8-2.6-6.3.7-.4 1.5-.7 2.3-.7Z" />
    </>,
  ),
  // Audit — document with an eye.
  Audit: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M5 2h10l4 4v16H5V2Zm7 9c-3 0-5 3-5 3s2 3 5 3 5-3 5-3-2-3-5-3Zm0 1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" />,
  ),
  // Topology — graph with nodes and edges.
  Topology: filled(
    16,
    <>
      <circle cx="4" cy="4" r="2.5" />
      <circle cx="20" cy="4" r="2.5" />
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="4" cy="20" r="2.5" />
      <circle cx="20" cy="20" r="2.5" />
      <path d="M5.5 5.5l5 5-1 1-5-5 1-1Zm13 0-5 5 1 1 5-5-1-1ZM5.5 18.5l5-5 1 1-5 5-1-1Zm13 0-5-5-1 1 5 5 1-1Z" />
    </>,
  ),

  // VaultSecret — safe with a dial and hinge.
  VaultSecret: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M3 4h18v15H3V4Zm10 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm0 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM5.5 9H7v5H5.5V9Z" />
      <path d="M5 19h3v2H5v-2Zm11 0h3v2h-3v-2Z" />
    </>,
  ),
  // ──────────────────────────────────────────────────────────────────────
  // Generic-word glyphs — universal concepts that appear in CRD names
  // across many vendors (catalog, failover, quorum, subscription, …).
  // The token heuristic in iconResolve.ts maps these to arbitrary CRDs.
  // ──────────────────────────────────────────────────────────────────────

  // Folder — generic folder silhouette (workspace, namespace-like grouping).
  Folder: filled(
    16,
    <path d="M3 5h7l2 2h9v13H3V5Z" />,
  ),
  // Catalog — open book with bookmark.
  Catalog: filled(
    16,
    <path d="M2 4h8a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H2V4Zm12 0h8v14h-8a2 2 0 0 0-2 2V6a2 2 0 0 1 2-2Zm2 2v8l2-1.5L20 14V6h-4Z" />,
  ),
  // Failover — circular swap arrows.
  Failover: filled(
    16,
    <path d="M5 6h6V4l5 4-5 4v-2H5V6Zm14 12h-6v2l-5-4 5-4v2h6v4Z" />,
  ),
  // Quorum — three connected nodes (consensus triangle).
  Quorum: filled(
    16,
    <>
      <circle cx="12" cy="4" r="2.5" />
      <circle cx="4" cy="18" r="2.5" />
      <circle cx="20" cy="18" r="2.5" />
      <path d="M11 6 5 17l-1.7-1L9.3 5 11 6Zm2 0 6 11 1.7-1L14.7 5 13 6ZM6 17h12v2H6v-2Z" />
    </>,
  ),
  // Subscription — bell with a feed-arc.
  Subscription: filled(
    16,
    <>
      <path d="M11 2a6 6 0 0 0-6 6v5l-2 3v1h13.5a4.5 4.5 0 0 1 2-3.6V8a6 6 0 0 0-6-6h-1.5Zm-2 17a2 2 0 1 0 4 0H9Z" />
      <path d="M16 11.5a4.5 4.5 0 0 1 4.5 4.5h1.5a6 6 0 0 0-6-6v1.5Zm0 3a1.5 1.5 0 0 1 1.5 1.5H19a3 3 0 0 0-3-3v1.5Z" />
    </>,
  ),
  // Topic — speech bubble with a hash.
  Topic: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M3 4h18v13H8l-4 4v-4H3V4Zm6.5 2.5V8.5H7V10h2.5v1H7v1.5h2.5v2H11v-2h2v2h1.5v-2H17V11h-2.5v-1H17V8.5h-2.5v-2H13v2h-2v-2H9.5ZM11 10h2v1h-2v-1Z" />,
  ),
  // Pipe with flow chevrons.
  Channel: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M6 7h12a5 5 0 0 1 0 10H6A5 5 0 0 1 6 7Zm1 2.5L9.5 12 7 14.5h2l2.5-2.5L9 9.5H7Zm5 0 2.5 2.5-2.5 2.5h2l2.5-2.5L14 9.5h-2Z" />,
  ),
  // Tenant — multi-floor building.
  Tenant: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M5 2h14v20h-6v-4h-2v4H5V2Zm2 2v2h2V4H7Zm4 0v2h2V4h-2Zm4 0v2h2V4h-2ZM7 8v2h2V8H7Zm4 0v2h2V8h-2Zm4 0v2h2V8h-2ZM7 12v2h2v-2H7Zm4 0v2h2v-2h-2Zm4 0v2h2v-2h-2ZM7 16v2h2v-2H7Zm8 0v2h2v-2h-2Z"
    />,
  ),
  // Environment — globe with horizontal bands.
  Environment: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm-8 10a8 8 0 0 1 .6-3h14.8a8 8 0 0 1 0 6H4.6a8 8 0 0 1-.6-3Zm2-5h12a8 8 0 0 0-12 0Zm0 10a8 8 0 0 0 12 0H6Z"
    />,
  ),
  // Template — paper with folded corner and grid lines.
  Template: filled(
    16,
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M5 2h11l4 4v16H5V2Zm10 1.5V7h3.5L15 3.5ZM7 9h4v2H7V9Zm6 0h5v2h-5V9Zm-6 4h4v2H7v-2Zm6 0h5v2h-5v-2Zm-6 4h4v2H7v-2Zm6 0h5v2h-5v-2Z"
    />,
  ),
  // Model — faceted diamond.
  Model: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2 22 12 12 22 2 12 12 2Zm0 4-6 6 6 6 6-6-6-6Zm0 2.5 3.5 3.5-3.5 3.5L8.5 12 12 8.5Z" />,
  ),
  // Lattice of connected nodes.
  Mesh: filled(
    16,
    <>
      <path d="M4 11.25h16v1.5H4v-1.5Zm0-8h16v1.5H4v-1.5Zm0 16h16v1.5H4v-1.5ZM3.25 4h1.5v16h-1.5V4Zm8 0h1.5v16h-1.5V4Zm8 0h1.5v16h-1.5V4Z" />
      <circle cx="4" cy="4" r="2.2" />
      <circle cx="12" cy="4" r="2.2" />
      <circle cx="20" cy="4" r="2.2" />
      <circle cx="4" cy="12" r="2.2" />
      <circle cx="12" cy="12" r="2.2" />
      <circle cx="20" cy="12" r="2.2" />
      <circle cx="4" cy="20" r="2.2" />
      <circle cx="12" cy="20" r="2.2" />
      <circle cx="20" cy="20" r="2.2" />
    </>,
  ),
  // LoadBalancer — balance scales.
  LoadBalancer: filled(
    16,
    <path d="M11 2h2v3h7v2h-2.5l3 7H23a4 4 0 0 1-8 0h2.5l3-7H13v14h3v2H8v-2h3V7H4.5l3 7H10a4 4 0 0 1-8 0h2.5l3-7H4V5h7V2Z" />,
  ),
  // Box moving into a new box.
  Migration: filled(
    16,
    <>
      <path d="M2 8h6v8H2V8Z" />
      <path d="M9 11h2.5V8.5L15 12l-3.5 3.5V13H9v-2Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M16.5 7H22v10h-5.5V7Zm1.5 1.5v7h2.5v-7H18Z" />
    </>,
  ),
  // Gift box — several things packaged as one.
  Bundle: filled(
    16,
    <>
      <path d="M3 8h8v4H3V8Zm10 0h8v4h-8V8ZM4 13.5h7V21H4v-7.5Zm9 0h7V21h-7v-7.5Z" />
      <ellipse cx="9" cy="5.3" rx="3" ry="1.7" transform="rotate(20 9 5.3)" />
      <ellipse cx="15" cy="5.3" rx="3" ry="1.7" transform="rotate(-20 15 5.3)" />
    </>,
  ),
  // Dashboard — uneven panel grid.
  Dashboard: filled(
    16,
    <path d="M3 3h8v10H3V3Zm10 0h8v6h-8V3ZM3 15h8v6H3v-6Zm10-4h8v10h-8V11Z" />,
  ),
  // Trace — timeline with span dots.
  Trace: filled(
    16,
    <>
      <path d="M2 11h20v2H2v-2Z" />
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="12" cy="12" r="2.5" />
      <circle cx="19" cy="12" r="2.5" />
      <path d="M3 16h6v2H3v-2Zm6-12h8v2H9V4Zm5 12h7v2h-7v-2Z" />
    </>,
  ),
  // Pool — cloud of dots (a pool of resources).
  Pool: filled(
    16,
    <>
      <circle cx="6" cy="7" r="2.5" />
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <circle cx="5" cy="14" r="2.5" />
      <circle cx="11" cy="13" r="2.5" />
      <circle cx="18" cy="15" r="2.5" />
      <circle cx="8" cy="20" r="2.5" />
      <circle cx="15" cy="20" r="2.5" />
    </>,
  ),
  // Leader — crown silhouette.
  Leader: filled(
    16,
    <path d="M3 6 6 12 9 7l3 5 3-5 3 5 3-6v12H3V6Zm2 12h14v2H5v-2Z" />,
  ),
  // Globe with a location pin.
  Region: filled(
    16,
    <>
      <g transform="translate(-.5 -.5) scale(.68)">
        <path fillRule="evenodd" clipRule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 0a4.5 10 0 1 0 0 20 4.5 10 0 0 0 0-20Zm0 1.5a3 8.5 0 1 0 0 17 3 8.5 0 0 0 0-17ZM2 11.25h5.4v1.5H2v-1.5Zm14.6 0H22v1.5h-5.4v-1.5Zm-7.5 0h5.8v1.5H9.1v-1.5Z" />
      </g>
      <path d="M18 11a4 4 0 0 0-4 4c0 3 4 7 4 7s4-4 4-7a4 4 0 0 0-4-4Zm0 2.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z" />
    </>,
  ),
  // Plug — an add-on that slots into the cluster.
  Addon: filled(
    16,
    <path d="M8 2h2v6H8V2Zm6 0h2v6h-2V2ZM6 8h12v4a6 6 0 0 1-12 0V8Zm5 10h2v4h-2v-4Z" />,
  ),
  // FunctionGlyph — curly braces (the universal "function" sigil).
  FunctionGlyph: filled(
    16,
    <path d="M9 3v2H7a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2v2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h2v-2H7v-3a4 4 0 0 0-1.5-3.1A4 4 0 0 0 7 9V6h2V3Zm6 0v2h2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2v2a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-2v-2h2v-3a4 4 0 0 1 1.5-3.1A4 4 0 0 1 17 9V6h-2V3Z" />,
  ),
  // Broker — hub fanning out to four spokes.
  Broker: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2.6a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Z" />
      <path d="M4 11h4v2H4v-2Zm12 0h4v2h-4v-2ZM11 4h2v4h-2V4Zm0 12h2v4h-2v-4Z" />
      <circle cx="3" cy="12" r="2" />
      <circle cx="21" cy="12" r="2" />
      <circle cx="12" cy="3" r="2" />
      <circle cx="12" cy="21" r="2" />
    </>,
  ),
  // Bolt in a badge — fires on an event.
  Trigger: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M5 2h14a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Zm8 3-6 8h4l-1 6 6-8h-4l1-6Z" />,
  ),
  // Sink — funnel into a basin (a generic event sink).
  Sink: filled(
    16,
    <>
      <path d="M3 4h18v3l-7 7v6l-4-2v-4L3 7V4Z" />
      <path d="M3 19h18v2H3v-2Z" />
    </>,
  ),
  // Source — origin dot emitting to the right.
  Source: filled(
    16,
    <>
      <path d="M6 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" />
      <path d="M11 11h6.5V7.5L22 12l-4.5 4.5V13H11v-2Z" />
    </>,
  ),
  // CatalogSource — catalog book feeding downward.
  CatalogSource: filled(
    16,
    <>
      <g transform="translate(0 -2) scale(.75)">
        <path d="M2 4h8a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H2V4Zm12 0h8v14h-8a2 2 0 0 0-2 2V6a2 2 0 0 1 2-2Zm2 2v8l2-1.5L20 14V6h-4Z" />
      </g>
      <path d="M17 14h3v4h2.5l-4 4.5-4-4.5H17v-4Z" />
    </>,
  ),
  // ImageCatalog — picture frame stacked with an index card.
  ImageCatalog: filled(
    16,
    <>
      <path d="M3 3h13v11H3V3Zm2 2v6l3-3 2 2 2-2 3 3V5H5Zm9 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z" />
      <path d="M7 17h14v4H7v-4Zm2 1v2h10v-2H9Z" />
    </>,
  ),
  // InstallPlan — checklist with arrow.
  InstallPlan: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M5 2h11l3 3v17H5V2Zm2 7 1.4-1.4 2.1 2.1 4.5-4.5L16.4 6.6 10.5 12.5 7 9Zm0 6h10v2H7v-2Zm0 4h7v2H7v-2Z" />,
  ),
  // Version tag.
  ClusterServiceVersion: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M3 3h8.5l9.5 9.5-8.5 8.5L3 11.5V3Zm4.5 2.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />,
  ),
  // Cloud — provider-managed resource.
  Cloud: filled(
    16,
    <path d="M7 19a5 5 0 0 1-.9-9.9A6.5 6.5 0 0 1 18.6 9.5 4.8 4.8 0 0 1 18 19H7Z" />,
  ),
  // Scale — a box with expand arrows (autoscaling target).
  Scale: filled(
    16,
    <>
      <path d="M9 9h6v6H9V9Z" />
      <path d="M14 2h8v8l-3-3-3 3-2-2 3-3-3-3Z" />
      <path d="M10 22H2v-8l3 3 3-3 2 2-3 3 3 3Z" />
    </>,
  ),
  // Job with an up arrow — jobs spawned by load.
  ScaledJob: filled(
    16,
    <>
      <g transform="translate(-1.5 3) scale(.75)">
        <path d="M8 3h8l1 2h3v17H4V5h3l1-2Zm2.2 11.6-2.8-2.8L6 13.2l4.2 4.2L18 9.6 16.6 8l-6.4 6.6Z" />
      </g>
      <path d="M18 4l4 4.5h-2.5V20h-3V8.5H14L18 4Z" />
    </>,
  ),
  // Syringe — injected instrumentation.
  Syringe: filled(
    16,
    <g transform="rotate(45 12 12)">
        <path fillRule="evenodd" clipRule="evenodd" d="M8 1h8v2h-3v2h-2V3H8V1Zm0 5h8v11H8V6Zm2 2v5h4V8h-4Zm0 9h4v1.5h-4V17Zm1.25 1.5h1.5V23h-1.5v-4.5Z" />
      </g>,
  ),
  // Bridge — deck on an arch.
  Bridge: filled(
    16,
    <path d="M1 7h22v2.5H1V7Zm2 3.5h18V20h-3.5v-2.5a5.5 5.5 0 0 0-11 0V20H3v-9.5Z" />,
  ),
  // Battery — reserved headroom.
  Battery: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M2 6h17v12H2V6Zm2 2v8h13V8H4Zm1.5 1.5h6v5h-6v-5Z" />
      <path d="M19.5 9.5H22v5h-2.5v-5Z" />
    </>,
  ),
  // Lock with an incoming arrow — secret synced from an external store.
  ExternalSecret: filled(
    16,
    <>
      <g transform="translate(6 3) scale(.75)">
        <path fillRule="evenodd" clipRule="evenodd" d="M7 10V7a5 5 0 0 1 10 0v3h2v12H5V10h2Zm2 0h6V7a3 3 0 0 0-6 0v3Zm2 5v3h2v-3h-2Z" />
      </g>
      <path d="M1 11h4.5V8.5L9 12l-3.5 3.5V13H1v-2Z" />
    </>,
  ),
  // Envelope with a wax seal — encrypted secret.
  SealedSecret: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M2 4h20v16H2V4Zm2 2 8 6 8-6H4Zm12 3.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 1.2a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6Z" />,
  ),
  // Monitor with a guest inside — a virtual machine.
  VirtualMachine: filled(
    16,
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M2 3h20v14H2V3Zm2 2v10h16V5H4Zm5 2.5h6v5H9v-5Z" />
      <path d="M9 17h6v2h3v2H6v-2h3v-2Z" />
    </>,
  ),
  // Three stacked nodes — a pool that grows and shrinks.
  NodePool: filled(
    16,
    <path fillRule="evenodd" clipRule="evenodd" d="M3 2h18v5.5H3V2Zm2 1.75v2h2v-2H5ZM3 9.25h18v5.5H3v-5.5ZM5 11v2h2v-2H5Zm-2 5.5h18V22H3v-5.5Zm2 1.75v2h2v-2H5Z" />,
  ),
};
