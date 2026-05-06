import { useEffect, useState } from "react";
import { api, onFleetProbe, onKubeconfigChanged } from "../api";
import { useAppStore } from "../store";
import type { ClusterProbe, ContextInfo } from "../types";
import { tokens, FONT_MONO, type ThemeMode } from "../theme";
import { Eyebrow, EmptyState, Gauge, Loading, Tooltip } from "./ui";
import { ContextMenu, type MenuItem, type MenuPosition } from "./ContextMenu";
import { confirm, toast } from "../lib/dialog";

type Props = {
  mode: ThemeMode;
  onSelect: (id: string) => void;
};

// Cluster fleet — landing screen when no context is selected. Cards are
// driven by two streams:
//   1. ContextInfo[] from kubeconfig (default + user-added sources) — names,
//      default namespace, group, current.
//   2. ClusterProbe per context (keyed by composite id) — version, node/pod
//      count, CPU/Mem load.
// Probes are cached to disk and refreshed hourly so the screen renders
// immediately on startup. The kubeconfig file watcher refetches contexts
// whenever any source changes (default file edited, file in a watched
// folder added/removed, etc.) so the fleet stays live without a reload.
export function FleetLanding({ mode, onSelect }: Props) {
  const t = tokens(mode);
  const {
    contexts,
    contextsStatus,
    contextsError,
    setContexts,
    setContextsLoading,
    setContextsError,
  } = useAppStore();

  const [probes, setProbes] = useState<Record<string, ClusterProbe>>({});
  const [menu, setMenu] = useState<{ pos: MenuPosition; ctx: ContextInfo } | null>(null);

  useEffect(() => {
    setContextsLoading();
    api
      .listContexts()
      .then(setContexts)
      .catch((e: unknown) => setContextsError(String(e)));
  }, [setContexts, setContextsError, setContextsLoading]);

  // Live-refresh on kubeconfig source changes. The backend debounces the
  // notify events ~300ms, so we get one tick per logical change even when an
  // editor does a rename-then-replace.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onKubeconfigChanged(() => {
      if (cancelled) return;
      api.listContexts().then(setContexts).catch((e: unknown) => {
        setContextsError(String(e));
      });
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [setContexts, setContextsError]);

  // Load the cached fleet on first render so the screen has values
  // immediately, then trigger a background refresh for stale entries.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await onFleetProbe((probe) => {
          if (cancelled) return;
          setProbes((prev) => ({ ...prev, [probe.context_name]: probe }));
        });
        const cache = await api.getFleetCache();
        if (!cancelled) setProbes(cache);
      } catch {
        // Best-effort: cache failure is non-fatal.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Settings → General → Refresh-on-launch gates the initial probe; the
  // hourly disk cache already gives us values to render immediately so the
  // operator can opt out of the on-mount network calls.
  const refreshOnLaunch = useAppStore((s) => s.settings.refreshOnLaunch);
  // Settings → General → Refresh interval drives the periodic background
  // re-probe of the visible fleet. 0 disables.
  const refreshSec = useAppStore((s) => s.settings.refreshSec);
  // Fleet-only view mode (tiles | mini | rows). Independent of global
  // density — see prefs::FleetView.
  const fleetView = useAppStore((s) => s.settings.fleetView);

  useEffect(() => {
    if (contexts.length === 0) return;
    if (!refreshOnLaunch) return;
    api
      .refreshFleet(
        contexts.map((c) => c.id),
        false,
      )
      .catch(() => {});
  }, [contexts, refreshOnLaunch]);

  useEffect(() => {
    if (contexts.length === 0) return;
    if (refreshSec <= 0) return;
    const ids = contexts.map((c) => c.id);
    const id = setInterval(() => {
      api.refreshFleet(ids, false).catch(() => {});
    }, refreshSec * 1000);
    return () => clearInterval(id);
  }, [contexts, refreshSec]);

  if (contextsStatus === "loading" || contextsStatus === "idle") {
    return <Loading t={t} label="Loading kubeconfig…" />;
  }

  if (contextsStatus === "error") {
    return (
      <div style={{ flex: 1, padding: "32px 40px" }}>
        <Eyebrow t={t} style={{ color: t.bad, marginBottom: 8 }}>
          Failed to read kubeconfig
        </Eyebrow>
        <pre
          style={{
            fontFamily: FONT_MONO,
            fontSize: 12,
            color: t.bad,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: 0,
          }}
        >
          {contextsError}
        </pre>
      </div>
    );
  }

  if (contexts.length === 0) {
    return (
      <EmptyState
        t={t}
        title="No contexts available"
        hint="Add a kubeconfig file or folder in Settings → Kubeconfig, or set up `~/.kube/config`."
      />
    );
  }

  // Bucket by group; "Default" first, then alphabetical.
  const groups = new Map<string, ContextInfo[]>();
  for (const c of contexts) {
    const arr = groups.get(c.group) ?? [];
    arr.push(c);
    groups.set(c.group, arr);
  }
  const orderedGroups = [...groups.keys()].sort((a, b) => {
    if (a === "Default") return -1;
    if (b === "Default") return 1;
    return a.localeCompare(b);
  });

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "32px 40px 48px" }}>
      <div
        style={{
          marginBottom: 28,
          display: "flex",
          alignItems: "flex-start",
          gap: 16,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: -0.6,
              marginBottom: 4,
              color: t.text,
            }}
          >
            Cluster fleet
          </div>
          <div style={{ fontSize: 13.5, color: t.textDim }}>
            Pick a context to connect. {contexts.length} loaded across{" "}
            {orderedGroups.length} group{orderedGroups.length === 1 ? "" : "s"}.
          </div>
        </div>
        <ViewToggle mode={mode} />
      </div>

      {orderedGroups.map((g) => (
        <FleetGroup
          key={g}
          mode={mode}
          label={g}
          list={groups.get(g) ?? []}
          probes={probes}
          view={fleetView}
          onSelect={onSelect}
          onMenu={(pos, ctx) => setMenu({ pos, ctx })}
        />
      ))}

      {menu && (
        <ContextMenu
          mode={mode}
          position={menu.pos}
          onClose={() => setMenu(null)}
          rowName={primaryLabel(menu.ctx)}
          items={fleetMenuItems(menu.ctx, onSelect)}
        />
      )}
    </div>
  );
}

