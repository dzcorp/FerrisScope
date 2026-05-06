// Shared window chrome + common atoms for all variants.

function TrafficLights({ style = {} }) {
  const dot = (bg) => (
    <div style={{ width: 12, height: 12, borderRadius: 6, background: bg, border: '0.5px solid rgba(0,0,0,0.12)' }} />
  );
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', ...style }}>
      {dot('#ff5f57')}{dot('#febc2e')}{dot('#28c840')}
    </div>
  );
}

// Desktop window frame — neutral, themeable. content is full bleed.
function DesktopWindow({ children, theme = 'light', titleBar = null, accentBg, style = {} }) {
  const dark = theme === 'dark';
  return (
    <div style={{
      width: '100%', height: '100%',
      background: dark ? '#0f1115' : '#fbfaf7',
      color: dark ? '#e6e8ec' : '#1a1d23',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      ...style,
    }}>
      <div style={{
        height: 38, flexShrink: 0,
        background: accentBg || (dark ? '#181b22' : '#f3f1ec'),
        borderBottom: dark ? '1px solid #23272f' : '1px solid #e6e2da',
        display: 'flex', alignItems: 'center', padding: '0 14px', gap: 14,
      }}>
        <TrafficLights />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0 }}>
          {titleBar}
        </div>
        <div style={{ width: 52 }} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>{children}</div>
    </div>
  );
}

// Tiny circular gauge for cluster cards.
function Gauge({ value, label, size = 56, color = '#10b981', track = '#e6e2da', thickness = 5, showValue = true }) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} stroke={track} strokeWidth={thickness} fill="none" />
        <circle cx={size/2} cy={size/2} r={r} stroke={color} strokeWidth={thickness} fill="none"
          strokeDasharray={c} strokeDashoffset={c * (1 - value)} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset .4s ease' }} />
      </svg>
      {showValue && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600,
          fontVariantNumeric: 'tabular-nums', letterSpacing: -0.2, lineHeight: 1.1,
        }}>
          <div style={{ fontSize: 13 }}>{Math.round(value * 100)}<span style={{ fontSize: 8, opacity: 0.7 }}>%</span></div>
          {label && <div style={{ fontSize: 8.5, opacity: 0.55, fontWeight: 500, marginTop: 1, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>}
        </div>
      )}
    </div>
  );
}

// Horizontal bar gauge (denser variants)
function BarGauge({ value, color = '#10b981', track = 'rgba(0,0,0,0.06)', height = 4, width = 60 }) {
  return (
    <div style={{ width, height, borderRadius: height/2, background: track, overflow: 'hidden', flexShrink: 0 }}>
      <div style={{ width: `${value * 100}%`, height: '100%', background: color, transition: 'width .3s' }} />
    </div>
  );
}

// Status pill — keeps coloring out of variant code.
// `pod` is optional; if passed, we read `initStep` for Init pods and pulse on transient states.
// Statuses considered "ambient" — well-known, often-seen states. In compact
// mode we render these as a bare colored dot (animated for transient ones)
// instead of a labelled pill, since the dot's color carries enough meaning.
const AMBIENT_STATUSES = ['Running', 'Terminating'];

function StatusPill({ status, theme = 'light', dense = false, pod = null, compact = false }) {
  const c = window.statusColor(status, theme);
  const transient = window.statusIsTransient && window.statusIsTransient(status);
  const label = (status === 'Init' && pod && pod.initStep) ? `Init:${pod.initStep}` : status;

  // Compact mode for ambient statuses: just the dot, with tooltip for the label.
  if (compact && AMBIENT_STATUSES.includes(status)) {
    const dotSize = dense ? 7 : 8;
    return (
      <span title={status} style={{ display: 'inline-flex', alignItems: 'center', height: dense ? 14 : 18 }}>
        <span
          className={transient ? 'hm-pulse-dot' : ''}
          style={{ width: dotSize, height: dotSize, borderRadius: '50%', background: c.dot, display: 'inline-block' }}
        />
      </span>
    );
  }

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: dense ? 4 : 6,
      padding: dense ? '1px 6px' : '2px 8px',
      borderRadius: dense ? 3 : 10,
      background: c.bg, color: c.fg,
      fontSize: dense ? 10.5 : 11, fontWeight: 600,
      letterSpacing: dense ? 0 : -0.1,
      lineHeight: 1.4, whiteSpace: 'nowrap',
    }}>
      <span
        className={transient ? 'hm-pulse-dot' : ''}
        style={{ width: dense ? 5 : 6, height: dense ? 5 : 6, borderRadius: 3, background: c.dot }}
      />
      {label}
    </span>
  );
}

