import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { FONT_MONO, statusDot, statusIsTransient, type Tokens } from "../../theme";
import { useAppStore } from "../../store";
import { Tooltip } from "./Tooltip";

// ── Eyebrow ────────────────────────────────────────────────────────────────
// Section label — uppercase mono with letter-spacing per design tokens.
export function Eyebrow({
  t,
  children,
  style,
}: {
  t: Tokens;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: t.textMuted,
        textTransform: "uppercase",
        letterSpacing: 0.6,
        fontFamily: FONT_MONO,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── Section header (with optional right slot) ───────────────────────────────
export function Section({
  t,
  title,
  right,
  style,
}: {
  t: Tokens;
  title: ReactNode;
  right?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        fontSize: 11,
        fontWeight: 700,
        color: t.textDim,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        marginBottom: 10,
        ...style,
      }}
    >
      <span>{title}</span>
      {right}
    </div>
  );
}

// ── kbd chip ───────────────────────────────────────────────────────────────
export function Kbd({
  t,
  children,
  style,
}: {
  t: Tokens;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: FONT_MONO,
        fontSize: 10,
        padding: "1px 5px",
        borderRadius: 3,
        background: t.chip,
        color: t.textMuted,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

// ── Chip (small pill for context tags) ─────────────────────────────────────
export function Chip({
  t,
  children,
  mono,
  tone = "neutral",
  style,
  title,
}: {
  t: Tokens;
  children: ReactNode;
  mono?: boolean;
  // `warn` paints with the amber tokens — used for "this is risky" labels
  // (e.g. a managedFields chip naming a reconciler that will revert your
  // edits). Mirrors the bucket semantics in theme.ts.
  tone?: "neutral" | "accent" | "warn";
  style?: CSSProperties;
  title?: string;
}) {
  const palette =
    tone === "accent"
      ? { bg: t.accentSoft, fg: t.accent }
      : tone === "warn"
        ? { bg: "rgba(245,158,11,0.14)", fg: t.warn }
        : { bg: t.chip, fg: t.textDim };
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 11,
        padding: "1px 6px",
        borderRadius: 3,
        background: palette.bg,
        color: palette.fg,
        fontWeight: 500,
        fontFamily: mono ? FONT_MONO : "inherit",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

// ── Stat (label + value, used in cluster bar) ──────────────────────────────
export function Stat({
  t,
  label,
  value,
  mono,
}: {
  t: Tokens;
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          color: t.textMuted,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          marginBottom: 2,
          fontFamily: FONT_MONO,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          fontFamily: mono ? FONT_MONO : "inherit",
          fontVariantNumeric: "tabular-nums",
          color: t.text,
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ── Checkbox ───────────────────────────────────────────────────────────────
export function Checkbox({
  t,
  checked,
  indeterminate,
  onChange,
  size = 14,
}: {
  t: Tokens;
  checked?: boolean;
  indeterminate?: boolean;
  onChange?: (next: boolean) => void;
  size?: number;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onChange?.(!checked);
      }}
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        border: `1.5px solid ${
          checked || indeterminate ? t.accent : t.border
        }`,
        background: checked || indeterminate ? t.accent : t.surface,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        color: "#fff",
        flexShrink: 0,
        transition: "border-color .12s, background .12s",
      }}
    >
      {checked && (
        <svg
          width={size - 4}
          height={size - 4}
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 5.2L4 7.2 8 3" />
        </svg>
      )}
      {indeterminate && !checked && (
        <svg
          width={size - 4}
          height={size - 4}
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <path d="M2.5 5h5" />
        </svg>
      )}
    </button>
  );
}

// ── Circular gauge ─────────────────────────────────────────────────────────
// Mirrors design/shared.jsx::Gauge — used by the cluster bar to visualise
// CPU + memory utilisation. Renders a track + a stroke arc; thresholds drive
// the color (green / amber / red) per P5 (status is structural, not decorative).
export function Gauge({
  value,
  size = 36,
  thickness = 3.5,
  color,
  track,
}: {
  value: number;
  size?: number;
  thickness?: number;
  color: string;
  track: string;
}) {
  const v = Math.max(0, Math.min(1, value));
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        flexShrink: 0,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ transform: "rotate(-90deg)" }}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={track}
          strokeWidth={thickness}
          fill="none"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={thickness}
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset .4s ease, stroke .2s" }}
        />
      </svg>
    </div>
  );
}

