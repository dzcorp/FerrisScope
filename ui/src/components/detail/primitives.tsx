// Reusable detail-panel primitives. See CLAUDE.md §"Detail-panel primitives".
//
// Every component here is kind-agnostic: it takes layout / interaction props
// only, never a Kubernetes-shape value. Pod / Deployment / Node / etc. summary
// components compose these — they never reach in.

import { logErr } from "../../lib/log";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { FF_MONO, type Tokens, R_SM, R_LG, FS_MD, FS_SM, FS_XS } from "../../theme";
import { MOD_KEY } from "../../lib/keyboard";
import { Chip, Icons, Tooltip } from "../ui";

// ── Cross-kind navigation ──────────────────────────────────────────────────
// Hook handed down from DetailPanel → summary component → LinkValue. Maps a
// Kubernetes Kind name (e.g. "StatefulSet") + (namespace, name) to a
// detail-panel switch. The parent (ResourceTable) resolves the kind name
// against the registry and falls back silently if the kind isn't browseable.
// `clusterId` is optional and defaults to the panel's own cluster. It exists
// for surfaces that union objects from SEVERAL clusters in one list — the
// Inspect drawer's Pods tab groups per cluster, so the row's cluster, not the
// drawer's first subject, is the right scope to open it in.
export type DetailNavigate = (
  kindName: string,
  namespace: string | null,
  name: string,
  clusterId?: string,
) => void;

// ── DetailRow ──────────────────────────────────────────────────────────────
// Label/value row, label-side fixed at 180px, value-side flex-wraps. The
// canonical building block — every named field in any kind's detail panel
// goes through one of these.
export function DetailRow({
  t,
  label,
  children,
}: {
  t: Tokens;
  // ReactNode so callers can decorate the label (e.g. add a doc-tooltip icon
  // next to the field name). String labels still render exactly as before
  // since the wrapper applies the canonical mono/uppercase styling.
  //
  // `null` drops the label column entirely and gives the value the full
  // width — for repeating rows whose label would be the same word over and
  // over (a workload's pods all share its namespace).
  label?: ReactNode;
  children: ReactNode;
}) {
  const labelled = label != null;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: labelled ? "180px 1fr" : "1fr",
        gap: 16,
        alignItems: "baseline",
        padding: "8px 0",
        borderBottom: `1px solid ${t.borderSoft}`,
      }}
    >
      {labelled && (
        <div
          style={{
            fontSize: FS_XS,
            fontWeight: 700,
            color: t.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.6,
            fontFamily: FF_MONO,
            marginTop: 2,
          }}
        >
          {label}
        </div>
      )}
      <div
        style={{
          minWidth: 0,
          color: t.text,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ── ChipWrap ───────────────────────────────────────────────────────────────
// Flex-wrap chip container with consistent gap. Wrap any sequence of `Chip`s
// or `Copyable<Chip>`s.
export function ChipWrap({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        flexWrap: "wrap",
        gap: 4,
        alignItems: "center",
      }}
    >
      {children}
    </span>
  );
}

// ── Mute ───────────────────────────────────────────────────────────────────
// Small dim text — placeholder for missing values, captions, etc.
export function Mute({ t, children }: { t: Tokens; children: ReactNode }) {
  return <span style={{ color: t.textMuted, fontSize: FS_MD }}>{children}</span>;
}

// ── Mono ─────────────────────────────────────────────────────────────────────
// Monospace value at the detail-panel body size. This was the single most
// inlined idiom across the summaries (`<span style={{ fontFamily: FF_MONO,
// fontSize: FS_MD }}>…</span>`) — IDs, generations, counts, image refs, sizes.
// Centralising it means the mono font + body size are tuned in one place.
// Purely presentational: copy support comes from wrapping in <Copyable>, link
// behaviour from <LinkValue>; <Mono> only sets the typeface + size. `size`
// overrides the default for the rare smaller-text site; `style` merges extra
// declarations (e.g. `wordBreak`, `color`).
export function Mono({
  children,
  size = FS_MD,
  style,
}: {
  children: ReactNode;
  size?: string;
  style?: CSSProperties;
}) {
  return (
    <span style={{ fontFamily: FF_MONO, fontSize: size, ...style }}>
      {children}
    </span>
  );
}

