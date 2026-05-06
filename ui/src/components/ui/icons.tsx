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
  access: filled(
    16,
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7v1H4v-1z" />
    </>,
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
      <rect x="2" y="6" width="6" height="12" rx="1.5" />
      <rect x="16" y="6" width="6" height="12" rx="1.5" />
      <path d="M8 10h6.6l-1.8-1.8 1.4-1.4L18.4 11l-4.2 4.2-1.4-1.4L14.6 12H8z" />
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
  // Node + pod action glyphs. Two-tone variants (status accents on top of
  // the neutral kind silhouette) — child fills override the SVG-level
  // `currentColor` so the action chip reads at a glance.
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
  podDrain: filled(
    16,
    <>
      <path
        fill="#F3F4F6"
        d="M8 2 3.5 4.6v5.2L8 12.4l4.5-2.6V4.6L8 2Zm0 1.7 2.8 1.6L8 6.9 5.2 5.3 8 3.7Zm-3 2.9 2.2 1.3v3L5 9.6v-3Zm4.2 4.3v-3l2.3-1.3v3l-2.3 1.3Z"
      />
      <rect x="4" y="14" width="3" height="3" rx="0.5" fill="#F59E0B" />
      <rect x="8" y="14" width="3" height="3" rx="0.5" fill="#F59E0B" />
      <rect x="4" y="18" width="3" height="3" rx="0.5" fill="#F59E0B" />
      <rect x="8" y="18" width="3" height="3" rx="0.5" fill="#F59E0B" />
      <path fill="#F59E0B" d="M14 16h4v-2l5 4-5 4v-2h-4v-4Z" />
    </>,
  ),
  // Apps — package box with a small "+" cap. Used as the category-rail icon
  // for the Apps section (Helm releases today, Argo / Flux later).
  apps: filled(
    16,
    <path d="M12 2 3 6.5 12 11l9-4.5L12 2Zm-9 6 9 4.5V22l-9-4.5V8Zm18 0v9.5L13 22V12.5L21 8Z" />,
  ),
  // Cancel an in-progress drain on a node — same node-bars-and-dots base as
  // cordon/uncordon, with a red filled square (stop) accent.
  nodeDrainStop: filled(
    16,
    <>
      <rect x="3" y="4" width="12" height="5" rx="1.2" fill="#F3F4F6" />
      <rect x="3" y="11" width="12" height="5" rx="1.2" fill="#F3F4F6" />
      <circle cx="12.5" cy="6.5" r="0.9" fill="#111827" />
      <circle cx="10.2" cy="6.5" r="0.9" fill="#111827" />
      <circle cx="12.5" cy="13.5" r="0.9" fill="#111827" />
      <circle cx="10.2" cy="13.5" r="0.9" fill="#111827" />
      <circle cx="18.5" cy="13.5" r="4.5" fill="#EF4444" />
      <rect
        x="16.4"
        y="11.4"
        width="4.2"
        height="4.2"
        rx="0.6"
        fill="white"
      />
    </>,
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
  Deployment: filled(
    16,
    <path d="M12 4a8 8 0 0 1 7.4 5h-2.3A5.9 5.9 0 0 0 7.5 7.5L10 10H4V4l2.1 2.1A8 8 0 0 1 12 4Zm8 10v6l-2.1-2.1A8 8 0 0 1 4.6 15h2.3a5.9 5.9 0 0 0 9.6 1.5L14 14h6Z" />,
  ),
  ReplicaSet: filled(
    16,
    <path d="M5 4h9v9H5V4Zm5 7h9v9h-9v-9Zm-3 4h2v-2H7v2Zm8-8h2v2h-2V7Z" />,
  ),
  StatefulSet: filled(
    16,
    <path d="M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3Zm-8 5.2c1.7 1.3 4.8 2 8 2s6.3-.7 8-2V11c0 1.7-3.6 3-8 3s-8-1.3-8-3V8.2Zm0 5c1.7 1.3 4.8 2 8 2s6.3-.7 8-2V16c0 1.7-3.6 3-8 3s-8-1.3-8-3v-2.8Zm0 5c1.7 1.3 4.8 2 8 2s6.3-.7 8-2V19c0 1.7-3.6 3-8 3s-8-1.3-8-3v-.8Z" />,
  ),
  DaemonSet: filled(
    16,
    <path d="M11 2h2v3h3a4 4 0 0 1 4 4v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9a4 4 0 0 1 4-4h3V2Zm-3 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm8 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-6 6v2h4v-2h-4ZM2 10h2v4H2v-4Zm18 0h2v4h-2v-4Z" />,
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
    <path d="M6 5a4 4 0 0 1 3.5 2.1l5.1-1.7A3.5 3.5 0 1 1 15.3 8l-5.1 1.7v4.6l5.1 1.7a3.5 3.5 0 1 1-.7 2.6l-5.1-1.7A4 4 0 1 1 6 5Z" />,
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
    <path d="M12 2 21 7v10l-9 5-9-5V7l9-5Zm4.8 13.2A6 6 0 1 1 16.8 8l-1.7 1.2A3.8 3.8 0 1 0 15.1 14l1.7 1.2Z" />,
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
    <path d="M7 10V7a5 5 0 0 1 10 0v3h2v12H5V10h2Zm2 0h6V7a3 3 0 0 0-6 0v3Zm2 5v3h2v-3h-2Z" />,
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
    <path d="M12 2 20 5v7c0 4.4-3.2 8.3-8 10-4.8-1.7-8-5.6-8-10V5l8-3Zm0 4 1.5 3 3.3.5-2.4 2.3.6 3.2-3-1.5L9 15l.6-3.2-2.4-2.3 3.3-.5L12 6Z" />,
  ),
  ClusterRoleBinding: filled(
    16,
    <path d="M8.8 6.8a5 5 0 0 1 6.5-.5L14 7.8a3 3 0 0 0-3.8.4L8.1 10.3a3 3 0 0 0 4.2 4.2l1-1 1.4 1.4-1 1a5 5 0 0 1-7.1-7.1l2.2-2Zm6.4.8a5 5 0 0 1 2.2 8.3l-2.2 2.2a5 5 0 0 1-6.5.5l1.3-1.5a3 3 0 0 0 3.8-.4l2.1-2.1a3 3 0 0 0-4.2-4.2l-1 1-1.4-1.4 1-1a5 5 0 0 1 4.9-1.4ZM19 2l.9 1.8 2 .3-1.5 1.4.4 2-1.8-.9-1.8.9.4-2-1.5-1.4 2-.3L19 2Z" />,
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
  ReplicationController: filled(
    16,
    <path d="M12 4a8 8 0 0 1 7.4 5h-2.3A6 6 0 0 0 6 12H4a8 8 0 0 1 8-8Zm0 16a8 8 0 0 1-7.4-5h2.3A6 6 0 0 0 18 12h2a8 8 0 0 1-8 8ZM4 4h6v2H6v4H4V4Zm16 16h-6v-2h4v-4h2v6Z" />,
  ),
  Lease: filled(
    16,
    <path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm-1 3v8l5.5 3.3 1-1.7L13 12V5h-2Z" />,
  ),
  MutatingWebhookConfiguration: filled(
    16,
    <path d="M12 2a4 4 0 0 1 3.9 3h2.6L17 9.5l1.5 2.6L13.5 17h-3l-2.6-1.5L4 17.5 6.6 13a4 4 0 0 1 5.4-9Zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />,
  ),
  ValidatingWebhookConfiguration: filled(
    16,
    <path d="M12 2 4 5v6c0 5 3.5 9.4 8 11 4.5-1.6 8-6 8-11V5l-8-3Zm-1.2 13.4-3.6-3.6L8.6 10.4l2.2 2.2 4.6-4.6 1.4 1.4-6 6Z" />,
  ),
  GatewayClass: filled(
    16,
    <path d="M3 5h18v3H3V5Zm2 5h14v3H5v-3Zm-2 5h18v4H3v-4Zm3 1.5v1h2v-1H6Zm4 0v1h2v-1h-2Zm4 0v1h2v-1h-2Z" />,
  ),
  Gateway: filled(
    16,
    <path d="M5 3h14a2 2 0 0 1 2 2v3H3V5a2 2 0 0 1 2-2Zm-2 7h18v4H3v-4Zm0 6h18v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3Zm3-10v2h2V6H6Zm5 0v2h2V6h-2Zm5 0v2h2V6h-2Z" />,
  ),
  HTTPRoute: filled(
    16,
    <path d="M2 7h6a4 4 0 0 1 0 8H7v4H4v-4H2V7Zm12 0h6v3h-6v9h-3V10h-3V7h6Zm-9 3v2h3a1 1 0 0 0 0-2H5Z" />,
  ),
  GRPCRoute: filled(
    16,
    <path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 4a6 6 0 0 0-5.2 9 1 1 0 0 0 1.7-1A4 4 0 0 1 16 12h-2l3 3 3-3h-2a6 6 0 0 0-6-6Zm5.2 3a1 1 0 0 0-1.7 1 4 4 0 0 1-7.5 1H10L7 8l-3 3h2a6 6 0 0 0 11.2 0Z" />,
  ),
  ReferenceGrant: filled(
    16,
    <path d="M9 4h11v8h-3v-3l-7 7-3-3 7-7H9V4ZM4 12h11v8H4v-8Zm2 2v4h7v-4H6Z" />,
  ),
  // Helm release — ship's helm wheel (the project's namesake) drawn as a
  // hub-and-spokes silhouette. Solid filled, monochrome, no strokes.
  HelmRelease: filled(
    16,
    <>
      <path d="M6 3.5 13 7v8l-7 3.5L3 17V7l3-3.5Zm1.2 1.8L5.4 7.4 9 9.2l1.8-1.8-3.6-2.1ZM5 9v6.8l6 3V12L5 9Zm8-1.8L9.4 9 13 10.8 16.6 9 13 7.2Z" />
      <path d="M17.5 12a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm-1 5.9-1.6-1.6-1.4 1.4 3 3 5-5-1.4-1.4-3.6 3.6Z" />
    </>,
  ),
  // Helm chart — package-box silhouette with a folded top flap, distinct
  // from the helm-wheel HelmRelease so charts ≠ deployed releases at a
  // glance. Same solid filled geometric style.
  HelmChart: filled(
    16,
    <>
      <path d="M9 2.5 3 6l6 3.5L15 6 9 2.5Zm-6 5.4 6 3.5L15 8v2L9 13.5 3 10V7.9Zm0 4 6 3.5 6-3.5v2L9 17.5 3 14v-2.1Z" />
      <path d="M16 10.5 12 12.8v5.4l4 2.3 4-2.3v-5.4l-4-2.3Zm0 1.7 2.3 1.3-2.3 1.3-2.3-1.3 2.3-1.3Zm-2.8 2.2 1.8 1v2.9l-1.8-1v-2.9Zm3.8 3.9v-2.9l1.8-1v2.9l-1.8 1Z" />
    </>,
  ),
};