// ── Mini bar gauge (for inline percentages) ────────────────────────────────
export function BarGauge({
  value,
  color,
  track,
  width = 60,
  height = 4,
}: {
  value: number;
  color: string;
  track: string;
  width?: number;
  height?: number;
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: height / 2,
        background: track,
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: `${Math.max(0, Math.min(1, value)) * 100}%`,
          height: "100%",
          background: color,
          transition: "width .3s",
        }}
      />
    </div>
  );
}

// ── Toggle (switch) ────────────────────────────────────────────────────────
export function Toggle({
  t,
  checked,
  onChange,
  label,
  size = "md",
  tone = "accent",
  title,
}: {
  t: Tokens;
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  size?: "sm" | "md";
  tone?: "accent" | "warn";
  title?: string;
}) {
  const dims =
    size === "sm"
      ? { w: 22, h: 13, knob: 9, gap: 7, fs: 11, pad: 2 }
      : { w: 30, h: 18, knob: 14, gap: 10, fs: 12.5, pad: 2 };
  const onColor = tone === "warn" ? t.warn : t.accent;
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: dims.gap,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        padding: "2px 0",
        color: t.text,
        fontFamily: "inherit",
        fontSize: dims.fs,
      }}
    >
      <span
        style={{
          width: dims.w,
          height: dims.h,
          borderRadius: dims.h / 2,
          background: checked ? onColor : t.border,
          position: "relative",
          transition: "background .15s",
          flexShrink: 0,
          display: "inline-block",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: dims.pad,
            left: checked ? dims.w - dims.knob - dims.pad : dims.pad,
            width: dims.knob,
            height: dims.knob,
            borderRadius: dims.knob / 2,
            background: "#ffffff",
            transition: "left .15s",
            boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
          }}
        />
      </span>
      {label && <span>{label}</span>}
    </button>
  );
}

// ── TextInput ──────────────────────────────────────────────────────────────
export function TextInput({
  t,
  value,
  onChange,
  placeholder,
  mono,
  fullWidth = true,
  style,
}: {
  t: Tokens;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  fullWidth?: boolean;
  style?: CSSProperties;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onFocus={(e) => (e.currentTarget.style.borderColor = t.accent)}
      onBlur={(e) => (e.currentTarget.style.borderColor = t.border)}
      style={{
        padding: "7px 10px",
        height: 32,
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        background: t.surface,
        color: t.text,
        fontSize: 12.5,
        fontFamily: mono ? FONT_MONO : "inherit",
        outline: "none",
        width: fullWidth ? "100%" : undefined,
        ...style,
      }}
    />
  );
}