// ── ExpandableList ───────────────────────────────────────────────────────────
// Read-only "show the first N, expand the rest" list for bulky collections
// (annotations, tolerations, …). A small collection (≤ `threshold`) renders in
// full with no chrome — most resources sit here, so no extra click. A large
// one renders the first `threshold` items plus a "Show N more" toggle, keeping
// the metadata block scannable without hiding the common case behind a count.
// `render` is handed the slice to draw so callers that batch-render an array
// (KeyValueChips) work unchanged.
export const EXPANDABLE_LIST_THRESHOLD = 10;

export function ExpandableList<T>({
  t,
  items,
  threshold = EXPANDABLE_LIST_THRESHOLD,
  render,
}: {
  t: Tokens;
  items: T[];
  threshold?: number;
  render: (items: T[]) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const overflow = items.length > threshold;
  const shown = overflow && !open ? items.slice(0, threshold) : items;
  return (
    <div style={{ width: "100%", minWidth: 0 }}>
      {render(shown)}
      {overflow && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginTop: 6,
            padding: 0,
            border: "none",
            background: "transparent",
            color: t.textDim,
            cursor: "pointer",
            fontSize: FS_SM,
            fontFamily: "inherit",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              color: t.textMuted,
              transform: open ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform .12s ease",
            }}
          >
            {Icons.chevD}
          </span>
          {open ? "Show less" : `Show ${items.length - threshold} more`}
        </button>
      )}
    </div>
  );
}

// ── CollapsibleCard ──────────────────────────────────────────────────────────
// Bordered card with a click-to-toggle header and a hideable body. Used by the
// container cards (Pod detail + workload Pod Template) so a long list of
// init/sidecar containers collapses to a scannable row list, each expandable
// on demand. Starts collapsed by default.
//
// The body is hidden with `display: none` rather than unmounted: the container
// cards embed live edit-kit editors (`useEditField`) whose dirty buffers and
// GlobalSaveBar registration must survive a collapse. Unmounting would drop an
// in-flight edit; `display: none` keeps it mounted and intact.
//
// `header` is a render-prop of the open state so callers can show a compact
// summary (image, status) only while collapsed and drop it once the full body
// is visible. The whole header bar toggles; interactive children inside the
// header (a `Copyable` name) stop propagation, so they act without toggling.
//
// `signal` lets a parent drive every card at once (an "Expand all" button)
// while still allowing per-card toggles in between: when the signal's `nonce`
// changes, the card snaps to the signalled `open`. See `useCollapseGroup`.
export type CollapseSignal = { open: boolean; nonce: number };

export function CollapsibleCard({
  t,
  header,
  children,
  defaultOpen = false,
  signal,
}: {
  t: Tokens;
  header: (open: boolean) => ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  signal?: CollapseSignal;
}) {
  const [open, setOpen] = useState(signal ? signal.open : defaultOpen);
  const toggle = () => setOpen((o) => !o);
  // Follow bulk expand/collapse: re-run only when the nonce ticks, so an
  // individual toggle isn't clobbered on every parent re-render.
  useEffect(() => {
    if (signal) setOpen(signal.open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal?.nonce]);
  return (
    <div
      style={{
        border: `1px solid ${t.borderSoft}`,
        borderRadius: R_LG,
        marginBottom: 10,
        background: t.surface,
        overflow: "hidden",
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 12px",
          background: t.surfaceAlt,
          borderBottom: open ? `1px solid ${t.borderSoft}` : "none",
          cursor: "pointer",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            color: t.textMuted,
            transform: open ? "rotate(0deg)" : "rotate(-90deg)",
            transition: "transform .12s ease",
            flexShrink: 0,
          }}
        >
          {Icons.chevD}
        </span>
        {header(open)}
      </div>
      {/* display toggle (not unmount) keeps embedded editors' state alive */}
      <div style={{ padding: "4px 12px", display: open ? "block" : "none" }}>
        {children}
      </div>
    </div>
  );
}

// Drives a group of CollapsibleCards from one "Expand all / Collapse all"
// control. `signal` is handed to every card; `expandAll` / `collapseAll` bump
// its nonce so the cards snap open/closed. `allOpen` reflects the last bulk
// action — what the toggle button should do next — not each card's live state
// (individual toggles intentionally don't flip the bulk label).
export function useCollapseGroup(defaultOpen = false) {
  const [open, setOpen] = useState(defaultOpen);
  const [nonce, setNonce] = useState(0);
  const setAll = (v: boolean) => {
    setOpen(v);
    setNonce((n) => n + 1);
  };
  return {
    signal: { open, nonce } as CollapseSignal,
    allOpen: open,
    expandAll: () => setAll(true),
    collapseAll: () => setAll(false),
    toggleAll: () => setAll(!open),
  };
}

// Compact "Expand all / Collapse all" toggle for a CollapsibleCard group.
// Drop into a Section's `right` slot next to the count.
export function ExpandAllButton({
  t,
  allOpen,
  onToggle,
}: {
  t: Tokens;
  allOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={allOpen}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: 0,
        border: "none",
        background: "transparent",
        color: t.textDim,
        cursor: "pointer",
        fontSize: FS_XS,
        fontFamily: FF_MONO,
        textTransform: "uppercase",
        letterSpacing: 0.4,
        fontWeight: 700,
      }}
    >
      {allOpen ? "Collapse all" : "Expand all"}
    </button>
  );
}