// Container dots — visualizes a pod's container topology as a row of small
// circles. Init containers come first (square caps), main is a slightly bigger
// circle, sidecars are circles with a thin ring.
//   shape: 'square' for init, 'disc' for main, 'ring' for sidecar
function ContainerDots({ containers, theme = 'light', size = 8, gap = 3, showSeparator = true }) {
  if (!containers || !containers.length) return null;
  const inits = containers.filter(c => c.kind === 'init');
  const main = containers.find(c => c.kind === 'main');
  const sidecars = containers.filter(c => c.kind === 'sidecar');

  const Dot = ({ c, kind }) => {
    const col = window.statusColor(c.status, theme);
    const transient = window.statusIsTransient && window.statusIsTransient(c.status);
    const w = kind === 'main' ? size + 2 : size;
    const h = kind === 'main' ? size + 2 : size;
    const common = {
      width: w, height: h,
      flexShrink: 0,
      display: 'inline-block',
    };
    let style;
    if (kind === 'init') {
      // Rounded square for init
      style = { ...common, borderRadius: 2, background: col.dot };
    } else if (kind === 'sidecar') {
      // Ring (hollow circle) for sidecar
      style = { ...common, borderRadius: '50%', background: 'transparent', boxShadow: `inset 0 0 0 1.5px ${col.dot}` };
    } else {
      // Solid disc for main
      style = { ...common, borderRadius: '50%', background: col.dot, boxShadow: `0 0 0 1.5px ${theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'}` };
    }
    const tip = `${c.kind || 'container'}: ${c.name} — ${c.status}`;
    return <span title={tip} className={transient ? 'hm-pulse-dot' : ''} style={style} />;
  };

  const sep = (
    <span style={{
      display: 'inline-block', width: 1, height: size + 2,
      background: theme === 'dark' ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)',
      margin: `0 ${gap + 1}px`, verticalAlign: 'middle',
    }} />
  );

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap, lineHeight: 1, verticalAlign: 'middle' }}>
      {inits.map((c, i) => <Dot key={'i' + i} c={c} kind="init" />)}
      {showSeparator && inits.length > 0 && sep}
      {main && <Dot c={main} kind="main" />}
      {sidecars.length > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap, marginLeft: 1 }}>
          {sidecars.map((c, i) => <Dot key={'s' + i} c={c} kind="sidecar" />)}
        </span>
      )}
    </span>
  );
}

// Accent palette for clusters (oklch-derived but expressed as hex for simplicity).
const ACCENTS = {
  emerald: { base: '#10b981', soft: '#d1fae5', softDark: 'rgba(16,185,129,0.15)' },
  amber:   { base: '#f59e0b', soft: '#fef3c7', softDark: 'rgba(245,158,11,0.15)' },
  sky:     { base: '#0ea5e9', soft: '#e0f2fe', softDark: 'rgba(14,165,233,0.15)' },
  rose:    { base: '#f43f5e', soft: '#ffe4e6', softDark: 'rgba(244,63,94,0.15)' },
  violet:  { base: '#8b5cf6', soft: '#ede9fe', softDark: 'rgba(139,92,246,0.15)' },
  slate:   { base: '#64748b', soft: '#e2e8f0', softDark: 'rgba(100,116,139,0.15)' },
};

// Containers list — a tabular breakdown of a pod's containers for use in
// detail panels. Renders one row per container with kind badge, shape glyph,
// name, image, and status pill. `t` is the variant's theme tokens object;
// `mono` is the variant's monospace font stack.
function ContainersList({ containers, theme = 'light', t, mono }) {
  if (!containers || !containers.length) return null;
  const monoFam = mono || 'ui-monospace, SFMono-Regular, Menlo, monospace';
  return (
    <div style={{ border: `1px solid ${t.borderSoft}`, borderRadius: 7, overflow: 'hidden' }}>
      {containers.map((c, i) => {
        const col = window.statusColor(c.status, theme);
        const transient = window.statusIsTransient && window.statusIsTransient(c.status);
        const isInit = c.kind === 'init';
        const isSidecar = c.kind === 'sidecar';
        const glyph = isInit
          ? { width: 9, height: 9, borderRadius: 2, background: col.dot }
          : isSidecar
            ? { width: 9, height: 9, borderRadius: '50%', background: 'transparent', boxShadow: `inset 0 0 0 1.5px ${col.dot}` }
            : { width: 9, height: 9, borderRadius: '50%', background: col.dot };
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '8px 12px',
            borderTop: i ? `1px solid ${t.borderSoft}` : 'none',
            background: i % 2 ? t.surfaceAlt : 'transparent',
          }}>
            <span className={transient ? 'hm-pulse-dot' : ''} style={{ ...glyph, flexShrink: 0, display: 'inline-block' }} />
            <span style={{ fontSize: 9.5, fontWeight: 700, color: t.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, width: 50, flexShrink: 0 }}>
              {isInit ? 'init' : isSidecar ? 'sidecar' : 'main'}
            </span>
            <span style={{ fontFamily: monoFam, fontSize: 11.5, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
            <span style={{ flex: 1, fontFamily: monoFam, fontSize: 10.5, color: t.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.image}</span>
            <StatusPill status={c.status} theme={theme} dense />
          </div>
        );
      })}
    </div>
  );
}

Object.assign(window, {
  TrafficLights, DesktopWindow, Gauge, BarGauge, StatusPill, ContainerDots, ContainersList, ACCENTS,
});

// Inject pulse keyframes once for the StatusPill transient dot.
if (typeof document !== 'undefined' && !document.getElementById('hm-pulse-style')) {
  const s = document.createElement('style');
  s.id = 'hm-pulse-style';
  s.textContent = `
    @keyframes hm-pulse-dot-kf {
      0%, 100% { transform: scale(1); opacity: 1; }
      50%      { transform: scale(1.35); opacity: 0.55; }
    }
    .hm-pulse-dot { animation: hm-pulse-dot-kf 1.4s ease-in-out infinite; transform-origin: center; }
  `;
  document.head.appendChild(s);
}