// ── Select ─────────────────────────────────────────────────────────────────
// Custom dropdown that replaces the native `<select>` so the popover list
// uses our theme tokens instead of the OS-native list (which renders white on
// dark, ignores our typography, and shows OS scrollbars). Keyboard model:
// ↑/↓ move active, Home/End jump, Enter/Space pick, type-to-search latches a
// short prefix, Esc/Tab/outside-click close. With `searchable`, the popover
// gains a top search input and the list filters by substring on label/value;
// the prefix-latch is replaced by the input. `popoverMinWidth` lets the
// popover extend wider than the trigger when option labels are long.
export function Select<V extends string | number>({
  t,
  value,
  onChange,
  options,
  fullWidth = true,
  style,
  searchable = false,
  popoverMinWidth,
  searchPlaceholder = "Search…",
}: {
  t: Tokens;
  value: V;
  onChange: (v: V) => void;
  options: { value: V; label: string }[];
  fullWidth?: boolean;
  style?: CSSProperties;
  searchable?: boolean;
  popoverMinWidth?: number;
  searchPlaceholder?: string;
}) {
  const themeMode = useAppStore((s) => s.themeMode);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(() =>
    Math.max(0, options.findIndex((o) => o.value === value)),
  );
  // When `flipUp` is true, `y` is the distance from the viewport BOTTOM to
  // the popover's bottom edge — anchoring the popover to the trigger top so
  // it stays glued there even when its rendered height is shorter than
  // `maxH` (e.g. only a few options). When false, `y` is the popover's top
  // edge in viewport coords (anchored to the trigger bottom).
  const [pop, setPop] = useState({
    x: 0,
    y: 0,
    w: 0,
    maxH: 240,
    flipUp: false,
  });
  const [query, setQuery] = useState("");
  const typeBuf = useRef("");
  const typeAt = useRef(0);

  const current = useMemo(
    () => options.find((o) => o.value === value),
    [options, value],
  );

  const filtered = useMemo(() => {
    if (!searchable || !query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        String(o.value).toLowerCase().includes(q),
    );
  }, [options, query, searchable]);

  const place = useCallback(() => {
    const trig = triggerRef.current;
    if (!trig) return;
    const r = trig.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const below = window.innerHeight - r.bottom - margin;
    const above = r.top - margin;
    const flipUp = below < 200 && above > below;
    const maxH = Math.max(120, Math.min(360, flipUp ? above - gap : below - gap));
    const desiredW = Math.max(r.width, popoverMinWidth ?? 0);
    const maxW = window.innerWidth - margin * 2;
    const w = Math.min(desiredW, maxW);
    let x = r.left;
    if (x + w > window.innerWidth - margin) {
      x = Math.max(margin, window.innerWidth - margin - w);
    }
    // Up: anchor by viewport-from-bottom so the popover bottom hugs the
    // trigger top no matter how tall it actually renders. Down: top-anchor
    // just below the trigger.
    const y = flipUp
      ? window.innerHeight - r.top + gap
      : r.bottom + gap;
    setPop({ x, y, w, maxH, flipUp });
  }, [popoverMinWidth]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node;
      if (popRef.current?.contains(tgt) || triggerRef.current?.contains(tgt)) return;
      setOpen(false);
    };
    // Close on ancestor scrolls (those visually orphan the popover from the
    // trigger). Ignore scrolls inside the popover itself and scrolls in
    // unrelated scroll containers — e.g. a Monaco editor elsewhere in the
    // layout fires viewport scrolls constantly, and those shouldn't dismiss
    // a Select that's anchored to a different part of the page.
    const onScroll = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && popRef.current?.contains(target)) return;
      const trig = triggerRef.current;
      if (!trig) return;
      if (
        target === document ||
        target === window ||
        target === document.documentElement ||
        target === document.body
      ) {
        setOpen(false);
        return;
      }
      if (target instanceof Node && target.contains(trig)) {
        setOpen(false);
      }
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = itemRefs.current[active];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const pick = (i: number) => {
    const opt = filtered[i];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  };

  // Reset transient query/active when the popover closes so reopening starts
  // fresh on the current value.
  useEffect(() => {
    if (open) return;
    setQuery("");
    typeBuf.current = "";
  }, [open]);

  // When the searchable popover opens, focus the search input. Active resets
  // to the first match so Enter picks something sensible.
  useLayoutEffect(() => {
    if (!open || !searchable) return;
    searchRef.current?.focus();
  }, [open, searchable]);

  // Keep `active` inside the filtered range as the query changes.
  useEffect(() => {
    if (!open) return;
    setActive((a) => Math.min(Math.max(0, a), Math.max(0, filtered.length - 1)));
  }, [filtered.length, open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      setOpen(true);
      setActive(Math.max(0, options.findIndex((o) => o.value === value)));
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(filtered.length - 1, a + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      setActive(filtered.length - 1);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      // Space inside a search input must type a space, not pick.
      if (searchable && e.key === " " && e.target === searchRef.current) return;
      e.preventDefault();
      pick(active);
      return;
    }
    // Prefix-latch type-to-search only when there's no real search input.
    if (!searchable && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      if (now - typeAt.current > 700) typeBuf.current = "";
      typeBuf.current += e.key.toLowerCase();
      typeAt.current = now;
      const idx = options.findIndex((o) =>
        o.label.toLowerCase().startsWith(typeBuf.current),
      );
      if (idx >= 0) setActive(idx);
    }
  };

  const triggerStyle: CSSProperties = {
    padding: "7px 32px 7px 10px",
    height: 32,
    border: `1px solid ${open ? t.accent : t.border}`,
    borderRadius: 6,
    background: hover ? t.btnHover : t.surface,
    color: t.text,
    fontSize: 12.5,
    fontFamily: "inherit",
    outline: "none",
    cursor: "pointer",
    width: fullWidth ? "100%" : undefined,
    textAlign: "left",
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    boxShadow: open ? `0 0 0 3px ${t.accentSoft}` : "none",
    transition: "background .12s, border-color .12s, box-shadow .12s",
    ...style,
  };

  itemRefs.current = [];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setActive(Math.max(0, options.findIndex((o) => o.value === value)));
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onKeyDown={onKey}
        style={triggerStyle}
      >
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {current?.label ?? String(value)}
        </span>
        <span
          aria-hidden
          style={{
            position: "absolute",
            right: 9,
            top: "50%",
            transform: `translateY(-50%) rotate(${open ? 180 : 0}deg)`,
            color: t.textMuted,
            transition: "transform .15s",
            display: "inline-flex",
            width: 10,
            height: 10,
          }}
        >
          <svg viewBox="0 0 10 10" width="10" height="10" fill="none">
            <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            role="listbox"
            onKeyDown={onKey}
            tabIndex={-1}
            style={{
              position: "fixed",
              left: pop.x,
              ...(pop.flipUp ? { bottom: pop.y } : { top: pop.y }),
              width: pop.w,
              maxHeight: pop.maxH,
              display: "flex",
              flexDirection: "column",
              background: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: 6,
              padding: 4,
              zIndex: 9000,
              boxShadow:
                themeMode === "dark"
                  ? "0 12px 32px rgba(0,0,0,0.45)"
                  : "0 12px 32px rgba(15,20,30,0.18)",
            }}
          >
            {searchable && (
              <div
                style={{
                  position: "sticky",
                  top: 0,
                  padding: "2px 2px 6px",
                  background: t.surface,
                  borderBottom: `1px solid ${t.borderSoft}`,
                  marginBottom: 4,
                }}
              >
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  placeholder={searchPlaceholder}
                  style={{
                    width: "100%",
                    background: t.surfaceAlt,
                    border: `1px solid ${t.borderSoft}`,
                    color: t.text,
                    borderRadius: 4,
                    padding: "6px 8px",
                    fontFamily: "inherit",
                    fontSize: 12.5,
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
              </div>
            )}
            <div style={{ overflowY: "auto", flex: 1 }}>
            {filtered.length === 0 && (
              <div
                style={{
                  padding: "8px 10px",
                  fontSize: 12,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                }}
              >
                No matches
              </div>
            )}
            {filtered.map((o, i) => {
              const selected = o.value === value;
              const isActive = i === active;
              return (
                <button
                  key={String(o.value)}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => pick(i)}
                  onMouseEnter={() => setActive(i)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    width: "100%",
                    padding: "6px 10px",
                    borderRadius: 4,
                    border: "none",
                    background: isActive
                      ? t.accentSoft
                      : selected
                        ? t.hover
                        : "transparent",
                    color: selected ? t.accent : t.text,
                    fontFamily: "inherit",
                    fontSize: 12.5,
                    textAlign: "left",
                    cursor: "pointer",
                    minHeight: 28,
                    fontWeight: selected ? 600 : 500,
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 10,
                      flexShrink: 0,
                      color: t.accent,
                      visibility: selected ? "visible" : "hidden",
                    }}
                  >
                    ✓
                  </span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {o.label}
                  </span>
                </button>
              );
            })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

// ── Field row (settings layout) ────────────────────────────────────────────
// Default layout is a two-column grid (label/hint | 280px control). With
// `stack`, the label/hint sits above and the control spans the full row —
// use that when the control needs more horizontal room (e.g. a searchable
// model picker with long catalogue labels).
export function Field({
  t,
  label,
  hint,
  children,
  stack = false,
  anchor,
}: {
  t: Tokens;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  stack?: boolean;
  /// Optional `data-fs-anchor` value — picked up by the SettingsPanel
  /// deep-link consumer (`openSettings({ section, anchor })`) so callers
  /// can scroll the operator straight to a specific control.
  anchor?: string;
}) {
  return (
    <div
      data-fs-anchor={anchor}
      style={{
        display: stack ? "flex" : "grid",
        flexDirection: stack ? "column" : undefined,
        gridTemplateColumns: stack ? undefined : "1fr 280px",
        gap: stack ? 10 : 24,
        alignItems: stack ? "stretch" : "flex-start",
        padding: "16px 0",
        borderBottom: `1px solid ${t.borderSoft}`,
      }}
    >
      <div>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: t.text,
            marginBottom: 3,
          }}
        >
          {label}
        </div>
        {hint && (
          <div style={{ fontSize: 12, color: t.textDim, lineHeight: 1.5 }}>
            {hint}
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {children}
      </div>
    </div>
  );
}

// ── Settings section header ────────────────────────────────────────────────
export function SectionHeader({
  t,
  title,
  sub,
}: {
  t: Tokens;
  title: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{
          fontSize: 16,
          fontWeight: 600,
          letterSpacing: -0.2,
          marginBottom: 2,
          color: t.text,
        }}
      >
        {title}
      </div>
      {sub && (
        <div style={{ fontSize: 12.5, color: t.textDim }}>{sub}</div>
      )}
    </div>
  );
}

// ── ContainerDots ──────────────────────────────────────────────────────────
// Renders init/main/sidecar containers as a row of small shapes — square caps
// for init, solid disc for main, ring for sidecar. Transient states pulse
// (fs-pulse-dot) so the operator can see something is in motion. Mirrors
// design/shared.jsx ContainerDots.
export type ContainerLite = {
  name: string;
  status: string;
  kind?: "init" | "main" | "sidecar";
};

export function ContainerDots({
  containers,
  t,
  size = 8,
  gap = 3,
  showSeparator = true,
  dotColor,
}: {
  containers: ContainerLite[];
  t: Tokens;
  size?: number;
  gap?: number;
  showSeparator?: boolean;
  // Optional override; otherwise we color by status bucket via statusDot().
  dotColor?: (c: ContainerLite) => string;
}) {
  if (!containers || containers.length === 0) return null;
  const inits = containers.filter((c) => c.kind === "init");
  const sidecars = containers.filter((c) => c.kind === "sidecar");
  let mains = containers.filter((c) => c.kind === "main");
  // Fallback when callers pass containers without a `kind` discriminator:
  // treat the whole set as main so we still render one dot per container
  // rather than collapsing to a single representative dot.
  if (mains.length === 0 && inits.length === 0 && sidecars.length === 0) {
    mains = containers.slice();
  }

  const colorOf = (c: ContainerLite): string =>
    dotColor ? dotColor(c) : statusDot(c.status, t);

  const dotFor = (c: ContainerLite, kind: "init" | "main" | "sidecar") => {
    const col = colorOf(c);
    const w = kind === "main" ? size + 2 : size;
    const h = w;
    const base: CSSProperties = {
      width: w,
      height: h,
      flexShrink: 0,
      display: "inline-block",
    };
    if (kind === "init")
      return { ...base, borderRadius: 2, background: col };
    if (kind === "sidecar")
      return {
        ...base,
        borderRadius: "50%",
        background: "transparent",
        boxShadow: `inset 0 0 0 1.5px ${col}`,
      };
    return {
      ...base,
      borderRadius: "50%",
      background: col,
      boxShadow: "0 0 0 1.5px rgba(0,0,0,0.06)",
    };
  };

  const className = (c: ContainerLite) =>
    statusIsTransient(c.status) ? "fs-pulse-dot" : undefined;

  const tip = (kind: "init" | "main" | "sidecar", c: ContainerLite) =>
    `${kind}: ${c.name} — ${c.status}`;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap,
        lineHeight: 1,
        verticalAlign: "middle",
      }}
    >
      {inits.map((c, i) => (
        <Tooltip key={`i${i}`} label={tip("init", c)}>
          <span className={className(c)} style={dotFor(c, "init")} />
        </Tooltip>
      ))}
      {showSeparator && inits.length > 0 && (
        <span
          style={{
            display: "inline-block",
            width: 1,
            height: size + 2,
            background: t.border,
            margin: `0 ${gap + 1}px`,
            verticalAlign: "middle",
          }}
        />
      )}
      {mains.length > 0 && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap,
          }}
        >
          {mains.map((c, i) => (
            <Tooltip key={`m${i}`} label={tip("main", c)}>
              <span className={className(c)} style={dotFor(c, "main")} />
            </Tooltip>
          ))}
        </span>
      )}
      {sidecars.length > 0 && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap,
            marginLeft: 1,
          }}
        >
          {sidecars.map((c, i) => (
            <Tooltip key={`s${i}`} label={tip("sidecar", c)}>
              <span className={className(c)} style={dotFor(c, "sidecar")} />
            </Tooltip>
          ))}
        </span>
      )}
    </span>
  );
}

