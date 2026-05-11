// Reusable detail-panel primitives. See CLAUDE.md §"Detail-panel primitives".
//
// Every component here is kind-agnostic: it takes layout / interaction props
// only, never a Kubernetes-shape value. Pod / Deployment / Node / etc. summary
// components compose these — they never reach in.

import {
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { FF_MONO, type Tokens, R_SM, FS_MD, FS_SM, FS_XS } from "../../theme";
import { Chip, Icons, Tooltip } from "../ui";

// ── Cross-kind navigation ──────────────────────────────────────────────────
// Hook handed down from DetailPanel → summary component → LinkValue. Maps a
// Kubernetes Kind name (e.g. "StatefulSet") + (namespace, name) to a
// detail-panel switch. The parent (ResourceTable) resolves the kind name
// against the registry and falls back silently if the kind isn't browseable.
export type DetailNavigate = (
  kindName: string,
  namespace: string | null,
  name: string,
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
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "180px 1fr",
        gap: 16,
        alignItems: "baseline",
        padding: "8px 0",
        borderBottom: `1px solid ${t.borderSoft}`,
      }}
    >
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
    navigator.clipboard.writeText(text).catch(() => {});
  }
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
  const tooltip: ReactNode =
    label != null ? (
      <span style={{ display: "block" }}>
        {label}
        <span style={{ display: "block", opacity: 0.7, marginTop: 4 }}>
          Click to copy · {text}
        </span>
      </span>
    ) : (
      `Click to copy · ${text}`
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
  children,
}: {
  t: Tokens;
  onClick: () => void;
  copyText: string;
  enabled: boolean;
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
          ? `Open detail · ${copyText} (⌘/Ctrl-click to copy)`
          : `Click to copy · ${copyText}`
      }
    >
      <span
        ref={ref}
        className="fs-copyable"
        onClick={handleClick}
        style={{
          display: "inline-flex",
          alignItems: "center",
          fontFamily: FF_MONO,
          fontSize: FS_MD,
          color: enabled ? t.accent : t.text,
          textDecoration: "none",
          padding: "1px 4px",
          margin: "-1px -4px",
          cursor: enabled ? "pointer" : "copy",
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