// ── useCopyFlash ───────────────────────────────────────────────────────────
// Hook that returns (ref, flash). Apply the ref to the element you want to
// pulse, call flash() to trigger the .fs-copy-flash animation. Re-runnable
// (removes + re-adds the class on the next frame).
export function useCopyFlash<T extends HTMLElement = HTMLSpanElement>() {
  const ref = useRef<T | null>(null);
  const flash = () => {
    const node = ref.current;
    if (!node) return;
    node.classList.remove("fs-copy-flash");
    void node.offsetWidth;
    node.classList.add("fs-copy-flash");
  };
  return [ref, flash] as const;
}

function copyToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(logErr("detail"));
  }
}

// The tooltip echoes the value so the operator can confirm what they'll copy.
// But a multi-line or very long value (a whole ConfigMap blob, a JSON manifest)
// turns that hint into an unreadable wall of text — and the value is already
// visible in the panel right under the cursor. Past this point, drop the echo
// and keep just the gesture.
const COPY_HINT_MAX = 80;

export function copyHint(text: string): string {
  if (text.length > COPY_HINT_MAX || text.includes("\n")) return "Click to copy";
  return `Click to copy · ${text}`;
}

// ── Copyable ───────────────────────────────────────────────────────────────
// Click-to-copy wrapper. Wraps any value node — on click it copies the given
// text to the clipboard and pulses the wrapped element via `fs-copy-flash`.
// Quiet by design (R-14): no toast, no icon, just a sub-half-second tint.
export function Copyable({
  text,
  children,
  block,
  label,
}: {
  text: string;
  children: ReactNode;
  block?: boolean;
  // Override the default "Click to copy · {text}" tooltip. Pass any
  // ReactNode (often a multi-line description) and the copy-hint will be
  // appended on the last line so the gesture stays discoverable.
  label?: ReactNode;
}) {
  const [ref, flash] = useCopyFlash();
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    copyToClipboard(text);
    flash();
  };
  const hint = copyHint(text);
  const tooltip: ReactNode =
    label != null ? (
      <span style={{ display: "block" }}>
        {label}
        <span style={{ display: "block", opacity: 0.7, marginTop: 4 }}>
          {hint}
        </span>
      </span>
    ) : (
      hint
    );
  return (
    <Tooltip label={tooltip}>
      <span
        ref={ref}
        className="fs-copyable"
        onClick={onCopy}
        style={{
          display: block ? "block" : "inline-flex",
          alignItems: "center",
          padding: "1px 4px",
          margin: "-1px -4px",
          maxWidth: "100%",
        }}
      >
        {children}
      </span>
    </Tooltip>
  );
}