// ── LoadingLine — indeterminate horizontal progress bar ────────────────────
// A 30%-wide accent segment ping-pongs across a thin track. Reads as "data
// is streaming in" — preferred over the spinning circle for tabs that fetch
// from a reflector or the apiserver. Replaces the old `Loading` spinner in
// every loading surface across the app.
//
// Layouts:
//   default — centred in the available space; track on top, label below.
//   inline  — track + label rendered inline-flex; for compact spots like
//             detail-summary headers where the skeleton fills the rest.
export function LoadingLine({
  t,
  label,
  inline,
  width,
  action,
}: {
  t: Tokens;
  label?: ReactNode;
  inline?: boolean;
  width?: number;
  // Optional trailing element (e.g. Cancel button on a pending connection).
  // Stacks under the bar+label in the centred layout.
  action?: ReactNode;
}) {
  if (inline) {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          fontSize: 11,
          color: t.textMuted,
          fontFamily: FONT_MONO,
        }}
      >
        <span
          style={{
            width: width ?? 60,
            height: 2,
            background: t.borderSoft,
            position: "relative",
            overflow: "hidden",
            borderRadius: 1,
            display: "inline-block",
            flexShrink: 0,
          }}
        >
          <span
            className="fs-line-loader"
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              height: "100%",
              width: "30%",
              background: t.accent,
              borderRadius: 1,
            }}
          />
        </span>
        {label}
      </span>
    );
  }
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 32,
      }}
    >
      <div
        style={{
          width: width ?? 220,
          height: 2,
          background: t.borderSoft,
          position: "relative",
          overflow: "hidden",
          borderRadius: 1,
        }}
      >
        <div
          className="fs-line-loader"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            height: "100%",
            width: "30%",
            background: t.accent,
            borderRadius: 1,
          }}
        />
      </div>
      {label && (
        <div
          style={{
            fontSize: 12,
            color: t.textDim,
            fontFamily: FONT_MONO,
            letterSpacing: 0.2,
          }}
        >
          {label}
        </div>
      )}
      {action}
    </div>
  );
}