// Build the right-click menu for a fleet card. Capabilities are gated by the
// context's source: the implicit default kubeconfig only allows context-level
// edits (set-current, delete-context); custom files & folder children also
// allow deleting the file itself. `source_path` carries the on-disk path —
// when it's missing we still allow context-level edits because the backend
// resolves the default kubeconfig path on its own.
function fleetMenuItems(c: ContextInfo, onSelect: (id: string) => void): MenuItem[] {
  const isDefault = c.source_id === "default";
  const items: MenuItem[] = [
    {
      kind: "item",
      label: "Connect",
      onClick: () => onSelect(c.id),
    },
  ];
  if (isDefault) {
    items.push({
      kind: "item",
      label: c.is_current ? "Already current context" : "Set as current context",
      disabled: c.is_current,
      onClick: async () => {
        try {
          await api.setCurrentKubeconfigContext(c.id);
          toast.ok(`Set ${c.name} as current context.`);
        } catch (e: unknown) {
          toast.bad(`Could not set current: ${String(e)}`);
        }
      },
    });
  }
  items.push({ kind: "separator" });
  items.push({
    kind: "item",
    label: "Remove context from kubeconfig",
    danger: true,
    onClick: async () => {
      const ok = await confirm({
        title: "Remove context?",
        body: `This rewrites the kubeconfig file and removes "${c.name}". Comments and unrelated formatting in the file are not preserved.`,
        confirmLabel: "Remove",
        tone: "danger",
      });
      if (!ok) return;
      try {
        await api.deleteKubeconfigContext(c.id);
        toast.ok(`Removed context ${c.name}.`);
      } catch (e: unknown) {
        toast.bad(`Could not remove context: ${String(e)}`);
      }
    },
  });
  if (!isDefault) {
    items.push({
      kind: "item",
      label: "Delete kubeconfig file",
      danger: true,
      onClick: async () => {
        const ok = await confirm({
          title: "Delete kubeconfig file?",
          body: `Permanently delete ${c.source_path ?? "this kubeconfig file"} from disk. Every context inside it will disappear from the fleet.`,
          confirmLabel: "Delete",
          tone: "danger",
        });
        if (!ok) return;
        try {
          await api.deleteKubeconfigFile(c.id);
          toast.ok("Kubeconfig file deleted.");
        } catch (e: unknown) {
          toast.bad(`Could not delete file: ${String(e)}`);
        }
      },
    });
  }
  return items;
}