// ── LinkValue ──────────────────────────────────────────────────────────────
// A value that's both a navigation target (left-click → opens that object's
// detail panel) and copyable (Cmd/Ctrl-click → copies without navigating).
// Falls back to plain copy when `enabled === false`.
export function LinkValue({
  t,
  onClick,
  copyText,
  enabled,
  tone = "accent",
  truncate = false,
  children,
}: {
  t: Tokens;
  onClick: () => void;
  copyText: string;
  enabled: boolean;
  /// `muted` keeps the click target but drops the accent colour, so a
  /// secondary reference (the node a pod landed on) doesn't compete with the
  /// object's own name. Matches how the table renders its namespace / node
  /// cells: ordinary text, pointer cursor as the only affordance.
  tone?: "accent" | "muted";
  /// Ellipsize instead of wrapping. For long values in a fixed-width row —
  /// the full string is still in the tooltip and on copy.
  truncate?: boolean;
  children: ReactNode;
}) {
  const [ref, flash] = useCopyFlash();
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey || !enabled) {
      copyToClipboard(copyText);
      flash();
      return;
    }
    onClick();
  };
  return (
    <Tooltip
      label={
        enabled
          ? `Open detail · ${copyText} (${MOD_KEY}-click to copy)`
          : `Click to copy · ${copyText}`
      }
    >
      <span
        ref={ref}
        className="fs-copyable"
        onClick={handleClick}
        style={{
          display: truncate ? "block" : "inline-flex",
          // Only meaningful in the inline-flex layout; `block` ignores it.
          ...(truncate ? null : { alignItems: "center" as const }),
          fontFamily: FF_MONO,
          fontSize: FS_MD,
          color: tone === "muted" ? t.textMuted : enabled ? t.accent : t.text,
          textDecoration: "none",
          padding: "1px 4px",
          margin: "-1px -4px",
          cursor: enabled ? "pointer" : "copy",
          ...(truncate
            ? {
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap" as const,
              }
            : null),
        }}
      >
        {children}
      </span>
    </Tooltip>
  );
}

// ── ConditionChip ──────────────────────────────────────────────────────────
// Coloured chip for boolean-shaped status values. Used by Pod conditions,
// Deployment conditions, Node conditions — anywhere the K8s API surfaces a
// `{ type, status }` object where status is one of "True" / "False" /
// "Unknown".
export type ConditionStatus = "True" | "False" | "Unknown" | string;

export function ConditionChip({
  t,
  cond,
  // For some kinds (NodeReady, NodeMemoryPressure) "True" means bad and
  // "False" means good. Pass an inverter so the colour bucket follows
  // semantics rather than the literal string.
  invert = false,
}: {
  t: Tokens;
  cond: { type: string; status: ConditionStatus };
  invert?: boolean;
}) {
  const isTrue = cond.status === "True";
  const ok = invert ? !isTrue : isTrue;
  const bg = ok ? "rgba(16,185,129,0.16)" : "rgba(244,63,94,0.16)";
  const fg = ok ? t.good : t.bad;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 7px",
        borderRadius: R_SM,
        fontSize: FS_SM,
        fontWeight: 600,
        background: bg,
        color: fg,
      }}
    >
      {cond.type}
    </span>
  );
}

// ── ChipStrip ──────────────────────────────────────────────────────────────
// Sequence of small chips with optional bad/warn tones. Used by per-container
// security context, host-namespace flags, anything that's "a list of named
// boolean / string flags". A more general form than `ChipWrap` because the
// caller passes data, not pre-rendered chips.
export type ChipStripItem = {
  label: string;
  tone?: "default" | "warn" | "bad";
  // Optional copy text — when present, the chip becomes click-to-copy.
  copy?: string;
};

export function ChipStrip({
  t,
  items,
  mono = true,
}: {
  t: Tokens;
  items: ChipStripItem[];
  mono?: boolean;
}) {
  return (
    <ChipWrap>
      {items.map((it, i) => {
        const bg =
          it.tone === "bad"
            ? "rgba(244,63,94,0.16)"
            : it.tone === "warn"
              ? "rgba(245,158,11,0.16)"
              : t.chip;
        const fg =
          it.tone === "bad" ? t.bad : it.tone === "warn" ? t.warn : t.textDim;
        const chip = (
          <span
            key={i}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "1px 7px",
              borderRadius: R_SM,
              fontSize: FS_SM,
              fontWeight: 600,
              fontFamily: mono ? FF_MONO : "inherit",
              background: bg,
              color: fg,
            }}
          >
            {it.label}
          </span>
        );
        return it.copy ? (
          <Copyable key={i} text={it.copy}>
            {chip}
          </Copyable>
        ) : (
          chip
        );
      })}
    </ChipWrap>
  );
}

