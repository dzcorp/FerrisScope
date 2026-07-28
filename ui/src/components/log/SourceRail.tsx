import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Tokens } from "../../theme";
import { FF_MONO, FS_SM, FS_XS } from "../../theme";
import { TextInput } from "../ui";
import { MAX_LOG_SOURCES } from "../../lib/logSources";
import {
  defaultSelection,
  filterPods,
  selectionStreamCount,
  type SelectablePod,
} from "../../lib/logSelection";

// Pod picker for an aggregated log view.
//
// The stream budget (`MAX_LOG_SOURCES`) is much smaller than what a real
// selection resolves to — ten Deployments at fifty replicas is 500 pods for 24
// slots. This rail is where the operator says *which* 24; without it the view
// took whichever pods sorted first and reported "+476 over cap", presenting an
// arbitrary answer as a complete one.
//
// Rows virtualize past `VIRTUALIZE_AT`: a 500-pod DaemonSet is a real
// selection, and rendering it flat costs more DOM than the log body itself.

const ROW_H = 24;
const VIRTUALIZE_AT = 40;
const LIST_MAX_H = 260;

export function SourceRail({
  t,
  pods,
  selected,
  onChange,
  onClose,
}: {
  t: Tokens;
  pods: SelectablePod[];
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterPods(pods, query), [pods, query]);
  const used = selectionStreamCount(pods, selected);
  const overBudget = used > MAX_LOG_SOURCES;

  const toggle = (p: SelectablePod) => {
    const next = new Set(selected);
    if (next.has(p.key)) next.delete(p.key);
    else next.add(p.key);
    onChange(next);
  };

  // "Fit" re-runs the greedy default over the *filtered* list, so an operator
  // can narrow to one namespace and fill the budget from it.
  const fitVisible = () => onChange(defaultSelection(filtered));
  const clearVisible = () => {
    const next = new Set(selected);
    for (const p of filtered) next.delete(p.key);
    onChange(next);
  };

  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: "var(--fs-radius-md, 6px)",
        background: t.surface,
        padding: 8,
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <TextInput
          t={t}
          value={query}
          onChange={setQuery}
          placeholder="Filter pods…"
          style={{ flex: 1, minWidth: 0, height: 26, fontSize: FS_SM }}
        />
        <RailBtn t={t} label="Fit" title="Select as many visible pods as the stream budget allows" onClick={fitVisible} />
        <RailBtn t={t} label="Clear" title="Deselect every visible pod" onClick={clearVisible} />
        <RailBtn t={t} label="Done" title="Hide the pod picker" onClick={onClose} />
      </div>

      <div
        style={{
          fontSize: FS_XS,
          fontFamily: FF_MONO,
          color: overBudget ? t.bad : t.textMuted,
          marginBottom: 6,
        }}
      >
        {used}/{MAX_LOG_SOURCES} streams · {selected.size} of {pods.length} pods
        {query.trim() !== "" ? ` · ${filtered.length} shown` : ""}
        {overBudget
          ? " — over budget, the extra streams won't start until you deselect some"
          : ""}
      </div>

      {filtered.length === 0 ? (
        <div
          style={{
            fontSize: FS_SM,
            fontFamily: FF_MONO,
            color: t.textMuted,
            padding: "8px 2px",
          }}
        >
          No pods match “{query}”.
        </div>
      ) : (
        <PodList
          t={t}
          pods={filtered}
          selected={selected}
          onToggle={toggle}
        />
      )}
    </div>
  );
}

function PodList({
  t,
  pods,
  selected,
  onToggle,
}: {
  t: Tokens;
  pods: SelectablePod[];
  selected: ReadonlySet<string>;
  onToggle: (p: SelectablePod) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtual = pods.length > VIRTUALIZE_AT;
  const virtualizer = useVirtualizer({
    count: virtual ? pods.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
  });

  const body = virtual ? (
    <div
      style={{
        height: virtualizer.getTotalSize(),
        position: "relative",
        width: "100%",
      }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const p = pods[item.index];
        if (!p) return null;
        return (
          <div
            key={item.key}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${item.start}px)`,
            }}
          >
            <PodRow
              t={t}
              p={p}
              checked={selected.has(p.key)}
              onToggle={() => onToggle(p)}
            />
          </div>
        );
      })}
    </div>
  ) : (
    pods.map((p) => (
      <PodRow
        key={p.key}
        t={t}
        p={p}
        checked={selected.has(p.key)}
        onToggle={() => onToggle(p)}
      />
    ))
  );

  return (
    <div
      ref={scrollRef}
      role="group"
      aria-label="Pods to stream"
      style={{ maxHeight: LIST_MAX_H, overflowY: "auto" }}
    >
      {body}
    </div>
  );
}

function PodRow({
  t,
  p,
  checked,
  onToggle,
}: {
  t: Tokens;
  p: SelectablePod;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      title={`${p.namespace}/${p.name}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: ROW_H,
        padding: "0 2px",
        cursor: "pointer",
        fontFamily: FF_MONO,
        fontSize: FS_SM,
        color: checked ? t.text : t.textMuted,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        style={{ margin: 0, flexShrink: 0, accentColor: t.accent }}
      />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {p.name}
      </span>
      <span style={{ fontSize: FS_XS, color: t.textMuted, flexShrink: 0 }}>
        {/* A pod with every container muted contributes nothing; say so rather
            than showing a bare "0" that reads like a bug. */}
        {p.streamCount === 0 ? "muted" : `${p.streamCount}×`}
      </span>
    </label>
  );
}

function RailBtn({
  t,
  label,
  title,
  onClick,
}: {
  t: Tokens;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        height: 26,
        padding: "0 10px",
        borderRadius: "var(--fs-radius-sm, 4px)",
        border: `1px solid ${t.border}`,
        background: t.surfaceAlt,
        color: t.textDim,
        fontFamily: FF_MONO,
        fontSize: FS_XS,
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}