function FleetGroup({
  mode,
  label,
  list,
  probes,
  view,
  onSelect,
  onMenu,
}: {
  mode: ThemeMode;
  label: string;
  list: ContextInfo[];
  probes: Record<string, ClusterProbe>;
  view: FleetView;
  onSelect: (id: string) => void;
  onMenu: (pos: MenuPosition, ctx: ContextInfo) => void;
}) {
  const t = tokens(mode);
  const header = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 12,
      }}
    >
      <Eyebrow t={t}>{label}</Eyebrow>
      <div style={{ flex: 1, height: 1, background: t.border }} />
      <div
        style={{
          fontSize: 11.5,
          color: t.textMuted,
          fontVariantNumeric: "tabular-nums",
          fontFamily: FONT_MONO,
        }}
      >
        {list.length}
      </div>
    </div>
  );

  if (view === "rows") {
    return (
      <div style={{ marginBottom: 28 }}>
        {header}
        <div
          style={{
            border: `1px solid ${t.border}`,
            borderRadius: 10,
            background: t.surface,
            overflow: "hidden",
          }}
        >
          {list.map((c, i) => (
            <FleetRow
              key={c.id}
              mode={mode}
              context={c}
              probe={probes[c.id] ?? null}
              isLast={i === list.length - 1}
              onSelect={() => onSelect(c.id)}
              onMenu={(pos) => onMenu(pos, c)}
            />
          ))}
        </div>
      </div>
    );
  }

  // Tile / mini grid: each card declares the horizontal room it wants
  // (flex-basis). flex-shrink 0 wraps to the next row instead of squeezing
  // names; flex-grow 1 fills the trailing slack on each row.
  const basisFn = view === "mini" ? miniBasisPx : cardBasisPx;
  return (
    <div style={{ marginBottom: 28 }}>
      {header}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: view === "mini" ? 8 : 12,
          alignItems: "stretch",
        }}
      >
        {list.map((c) => {
          const title = primaryLabel(c);
          const sub = secondaryLabel(c);
          const visibleLen = title.length + (sub ? sub.length + 3 : 0);
          return (
            <div
              key={c.id}
              style={{
                flex: `1 0 ${basisFn(title, sub)}px`,
                minWidth: 0,
                maxWidth: "100%",
              }}
            >
              {view === "mini" ? (
                <MiniCard
                  mode={mode}
                  context={c}
                  probe={probes[c.id] ?? null}
                  onSelect={() => onSelect(c.id)}
                  onMenu={(pos) => onMenu(pos, c)}
                />
              ) : (
                <FleetCard
                  mode={mode}
                  context={c}
                  probe={probes[c.id] ?? null}
                  wide={visibleLen > 36}
                  onSelect={() => onSelect(c.id)}
                  onMenu={(pos) => onMenu(pos, c)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FleetCard({
  mode,
  context,
  probe,
  wide,
  onSelect,
  onMenu,
}: {
  mode: ThemeMode;
  context: ContextInfo;
  probe: ClusterProbe | null;
  wide: boolean;
  onSelect: () => void;
  onMenu: (pos: MenuPosition) => void;
}) {
  const t = tokens(mode);
  const density = useAppStore((s) => s.settings.density);
  const cardPad =
    density === "compact" ? 9 : density === "spacious" ? 18 : 14;
  const cardGap =
    density === "compact" ? 10 : density === "spacious" ? 18 : 14;

  const cpuRatio =
    probe &&
    probe.cpu_used_milli != null &&
    probe.cpu_capacity_milli != null &&
    probe.cpu_capacity_milli > 0
      ? probe.cpu_used_milli / probe.cpu_capacity_milli
      : null;
  const memRatio =
    probe &&
    probe.mem_used_mib != null &&
    probe.mem_capacity_mib != null &&
    probe.mem_capacity_mib > 0
      ? probe.mem_used_mib / probe.mem_capacity_mib
      : null;
  const colorFor = (r: number) => (r > 0.8 ? t.bad : r > 0.65 ? t.warn : t.good);

  // Status dot logic: green when last probe was healthy, red when it
  // explicitly failed, neutral grey when we have no data yet.
  const dotColor =
    probe?.healthy === true
      ? t.good
      : probe?.healthy === false
        ? t.bad
        : t.unknown;

  const card = (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
      style={{
        width: "100%",
        border: `1px solid ${t.border}`,
        borderRadius: 10,
        background: t.surface,
        padding: cardPad,
        textAlign: "left",
        cursor: "pointer",
        fontFamily: "inherit",
        color: "inherit",
        transition: "border-color .15s, background .15s",
        display: "flex",
        alignItems: "center",
        gap: cardGap,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = t.accent;
        e.currentTarget.style.background = t.accentSoft;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = t.border;
        e.currentTarget.style.background = t.surface;
      }}
    >
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <GaugeWithLabel
          mode={mode}
          ratio={cpuRatio}
          color={cpuRatio != null ? colorFor(cpuRatio) : t.unknown}
          label="cpu"
        />
        <GaugeWithLabel
          mode={mode}
          ratio={memRatio}
          color={memRatio != null ? colorFor(memRatio) : t.unknown}
          label="mem"
        />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 3,
            flexWrap: wide ? "wrap" : "nowrap",
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: -0.3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: t.text,
              minWidth: 0,
              flex: wide ? "0 1 auto" : "1 1 auto",
              maxWidth: "100%",
            }}
          >
            {primaryLabel(context)}
            {secondaryLabel(context) && (
              <span
                style={{
                  marginLeft: 6,
                  fontSize: 11.5,
                  fontWeight: 500,
                  color: t.textMuted,
                  fontFamily: FONT_MONO,
                  letterSpacing: 0,
                }}
              >
                · {secondaryLabel(context)}
              </span>
            )}
          </div>
          <Tooltip
            label={
              probe?.healthy === true
                ? "Reachable"
                : probe?.healthy === false
                  ? probe.last_error
                    ? `Unreachable — ${probe.last_error}`
                    : "Unreachable"
                  : "Not yet probed"
            }
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: dotColor,
                flexShrink: 0,
              }}
            />
          </Tooltip>
          {context.is_current && (
            <span
              style={{
                fontFamily: FONT_MONO,
                fontSize: 9.5,
                color: t.accent,
                background: t.accentSoft,
                padding: "1px 6px",
                borderRadius: 3,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: 0.4,
                flexShrink: 0,
              }}
            >
              current
            </span>
          )}
          {probe?.server_version && (
            <span
              style={{
                marginLeft: "auto",
                fontFamily: FONT_MONO,
                fontSize: 10.5,
                color: t.textMuted,
                flexShrink: 0,
                paddingLeft: 8,
              }}
            >
              {probe.server_version}
              {context.namespace ? ` · ns:${context.namespace}` : ""}
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: t.textMuted,
            fontVariantNumeric: "tabular-nums",
            fontFamily: FONT_MONO,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {summaryLine(probe, context)}
        </div>
      </div>
    </button>
  );
  return probe?.last_error ? (
    <Tooltip label={probe.last_error}>{card}</Tooltip>
  ) : (
    card
  );
}

// Mirrors `prefs::FleetView`. The fleet landing is the only place that
// reads it; pulled into a local alias to keep dispatch readable.
type FleetView = "tiles" | "mini" | "rows";

// Pick the flex-basis (in px) for a card based on its title length.
// This is the minimum horizontal room the card wants before it wraps to
// the next row; flex-grow then fills the trailing slack on each row.
//
// Estimate = chrome (gauges + paddings + status dot + version chip +
// optional "current" badge) + width of the visible title. The title is
// the context name plus, when present, " · cluster-name" rendered in a
// smaller mono font — counted separately because both must remain
// readable without ellipsis.
function cardBasisPx(primary: string, secondary: string | null): number {
  const chrome = 240;
  const primaryPx = primary.length * 8.2; // 14px / 600 / -0.3 letter-spacing
  const secondaryPx = secondary ? (secondary.length + 3) * 7 : 0; // 11.5px mono + " · "
  const want = chrome + primaryPx + secondaryPx;
  return Math.min(880, Math.max(280, Math.round(want)));
}

// Same idea as `cardBasisPx` for the Mini layout: no gauges, no summary
// line, smaller chrome — so cards pack denser.
function miniBasisPx(primary: string, secondary: string | null): number {
  const chrome = 110; // dot + paddings + version chip
  const primaryPx = primary.length * 7.5; // 13px / 600
  const secondaryPx = secondary ? (secondary.length + 3) * 6.6 : 0; // 11px mono + " · "
  const want = chrome + primaryPx + secondaryPx;
  return Math.min(560, Math.max(180, Math.round(want)));
}

// Title for the card. We prefer the context name (k8s convention — what
// `kubectl use-context` switches between, unique within a kubeconfig). If
// the cluster name carries extra information (different from the context
// name), `secondaryLabel` surfaces it next to the title.
function primaryLabel(c: ContextInfo): string {
  return c.name || c.cluster;
}

// Returns the cluster name when it adds information beyond the context
// name. We only dedup on a literal case-insensitive match — the `user@`
// prefix variant (`admin@prod-cluster` vs `prod-cluster`) still surfaces
// the cluster, since the operator wants both the identity and the
// underlying cluster visible on the card.
function secondaryLabel(c: ContextInfo): string | null {
  const cluster = c.cluster?.trim();
  if (!cluster) return null;
  const ctx = c.name.trim();
  if (ctx.toLowerCase() === cluster.toLowerCase()) return null;
  return cluster;
}

function summaryLine(
  probe: ClusterProbe | null,
  context: ContextInfo,
): string {
  if (!probe) {
    return secondaryLabel(context) ? "" : context.cluster;
  }
  const bits: string[] = [];
  if (probe.nodes != null) bits.push(`${probe.nodes} nodes`);
  if (probe.pods != null) bits.push(`${probe.pods} pods`);
  if (bits.length === 0) {
    if (probe.healthy === false) return "unreachable";
    return "probing…";
  }
  return bits.join(" · ");
}

function GaugeWithLabel({
  mode,
  ratio,
  color,
  label,
}: {
  mode: ThemeMode;
  ratio: number | null;
  color: string;
  label: string;
}) {
  const t = tokens(mode);
  const pct = ratio != null ? Math.round(Math.max(0, Math.min(1, ratio)) * 100) : null;
  return (
    <div
      style={{
        position: "relative",
        width: 42,
        height: 42,
        flexShrink: 0,
      }}
    >
      <Gauge
        value={ratio ?? 0}
        size={42}
        thickness={4}
        color={ratio == null ? t.borderSoft : color}
        track={t.borderSoft}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 10.5,
          fontWeight: 600,
          fontFamily: FONT_MONO,
          fontVariantNumeric: "tabular-nums",
          color: t.text,
          letterSpacing: -0.2,
          lineHeight: 1.05,
        }}
      >
        <div style={{ fontSize: 11 }}>
          {pct == null ? "—" : pct}
          {pct != null && (
            <span style={{ fontSize: 7, opacity: 0.7 }}>%</span>
          )}
        </div>
        <div
          style={{
            fontSize: 7.5,
            opacity: 0.55,
            fontWeight: 500,
            marginTop: 1,
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}

// Compact tile: status dot + name (+ secondary cluster name) + version. No
// gauges, no summary line. Used when the operator wants to scan a large
// fleet without per-card load info.
function MiniCard({
  mode,
  context,
  probe,
  onSelect,
  onMenu,
}: {
  mode: ThemeMode;
  context: ContextInfo;
  probe: ClusterProbe | null;
  onSelect: () => void;
  onMenu: (pos: MenuPosition) => void;
}) {
  const t = tokens(mode);
  const dotColor =
    probe?.healthy === true
      ? t.good
      : probe?.healthy === false
        ? t.bad
        : t.unknown;
  const sub = secondaryLabel(context);

  const card = (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
      style={{
        width: "100%",
        height: "100%",
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        background: t.surface,
        padding: "8px 10px",
        textAlign: "left",
        cursor: "pointer",
        fontFamily: "inherit",
        color: "inherit",
        transition: "border-color .15s, background .15s",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = t.accent;
        e.currentTarget.style.background = t.accentSoft;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = t.border;
        e.currentTarget.style.background = t.surface;
      }}
    >
      <Tooltip
        label={
          probe?.healthy === true
            ? "Reachable"
            : probe?.healthy === false
              ? probe.last_error
                ? `Unreachable — ${probe.last_error}`
                : "Unreachable"
              : "Not yet probed"
        }
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: dotColor,
            flexShrink: 0,
          }}
        />
      </Tooltip>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: -0.2,
          color: t.text,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {primaryLabel(context)}
        {sub && (
          <span
            style={{
              marginLeft: 6,
              fontSize: 11,
              fontWeight: 500,
              color: t.textMuted,
              fontFamily: FONT_MONO,
              letterSpacing: 0,
            }}
          >
            · {sub}
          </span>
        )}
      </div>
      {context.is_current && (
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 9,
            color: t.accent,
            background: t.accentSoft,
            padding: "1px 5px",
            borderRadius: 3,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            flexShrink: 0,
          }}
        >
          current
        </span>
      )}
      {probe?.server_version && (
        <span
          style={{
            fontFamily: FONT_MONO,
            fontSize: 10.5,
            color: t.textMuted,
            flexShrink: 0,
          }}
        >
          {probe.server_version}
        </span>
      )}
    </button>
  );
  return probe?.last_error ? (
    <Tooltip label={probe.last_error}>{card}</Tooltip>
  ) : (
    card
  );
}

// Row layout: a single line per cluster, joined into a bordered list. No
// gauges, no card frame — meant for operators with dozens of clusters who
// want to scan top-to-bottom.
function FleetRow({
  mode,
  context,
  probe,
  isLast,
  onSelect,
  onMenu,
}: {
  mode: ThemeMode;
  context: ContextInfo;
  probe: ClusterProbe | null;
  isLast: boolean;
  onSelect: () => void;
  onMenu: (pos: MenuPosition) => void;
}) {
  const t = tokens(mode);
  const dotColor =
    probe?.healthy === true
      ? t.good
      : probe?.healthy === false
        ? t.bad
        : t.unknown;
  const sub = secondaryLabel(context);

  const stats: string[] = [];
  if (probe?.nodes != null) stats.push(`${probe.nodes} nodes`);
  if (probe?.pods != null) stats.push(`${probe.pods} pods`);
  if (context.namespace) stats.push(`ns:${context.namespace}`);

  const row = (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY });
      }}
      style={{
        width: "100%",
        border: "none",
        borderBottom: isLast ? "none" : `1px solid ${t.border}`,
        background: "transparent",
        padding: "8px 14px",
        textAlign: "left",
        cursor: "pointer",
        fontFamily: "inherit",
        color: "inherit",
        transition: "background .12s",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = t.accentSoft;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <Tooltip
        label={
          probe?.healthy === true
            ? "Reachable"
            : probe?.healthy === false
              ? probe.last_error
                ? `Unreachable — ${probe.last_error}`
                : "Unreachable"
              : "Not yet probed"
        }
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: dotColor,
            flexShrink: 0,
          }}
        />
      </Tooltip>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          overflow: "hidden",
        }}
      >
        <span
          style={{
            fontSize: 13.5,
            fontWeight: 600,
            letterSpacing: -0.2,
            color: t.text,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
            flexShrink: 1,
          }}
        >
          {primaryLabel(context)}
        </span>
        {sub && (
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 500,
              color: t.textMuted,
              fontFamily: FONT_MONO,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
              flexShrink: 2,
            }}
          >
            · {sub}
          </span>
        )}
        {context.is_current && (
          <span
            style={{
              fontFamily: FONT_MONO,
              fontSize: 9,
              color: t.accent,
              background: t.accentSoft,
              padding: "1px 5px",
              borderRadius: 3,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              flexShrink: 0,
            }}
          >
            current
          </span>
        )}
      </div>
      <div
        style={{
          fontFamily: FONT_MONO,
          fontSize: 11,
          color: t.textMuted,
          fontVariantNumeric: "tabular-nums",
          flexShrink: 0,
          display: "flex",
          gap: 12,
          alignItems: "baseline",
        }}
      >
        {stats.length > 0 && <span>{stats.join(" · ")}</span>}
        {probe?.server_version && <span>{probe.server_version}</span>}
      </div>
    </button>
  );
  return probe?.last_error ? (
    <Tooltip label={probe.last_error}>{row}</Tooltip>
  ) : (
    row
  );
}

// Three-button segmented control for the page-level fleet-view toggle.
// Persists through `patchSettings({ fleetView })` → `prefs.json`.
function ViewToggle({ mode }: { mode: ThemeMode }) {
  const t = tokens(mode);
  const value = useAppStore((s) => s.settings.fleetView);
  const patch = useAppStore((s) => s.patchSettings);
  const options: { id: FleetView; label: string }[] = [
    { id: "tiles", label: "Tiles" },
    { id: "mini", label: "Mini" },
    { id: "rows", label: "Rows" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Fleet view"
      style={{
        display: "inline-flex",
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        padding: 2,
        background: t.surface,
        flexShrink: 0,
      }}
    >
      {options.map((o) => {
        const selected = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => patch({ fleetView: o.id })}
            style={{
              border: "none",
              background: selected ? t.accentSoft : "transparent",
              color: selected ? t.accent : t.textMuted,
              fontFamily: "inherit",
              fontSize: 11.5,
              fontWeight: 600,
              letterSpacing: 0.2,
              padding: "5px 12px",
              borderRadius: 6,
              cursor: "pointer",
              transition: "background .12s, color .12s",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
