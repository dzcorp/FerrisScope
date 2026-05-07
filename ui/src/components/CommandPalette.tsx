import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAppStore } from "../store";
import { tokens, FONT_MONO, type ThemeMode } from "../theme";
import { Icons, Kbd, resolveKindIcon } from "./ui";
import { MOD_KEY } from "../lib/keyboard";
import { api } from "../api";
import type { SearchHit } from "../types";

type Item = {
  id: string;
  group: string;
  icon: ReactNode;
  label: string;
  sub: string;
  keywords: string;
  mono?: boolean;
  /// `true` for resource hits coming from the cluster's FTS5 index. They
  /// bypass the keyword pre-filter (the backend has already matched them)
  /// and render before static items so the most-relevant signal is at top.
  preFiltered?: boolean;
  action: () => void;
};

type Props = {
  mode: ThemeMode;
  onClose: () => void;
};

// HV2Palette — global ⌘K. Switch context, change resource kind, open settings,
// trigger actions, jump to a resource by name. Lazy: items derived from
// current store state. Per P3, every common path has a keyboard route here.
//
// Filtering the visible table is a separate concern (the inline input in
// `AppHeader`); this palette stays purely for global jump-to.
export function CommandPalette({ mode, onClose }: Props) {
  const t = tokens(mode);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  const contexts = useAppStore((s) => s.contexts);
  const kinds = useAppStore((s) => s.kinds);
  const selectedContext = useAppStore((s) => s.selectedContext);
  const selectContext = useAppStore((s) => s.selectContext);
  const selectKind = useAppStore((s) => s.selectKind);
  const navigateToDetail = useAppStore((s) => s.navigateToDetail);
  const openSettings = useAppStore((s) => s.openSettings);
  const openNsModal = useAppStore((s) => s.openNsModal);
  const toggleTheme = useAppStore((s) => s.toggleTheme);

  const [hits, setHits] = useState<SearchHit[]>([]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setHi(0);
  }, [q]);
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  // Debounced full-text search against the cluster's index. Fires only when
  // a cluster is selected and the trimmed query has at least 2 chars (the
  // backend short-circuits below that anyway). 100ms catches a typing burst
  // without making the palette feel laggy.
  useEffect(() => {
    const trimmed = q.trim();
    if (!selectedContext || trimmed.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      api
        .searchClusterIndex(selectedContext, trimmed, 30)
        .then((res) => {
          if (!cancelled) setHits(res);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [q, selectedContext]);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];

    contexts.forEach((c) => {
      list.push({
        id: `cluster:${c.id}`,
        group: "Switch context",
        icon: (
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: c.is_current ? t.good : t.unknown,
              display: "inline-block",
            }}
          />
        ),
        label: c.name,
        sub: `${c.group} · ${c.cluster}${c.namespace ? ` · ns:${c.namespace}` : ""}`,
        keywords: `${c.name} ${c.group} ${c.cluster} ${c.namespace ?? ""} ${c.user ?? ""}`.toLowerCase(),
        mono: true,
        action: () => selectContext(c.id),
      });
    });

    if (selectedContext) {
      kinds.forEach((k) => {
        list.push({
          id: `kind:${k.id}`,
          group: "Resources",
          icon: (
            <span
              style={{
                width: 13,
                height: 13,
                display: "inline-flex",
                color: t.textMuted,
              }}
            >
              {resolveKindIcon(k.kind, k.group, k.category)}
            </span>
          ),
          label: k.kind,
          sub: `${k.category} · ${k.group ? `${k.group}/${k.version}` : k.version}`,
          keywords: `${k.kind} ${k.plural} ${k.id} ${k.category}`.toLowerCase(),
          action: () => selectKind(k.id),
        });
      });

      list.push({
        id: "cmd:filter-ns",
        group: "Actions",
        icon: (
          <span
            style={{
              width: 13,
              height: 13,
              display: "inline-flex",
              color: t.textMuted,
            }}
          >
            {Icons.layers}
          </span>
        ),
        label: "Filter by namespace…",
        sub: "Pick which namespaces to show in the current table",
        keywords: "namespace filter scope",
        action: () => openNsModal(),
      });
    }

    list.push({
      id: "cmd:settings",
      group: "Actions",
      icon: (
        <span
          style={{
            width: 13,
            height: 13,
            display: "inline-flex",
            color: t.textMuted,
          }}
        >
          {Icons.settings}
        </span>
      ),
      label: "Open settings",
      sub: "Theme, density, kubeconfig, shortcuts",
      keywords: "settings preferences theme",
      action: () => openSettings(),
    });

    list.push({
      id: "cmd:theme",
      group: "Actions",
      icon: (
        <span
          style={{
            width: 13,
            height: 13,
            display: "inline-flex",
            color: t.textMuted,
          }}
        >
          {mode === "dark" ? Icons.sun : Icons.moon}
        </span>
      ),
      label: "Toggle theme",
      sub: `Switch to ${mode === "dark" ? "light" : "dark"} mode`,
      keywords: "theme dark light",
      action: () => toggleTheme(),
    });

    if (selectedContext) {
      list.push({
        id: "cmd:home",
        group: "Actions",
        icon: (
          <span
            style={{
              width: 13,
              height: 13,
              display: "inline-flex",
              color: t.textMuted,
            }}
          >
            {Icons.cluster}
          </span>
        ),
        label: "Disconnect from cluster",
        sub: "Return to the fleet landing screen",
        keywords: "disconnect home fleet",
        action: () => selectContext(null),
      });
    }

    return list;
  }, [
    contexts,
    kinds,
    selectedContext,
    selectContext,
    selectKind,
    openSettings,
    openNsModal,
    toggleTheme,
    mode,
    t,
  ]);

  // Resource hits from the cluster index. These are pre-filtered by the
  // backend's FTS5 + bm25 ranking, so we surface them ahead of the static
  // (context / kind / action) items and skip the keyword pre-filter.
  const hitItems = useMemo<Item[]>(() => {
    if (hits.length === 0) return [];
    const kindByIdAttempt = new Map(kinds.map((k) => [k.id, k]));
    return hits.map((h) => {
      const kind = kindByIdAttempt.get(h.kind_id);
      const kindLabel = kind?.kind ?? h.kind_id;
      return {
        id: `hit:${h.kind_id}:${h.uid}`,
        group: "Cluster objects",
        icon: (
          <span
            style={{
              width: 13,
              height: 13,
              display: "inline-flex",
              color: t.textMuted,
            }}
          >
            {kind
              ? resolveKindIcon(kind.kind, kind.group, kind.category)
              : Icons.pod}
          </span>
        ),
        label: h.name,
        sub: h.namespace
          ? `${kindLabel} · ns:${h.namespace}`
          : `${kindLabel}`,
        keywords: `${h.name} ${h.namespace ?? ""} ${h.kind_id}`.toLowerCase(),
        mono: true,
        preFiltered: true,
        action: () => navigateToDetail(h.kind_id, h.namespace, h.name),
      };
    });
  }, [hits, kinds, t, navigateToDetail]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items.slice(0, 18);
    const matchingStatic = items
      .filter(
        (i) =>
          i.keywords.includes(needle) ||
          i.label.toLowerCase().includes(needle),
      )
      .slice(0, 18);
    return [...hitItems, ...matchingStatic].slice(0, 36);
  }, [q, items, hitItems]);

  const groups = useMemo(() => {
    const m = new Map<string, (Item & { _idx: number })[]>();
    filtered.forEach((it, idx) => {
      const arr = m.get(it.group) ?? [];
      arr.push({ ...it, _idx: idx });
      m.set(it.group, arr);
    });
    return Array.from(m.entries());
  }, [filtered]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const sel = filtered[hi];
      if (sel) {
        sel.action();
        onClose();
      }
    }
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          left: 0,
          background: "rgba(8,10,14,0.32)",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
          zIndex: 50,
          animation: "fs-fade-in .12s ease",
        }}
      />
      <div
        style={{
          position: "fixed",
          top: "calc(14% + var(--fs-titlebar-h, 0px))",
          left: "50%",
          transform: "translateX(-50%)",
          width: 580,
          maxWidth: "92vw",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          background: t.paletteBg,
          border: `1px solid ${t.paletteBorder}`,
          borderRadius: 12,
          boxShadow: "0 24px 56px rgba(0,0,0,0.25)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          zIndex: 51,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 18px",
            borderBottom: `1px solid ${t.borderSoft}`,
          }}
        >
          <span style={{ color: t.textMuted, display: "inline-flex" }}>
            {Icons.search}
          </span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              selectedContext
                ? `Search in ${selectedContext}, switch context, jump to a kind…`
                : "Search contexts, type a name…"
            }
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              color: t.text,
              fontSize: 14,
              fontFamily: "inherit",
            }}
          />
          <Kbd t={t}>esc</Kbd>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "8px 0" }}>
          {filtered.length === 0 ? (
            <div
              style={{
                padding: "32px 20px",
                textAlign: "center",
                color: t.textMuted,
                fontSize: 13,
              }}
            >
              No matches for "<span style={{ color: t.textDim }}>{q}</span>"
            </div>
          ) : (
            groups.map(([groupName, list]) => (
              <div key={groupName} style={{ marginBottom: 4 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: t.textMuted,
                    textTransform: "uppercase",
                    letterSpacing: 0.6,
                    fontFamily: FONT_MONO,
                    padding: "8px 18px 4px",
                  }}
                >
                  {groupName}
                </div>
                {list.map((it) => {
                  const isHi = filtered[hi]?.id === it.id;
                  return (
                    <button
                      key={it.id}
                      type="button"
                      ref={isHi ? activeItemRef : null}
                      onClick={() => {
                        it.action();
                        onClose();
                      }}
                      onMouseEnter={() => setHi(it._idx)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "8px 18px",
                        border: "none",
                        background: isHi ? t.accentSoft : "transparent",
                        color: "inherit",
                        cursor: "pointer",
                        fontFamily: "inherit",
                        textAlign: "left",
                      }}
                    >
                      <div
                        style={{
                          width: 16,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: isHi ? t.accent : t.textMuted,
                          flexShrink: 0,
                        }}
                      >
                        {it.icon}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 500,
                            fontFamily: it.mono ? FONT_MONO : "inherit",
                            color: t.text,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {it.label}
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: t.textMuted,
                            marginTop: 1,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {it.sub}
                        </div>
                      </div>
                      {isHi && (
                        <span
                          style={{
                            fontSize: 10,
                            color: t.textMuted,
                            fontFamily: FONT_MONO,
                          }}
                        >
                          ↵
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "10px 18px",
            borderTop: `1px solid ${t.borderSoft}`,
            fontSize: 10.5,
            color: t.textMuted,
          }}
        >
          <span>
            <Kbd t={t}>↑↓</Kbd> navigate
          </span>
          <span>
            <Kbd t={t}>↵</Kbd> select
          </span>
          <span>
            <Kbd t={t}>esc</Kbd> close
          </span>
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: FONT_MONO }}>FerrisScope {MOD_KEY}K</span>
        </div>
      </div>
    </>
  );
}