// ── Empty state — explains what would fill the surface (R-10) ──────────────
export function EmptyState({
  t,
  title,
  hint,
  action,
}: {
  t: Tokens;
  title: ReactNode;
  hint?: ReactNode;
  // Optional trailing element (e.g. a Retry button on an error EmptyState).
  // Sits under the hint with a small gap.
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        padding: "64px 40px",
        textAlign: "center",
        color: t.textDim,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
        {title}
      </div>
      {hint && (
        <div style={{ fontSize: 12.5, color: t.textMuted }}>{hint}</div>
      )}
      {action && (
        <div
          style={{
            marginTop: 14,
            display: "inline-flex",
            justifyContent: "center",
            gap: 8,
          }}
        >
          {action}
        </div>
      )}
    </div>
  );
}

// ── ErrorBlock — friendly error surface for failed fetches ─────────────────
// Replaces raw `<pre>` dumps of stringified API errors. `classifyDetailError`
// matches the common kube-rs / apiserver shapes (404 / 403 / 401 / conflict /
// network) and turns them into a readable title + body. The raw string sits
// behind a "Show details" toggle so power users can still copy it. Mirrors
// `LoadingLine`'s centred / inline layout so loading and error states feel
// like the same surface.
export function ErrorBlock({
  t,
  message,
  kindLabel,
  inline,
  verb = "load",
}: {
  t: Tokens;
  message: string;
  // Used in the friendly body — e.g. "The pod doesn't exist anymore". When
  // omitted the body falls back to "this resource".
  kindLabel?: string;
  inline?: boolean;
  // What the operation was trying to do. Drives the wording in the body —
  // a 403 on a load is "permission to read", on a save is "permission to
  // modify", on a stream is "permission to read logs". Defaults to "load".
  verb?: "load" | "save" | "stream";
}) {
  const c = classifyDetailError(message, kindLabel, verb);
  const [showRaw, setShowRaw] = useState(false);

  if (inline) {
    return (
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: 11.5,
          color: t.bad,
          display: "inline-flex",
          alignItems: "baseline",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontWeight: 600 }}>{c.title}</span>
        <span style={{ color: t.textMuted, fontWeight: 400 }}>{c.body}</span>
      </span>
    );
  }
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        padding: 32,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: t.bad }}>
        {c.title}
      </div>
      <div style={{ fontSize: 12, color: t.textMuted, maxWidth: 460 }}>
        {c.body}
      </div>
      <button
        type="button"
        onClick={() => setShowRaw((v) => !v)}
        style={{
          marginTop: 4,
          background: "none",
          border: "none",
          color: t.textMuted,
          fontSize: 11,
          fontFamily: FONT_MONO,
          cursor: "pointer",
          textDecoration: "underline",
          padding: 0,
        }}
      >
        {showRaw ? "Hide details" : "Show details"}
      </button>
      {showRaw && (
        <pre
          style={{
            marginTop: 6,
            padding: "10px 14px",
            background: t.surfaceAlt,
            border: `1px solid ${t.borderSoft}`,
            borderRadius: 6,
            color: t.textMuted,
            fontFamily: FONT_MONO,
            fontSize: 11,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: 0,
            maxWidth: 600,
            maxHeight: 240,
            overflow: "auto",
            textAlign: "left",
          }}
        >
          {c.raw}
        </pre>
      )}
    </div>
  );
}