// ── KeyValueChips ──────────────────────────────────────────────────────────
// Convenience wrapper over `ChipWrap` + `Copyable` + `Chip` for the common
// "render a list of [key, value] tuples as copyable chips" pattern (labels,
// node selectors, annotation entries, …).
//
// Long values (over `LONG_VALUE_THRESHOLD` chars or containing a newline)
// blow up the chip row — `kubectl.kubernetes.io/last-applied-configuration`
// alone is a 5–20 KB JSON blob. Those are split out and rendered as
// collapsed rows below the regular chips: header showing key + size +
// copy, click to expand into a scrollable code block (auto-pretty-prints
// JSON when it parses).
export function KeyValueChips({
  t,
  pairs,
}: {
  t: Tokens;
  pairs: [string, string][];
}) {
  const { short, long } = useMemo(() => {
    const s: [string, string][] = [];
    const l: [string, string][] = [];
    for (const p of pairs) {
      (isLongValue(p[1]) ? l : s).push(p);
    }
    return { short: s, long: l };
  }, [pairs]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minWidth: 0,
      }}
    >
      {short.length > 0 && (
        <ChipWrap>
          {short.map(([k, v]) => (
            <Copyable key={k} text={`${k}=${v}`}>
              <Chip t={t} mono>
                {k}={v}
              </Chip>
            </Copyable>
          ))}
        </ChipWrap>
      )}
      {long.map(([k, v]) => (
        <LongValueRow key={k} t={t} k={k} v={v} />
      ))}
    </div>
  );
}

const LONG_VALUE_THRESHOLD = 100;

function isLongValue(v: string): boolean {
  return v.length > LONG_VALUE_THRESHOLD || v.includes("\n");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Pretty-print obvious JSON; otherwise return the raw string. Trim before
// parsing so leading whitespace from controller-managed annotations doesn't
// break the heuristic. Failures are silent (the raw value is the next-best
// thing the operator can read).
function tryFormat(v: string): string {
  const trimmed = v.trim();
  const looksJson =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (looksJson) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      /* fall through */
    }
  }
  return v;
}

// Long-value row: collapsed by default, expands to a scrollable mono code
// block. Pretty-prints JSON when it parses.
function LongValueRow({ t, k, v }: { t: Tokens; k: string; v: string }) {
  const [open, setOpen] = useState(false);
  const formatted = useMemo(() => tryFormat(v), [v]);
  // `Blob` measures bytes (UTF-8), not chars — what the operator cares
  // about for "how much value is this".
  const size = useMemo(() => formatBytes(new Blob([v]).size), [v]);

  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          border: `1px solid ${t.borderSoft}`,
          borderRadius: R_SM,
          background: t.surface,
          height: 22,
          maxWidth: "100%",
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title={open ? "Collapse" : "Expand"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "0 8px",
            border: "none",
            background: "transparent",
            color: t.text,
            cursor: "pointer",
            fontFamily: FF_MONO,
            fontSize: FS_SM,
            height: "100%",
            minWidth: 0,
            maxWidth: "100%",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              color: t.textMuted,
              transform: open ? "rotate(0deg)" : "rotate(-90deg)",
              transition: "transform .12s ease",
            }}
          >
            {Icons.chevD}
          </span>
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {k}
          </span>
          <span style={{ color: t.textMuted, flexShrink: 0 }}>· {size}</span>
        </button>
        <Copyable text={v}>
          <span
            title="Copy value"
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "0 6px",
              borderLeft: `1px solid ${t.borderSoft}`,
              color: t.textMuted,
              cursor: "pointer",
              height: "100%",
            }}
          >
            {Icons.copy}
          </span>
        </Copyable>
      </div>
      {open && (
        <pre
          style={{
            margin: "4px 0 0 0",
            padding: "8px 10px",
            background: t.surface,
            border: `1px solid ${t.borderSoft}`,
            borderRadius: R_SM,
            fontFamily: FF_MONO,
            fontSize: FS_SM,
            lineHeight: 1.4,
            color: t.text,
            maxHeight: 320,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {formatted}
        </pre>
      )}
    </div>
  );
}

