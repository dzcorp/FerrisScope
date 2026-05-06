// Shared UI primitives for Helmsman v2 — buttons, icons, helpers

const HV2_FONT = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const HV2_MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

// ── Button system ──────────────────────────────────────────────────────────
// Variants: primary | secondary | ghost | danger
// Sizes: sm | md
function Btn({ variant = 'secondary', size = 'md', icon, iconRight, kbd, t, children, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);

  const sizes = {
    sm: { pad: '5px 10px', fs: 11.5, h: 26, gap: 6, iconSz: 12 },
    md: { pad: '7px 13px', fs: 12.5, h: 32, gap: 7, iconSz: 13 },
  }[size];

  const variants = {
    primary: {
      bg: t.accent,
      bgHover: t.accentHover || t.accent,
      bgActive: t.accentActive || t.accent,
      fg: '#fff',
      border: 'transparent',
      shadow: hover ? `0 1px 2px rgba(15,20,30,0.10), 0 0 0 3px ${t.accentSoft}` : '0 1px 2px rgba(15,20,30,0.06)',
    },
    secondary: {
      bg: hover ? t.btnHover : t.surface,
      fg: t.text,
      border: t.border,
      shadow: '0 1px 0 rgba(15,20,30,0.02)',
    },
    ghost: {
      bg: hover ? t.hover : 'transparent',
      fg: t.textDim,
      border: 'transparent',
      shadow: 'none',
    },
    danger: {
      bg: hover ? '#fee2e2' : 'transparent',
      fg: '#dc2626',
      border: hover ? '#fecaca' : 'transparent',
      shadow: 'none',
    },
  }[variant];

  const bg = variant === 'primary'
    ? (active ? variants.bgActive : hover ? variants.bgHover : variants.bg)
    : variants.bg;

  return (
    <button
      onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)} onMouseUp={() => setActive(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        gap: sizes.gap, padding: sizes.pad, height: sizes.h,
        border: `1px solid ${variants.border}`, borderRadius: 7,
        background: bg, color: variants.fg,
        fontFamily: 'inherit', fontSize: sizes.fs, fontWeight: variant === 'primary' ? 600 : 500,
        cursor: 'pointer', outline: 'none',
        boxShadow: variants.shadow,
        transform: active ? 'translateY(0.5px)' : 'none',
        transition: 'background .12s, box-shadow .12s, transform .05s',
        letterSpacing: -0.05,
        whiteSpace: 'nowrap',
        ...style,
      }}
      {...rest}>
      {icon && <span style={{ display: 'inline-flex', width: sizes.iconSz, height: sizes.iconSz }}>{icon}</span>}
      {children}
      {iconRight && <span style={{ display: 'inline-flex', width: sizes.iconSz, height: sizes.iconSz, opacity: 0.7 }}>{iconRight}</span>}
      {kbd && <span style={{
        fontFamily: HV2_MONO, fontSize: 10, padding: '1px 5px', borderRadius: 3,
        background: variant === 'primary' ? 'rgba(255,255,255,0.18)' : t.chip,
        color: variant === 'primary' ? 'rgba(255,255,255,0.8)' : t.textMuted,
        marginLeft: 2,
      }}>{kbd}</span>}
    </button>
  );
}

// Icon-only button (square)
function IconBtn({ t, title, onClick, children, active, danger }) {
  const [hover, setHover] = React.useState(false);
  const bg = danger
    ? (hover ? 'rgba(220,38,38,0.10)' : 'transparent')
    : active
    ? t.accentSoft
    : (hover ? t.hover : 'transparent');
  const fg = danger ? '#dc2626' : active ? t.accent : t.textDim;
  return (
    <button onClick={onClick} title={title}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        width: 28, height: 28, borderRadius: 6,
        border: 'none', background: bg, color: fg,
        cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background .12s',
      }}>
      {children}
    </button>
  );
}

// Icon set
const Icons = {
  pod: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/></svg>,
  deploy: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="4" width="12" height="3" rx="0.6"/><rect x="2" y="9" width="12" height="3" rx="0.6"/><circle cx="4.5" cy="5.5" r="0.5" fill="currentColor"/><circle cx="4.5" cy="10.5" r="0.5" fill="currentColor"/></svg>,
  node: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="12" height="4" rx="1"/><rect x="2" y="9" width="12" height="4" rx="1"/><circle cx="4.5" cy="5" r="0.5" fill="currentColor"/><circle cx="4.5" cy="11" r="0.5" fill="currentColor"/></svg>,
  cluster: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><path d="M6 4h4M4 6v4M12 6v4M6 12h4"/></svg>,
  cm: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 3h7l3 3v7H3z"/><path d="M10 3v3h3" strokeLinejoin="round"/><path d="M5.5 8.5h5M5.5 11h3.5" strokeLinecap="round"/></svg>,
  secret: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="7" width="10" height="7" rx="1.2"/><path d="M5 7V5a3 3 0 016 0v2"/></svg>,
  settings: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M1 8h2M13 8h2M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4"/></svg>,
  search: <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="5.5" cy="5.5" r="4"/><path d="M8.5 8.5l3 3" strokeLinecap="round"/></svg>,
  close: <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 3l8 8M11 3l-8 8" strokeLinecap="round"/></svg>,
  copy: <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="8" height="9" rx="1.5"/><path d="M5 3V2a1 1 0 011-1h6a1 1 0 011 1v8a1 1 0 01-1 1h-1"/></svg>,
  pin: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8 1.5v6M8 7.5l-3 3v3h6v-3l-3-3z" strokeLinejoin="round"/></svg>,
  chevR: <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3.5 2L7 5l-3.5 3" strokeLinecap="round"/></svg>,
  chevD: <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 3.5L5 7l3-3.5" strokeLinecap="round"/></svg>,
  trash: <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4h8 M5 4V2h4v2 M4 4l1 8h4l1-8"/></svg>,
  refresh: <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4a4 4 0 11-1.5-2.5 M11 1v3h-3"/></svg>,
  shell: <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3l3 3-3 3 M7 9h4"/></svg>,
  logs: <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3h7l1 1v7H3z M5 6h5M5 8h5M5 10h3"/></svg>,
  yaml: <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 7l2-2-2-2 M12 3l-2 2 2 2 M6 11l3-8" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  port: <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 7h10 M9 4l3 3-3 3"/></svg>,
  eye: <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M1 7s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4z"/><circle cx="7" cy="7" r="1.5"/></svg>,
  bolt: <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1L3 8h4l-1 5 5-7H7z"/></svg>,
};

// ── Checkbox ────────────────────────────────────────────────────────────────
function Checkbox({ checked, indeterminate, onChange, t, size = 14, onClick }) {
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick ? onClick(e) : onChange?.(!checked); }}
      style={{
        width: size, height: size, borderRadius: 4,
        border: `1.5px solid ${checked || indeterminate ? t.accent : t.border}`,
        background: checked || indeterminate ? t.accent : t.surface,
        cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        padding: 0, color: '#fff', flexShrink: 0,
        transition: 'border-color .12s, background .12s',
      }}>
      {checked && (
        <svg width={size - 4} height={size - 4} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 5.2L4 7.2 8 3" />
        </svg>
      )}
      {indeterminate && !checked && (
        <svg width={size - 4} height={size - 4} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M2.5 5h5" />
        </svg>
      )}
    </button>
  );
}

Object.assign(window, { HV2_FONT, HV2_MONO, Btn, IconBtn, Icons, Checkbox });