type ClassifiedError = { title: string; body: string; raw: string };
type Verb = "load" | "save" | "stream";

// Best-effort classifier for the strings we get from `String(e)` in catch
// blocks. The Rust side wraps `kube::Error` as `FetchError::Kube(...)` which
// Display-formats to `"kube error: <message>: <reason>"` — `<reason>` being
// `NotFound` / `Forbidden` / `Unauthorized` / `Conflict` / etc. (per the
// `Status` Display impl in kube-core). Match generously and fall back to a
// generic title rather than mis-classify. Raw string stays available via
// the `Show details` toggle on the rendered block.
function classifyDetailError(
  raw: string,
  kindLabel?: string,
  verb: Verb = "load",
): ClassifiedError {
  const noun = (kindLabel ?? "resource").toLowerCase();
  const trimmed = raw.replace(/^kube error:\s*/, "");
  const m = trimmed.toLowerCase();
  if (/requires a namespace/i.test(trimmed)) {
    return {
      title: "Namespace required",
      body: "This kind is namespace-scoped — open it from inside a namespace.",
      raw: trimmed,
    };
  }
  if (/\bnot ?found\b|\b404\b/.test(m)) {
    return {
      title: "Not found",
      body:
        verb === "save"
          ? `The ${noun} was deleted while you were editing — close and re-open to refresh.`
          : `The ${noun} doesn't exist — it may have been deleted, or the cluster is on a different revision.`,
      raw: trimmed,
    };
  }
  if (/\bforbidden\b|\b403\b/.test(m)) {
    return {
      title: "Access denied",
      body:
        verb === "save"
          ? `Your kubeconfig user doesn't have permission to modify this ${noun}.`
          : verb === "stream"
            ? `Your kubeconfig user doesn't have permission to stream logs for this ${noun}.`
            : `Your kubeconfig user doesn't have permission to read this ${noun}.`,
      raw: trimmed,
    };
  }
  if (/\bunauthorized\b|\b401\b/.test(m)) {
    return {
      title: "Authentication failed",
      body: "Re-authenticate or check the kubeconfig credentials for this cluster.",
      raw: trimmed,
    };
  }
  if (/\bconflict\b|\b409\b/.test(m)) {
    return {
      title: "Conflict",
      body:
        verb === "save"
          ? "Another change landed first. Reload to see the latest state, then re-apply."
          : "Another change landed first. Reload to see the latest state.",
      raw: trimmed,
    };
  }
  if (
    /timed? ?out|connection refused|connection reset|hyper(error)?\b|no such host|\bdns\b|unable to connect|broken pipe/.test(
      m,
    )
  ) {
    return {
      title: "Connection failed",
      body: "Couldn't reach the apiserver. Check connectivity, VPN, or the cluster URL.",
      raw: trimmed,
    };
  }
  // No known shape matched. For short messages — typically client-side
  // validation or single-line kube errors — surface the raw text as the
  // body so operators see the actual problem instead of a vague generic
  // string. For longer messages (multi-line stack traces), keep the
  // generic body and let `Show details` reveal the raw.
  const verbWord =
    verb === "save" ? "saving" : verb === "stream" ? "streaming" : "fetching";
  const SHORT = 200;
  return {
    title:
      verb === "save"
        ? "Failed to save"
        : verb === "stream"
          ? "Stream failed"
          : "Failed to load",
    body:
      trimmed.length <= SHORT && !trimmed.includes("\n")
        ? trimmed
        : `Something went wrong ${verbWord} this ${noun}.`,
    raw: trimmed,
  };
}