// ── SubGrid ────────────────────────────────────────────────────────────────
// Sub-row primitive — label/value pairs displayed under a parent DetailRow,
// indented and dimmer than the parent. Use when a parent concept (Resources,
// Run As, Environment, …) decomposes into a fixed set of named children.
// Each entry's value is automatically click-to-copy.
//
// Pass `groups` for multi-group layout (Resources → Requests + Limits) or
// `entries` for a single flat list. Mutually exclusive — pick one per call.
export type SubEntry = {
  key: string;
  // Visible label (often the same as `key`, but separated so callers can
  // localise / prettify without losing the copy text).
  label?: ReactNode;
  // Stringified value used both for the visible content and the clipboard
  // text. Pass `children` separately if you need richer rendering.
  value?: string | null;
  children?: ReactNode;
  // Optional one-line subtext under the value (e.g. "from chi-pv-common (rw)"
  // for a volume mount). Muted by default.
  hint?: ReactNode;
  // Bumps the visual emphasis when the value should stand out (e.g. a
  // non-zero exit code). Otherwise renders in the default dim tone.
  tone?: "default" | "warn" | "bad";
};

export type SubGroup = {
  // Group label rendered inline before the first entry, e.g. "Requests".
  // Optional — single-group SubGrids can omit.
  label?: ReactNode;
  entries: SubEntry[];
};

export function SubGrid({
  t,
  groups,
  entries,
  mono = true,
  copyKeyJoin = "=",
}: {
  t: Tokens;
  groups?: SubGroup[];
  entries?: SubEntry[];
  mono?: boolean;
  // How to compose the clipboard string for a `value` entry:
  // "=" → key=value (env / labels / resources)
  // ":" → key: value (status messages, generic)
  copyKeyJoin?: "=" | ":";
}) {
  const resolvedGroups: SubGroup[] = groups ?? [{ entries: entries ?? [] }];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        width: "100%",
      }}
    >
      {resolvedGroups.map((g, gi) => (
        <div
          key={gi}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {g.label != null && (
            <div
              style={{
                fontSize: FS_XS,
                fontWeight: 700,
                color: t.textMuted,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                fontFamily: FF_MONO,
                marginBottom: 2,
              }}
            >
              {g.label}
            </div>
          )}
          {g.entries.map((e) => (
            <SubEntryRow
              key={e.key}
              t={t}
              entry={e}
              mono={mono}
              copyKeyJoin={copyKeyJoin}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function SubEntryRow({
  t,
  entry,
  mono,
  copyKeyJoin,
}: {
  t: Tokens;
  entry: SubEntry;
  mono: boolean;
  copyKeyJoin: "=" | ":";
}) {
  const valueColor =
    entry.tone === "bad"
      ? t.bad
      : entry.tone === "warn"
        ? t.warn
        : t.text;
  const labelText = entry.label ?? entry.key;
  const copyText =
    entry.value != null
      ? `${entry.key}${copyKeyJoin === "=" ? "=" : ": "}${entry.value}`
      : entry.key;
  const innerStyle: CSSProperties = {
    display: "flex",
    alignItems: "baseline",
    gap: 6,
    minWidth: 0,
    fontFamily: mono ? FF_MONO : "inherit",
    fontSize: FS_SM,
    lineHeight: 1.45,
  };
  const inner = (
    <div style={innerStyle}>
      <span style={{ color: t.textMuted, flexShrink: 0 }}>{labelText}</span>
      {entry.value != null && (
        <>
          <span style={{ color: t.textMuted }}>
            {copyKeyJoin === "=" ? "=" : ":"}
          </span>
          <span
            style={{
              color: valueColor,
              wordBreak: "break-all",
              minWidth: 0,
            }}
          >
            {entry.value}
          </span>
        </>
      )}
      {entry.children != null && (
        <span style={{ minWidth: 0, color: valueColor }}>{entry.children}</span>
      )}
    </div>
  );
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 1,
        paddingLeft: 8,
        borderLeft: `2px solid ${t.borderSoft}`,
      }}
    >
      <Copyable text={copyText}>{inner}</Copyable>
      {entry.hint != null && (
        <div
          style={{
            fontSize: FS_SM,
            color: t.textMuted,
            paddingLeft: 2,
          }}
        >
          {entry.hint}
        </div>
      )}
    </div>
  );
}
