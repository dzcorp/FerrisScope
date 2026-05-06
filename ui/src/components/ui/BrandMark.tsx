// FerrisScope brand mark — solid, monochrome version of the helm-wheel +
// scope reticle. Uses `currentColor` so the caller controls the tone (the
// header tints with t.accent). Same silhouette as crates/app/icons/icon.svg
// but drawn as a single-fill geometric glyph to match the rest of the UI
// icon system (icon.md). No gradients, no strokes.
type Props = { size?: number };

export function BrandMark({ size = 26 }: Props) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
    >
      {/* Outer heptagonal ring: outer 7-gon (R=200) with inner 7-gon
          (R=128) cut out via even-odd fill. Same orientation as the app
          icon — top vertex up. */}
      <path
        fillRule="evenodd"
        d="
          M 256,56 L 412.37,131.30 L 450.99,300.50 L 342.78,436.19
            L 169.22,436.19 L 61.01,300.50 L 99.63,131.30 Z
          M 256,128 L 356.06,176.46 L 380.79,284.83 L 311.51,371.69
            L 200.49,371.69 L 131.21,284.83 L 155.94,176.46 Z
        "
      />

      {/* 7 short tab-spokes around the rim. */}
      <g transform="translate(256 256)">
        <rect x="-12" y="-184" width="24" height="44" rx="5" />
        <rect x="-12" y="-184" width="24" height="44" rx="5" transform="rotate(51.4286)" />
        <rect x="-12" y="-184" width="24" height="44" rx="5" transform="rotate(102.857)" />
        <rect x="-12" y="-184" width="24" height="44" rx="5" transform="rotate(154.286)" />
        <rect x="-12" y="-184" width="24" height="44" rx="5" transform="rotate(205.714)" />
        <rect x="-12" y="-184" width="24" height="44" rx="5" transform="rotate(257.143)" />
        <rect x="-12" y="-184" width="24" height="44" rx="5" transform="rotate(308.571)" />
      </g>

      {/* Scope reticle — solid ring (annulus) + 4 cardinal ticks + dot.
          All shapes are filled, no strokes, so the silhouette stays clean
          at 16px. */}
      <path
        fillRule="evenodd"
        d="
          M 256,192
          a 64 64 0 1 1 0 128
          a 64 64 0 1 1 0 -128 Z
          M 256,206
          a 50 50 0 1 0 0 100
          a 50 50 0 1 0 0 -100 Z
        "
      />
      <rect x="248" y="170" width="16" height="32" rx="4" />
      <rect x="248" y="310" width="16" height="32" rx="4" />
      <rect x="170" y="248" width="32" height="16" rx="4" />
      <rect x="310" y="248" width="32" height="16" rx="4" />
      <circle cx="256" cy="256" r="16" />
    </svg>
  );
}
