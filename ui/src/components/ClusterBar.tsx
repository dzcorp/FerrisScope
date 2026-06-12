import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Mono } from "./detail";
import type { ContextInfo, ClusterInfo } from "../types";
import { tokens, FF_MONO, type ThemeMode, R_LG, R_MD, FS_MD, FS_XS } from "../theme";
import { useAppStore, useResolvedTheme } from "../store";
import { Stat, StatusPill, Gauge, Icons, Kbd, Tooltip } from "./ui";
import { makeChatTab, makeTerminalTab, makeYamlTab } from "./Dock";
import { MOD_KEY, SHIFT_KEY } from "../lib/keyboard";
import { useMetricsSubscription } from "../lib/useMetricsSubscription";

type ConnectState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "ok"; info: ClusterInfo }
  | { status: "error"; message: string };

type Props = {
  mode: ThemeMode;
  context: ContextInfo;
  state: ConnectState;
  style?: CSSProperties;
};

// Cluster context bar — always shows where the operator is standing (P6).
// Hosts the namespace filter button and the "+" menu (terminal / YAML).
export function ClusterBar({ mode, context, state, style }: Props) {
  const t = useResolvedTheme().tokens;

  const addMenuOpen = useAppStore((s) => s.addMenuOpen);
  const setAddMenuOpen = useAppStore((s) => s.setAddMenuOpen);
  const addDockTab = useAppStore((s) => s.addDockTab);

  // Responsive bar: progressively hide secondary stats as width shrinks so
  // the namespace + add controls (right side) and the cluster name (left
  // side) stay legible. Thresholds picked empirically against long GKE
  // context names; tweak in one place if the layout shifts.
  const barRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number>(() =>
    typeof window === "undefined" ? 1600 : window.innerWidth,
  );
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const showUser = width >= 1100;
  const showVersion = width >= 950;
  const showNodes = width >= 820;
  const showGauges = width >= 720;

  // Close the "+" menu on outside click.
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node))
        setAddMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [addMenuOpen, setAddMenuOpen]);

  // "Add cluster…" flips the dropdown into a context-picker list; appending
  // a context widens this single-cluster view into an ad-hoc multi-cluster
  // view (App switches to VirtualClusterPanel when the scope grows past 1).
  const [addClusterMode, setAddClusterMode] = useState(false);
  useEffect(() => {
    if (!addMenuOpen) setAddClusterMode(false);
  }, [addMenuOpen]);
  const allContexts = useAppStore((s) => s.contexts);
  const addScopeExtra = useAppStore((s) => s.addScopeExtra);
  const addableContexts = allContexts.filter((c) => c.id !== context.id);

  return (
    <div
      ref={barRef}
      style={{
        background: t.headerAlt,
        borderBottom: `1px solid ${t.border}`,
        padding: "12px 22px",
        display: "flex",
        alignItems: "center",
        gap: 22,
        flexShrink: 0,
        ...style,
      }}
    >
      <Stat
        t={t}
        label="Status"
        value={
          state.status === "ok" ? (
            <StatusPill status="Running" t={t} mode={mode} dense />
          ) : state.status === "error" ? (
            <StatusPill status="Error" t={t} mode={mode} dense />
          ) : (
            <StatusPill status="Pending" t={t} mode={mode} dense />
          )
        }
      />
      {showNodes && (
        <Stat
          t={t}
          label="Nodes"
          // node_count = 0 is the placeholder while the background
          // cluster.info probe is still in flight (connect_context returns
          // before it completes, on purpose). Render "—" until it lands.
          value={
            state.status === "ok" && state.info.node_count > 0
              ? state.info.node_count
              : "—"
          }
        />
      )}
      {showVersion && (
        <Stat
          t={t}
          label="Version"
          value={
            state.status === "ok" && state.info.server_version
              ? state.info.server_version
              : "—"
          }
          mono
        />
      )}
      <Stat
        t={t}
        label="Cluster"
        value={
          <Mono>
            {context.cluster}
          </Mono>
        }
      />
      {showUser && context.user && (
        <Stat
          t={t}
          label="User"
          value={
            <Mono>
              {context.user}
            </Mono>
          }
        />
      )}

      <div style={{ flex: 1 }} />

      {showGauges && <ClusterGauges mode={mode} clusterId={context.id} />}

      {/* "+" menu — opens terminal or YAML in dock */}
      <div ref={menuWrapRef} style={{ position: "relative" }}>
        <AddMenuTrigger
          open={addMenuOpen}
          onClick={() => setAddMenuOpen(!addMenuOpen)}
          tooltip="New terminal or YAML scratchpad"
          ariaLabel="Add tab or cluster"
        />
        {addMenuOpen && (
          <div
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 6px)",
              background: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: R_LG,
              padding: 4,
              minWidth: 280,
              zIndex: 22,
              boxShadow:
                mode === "dark"
                  ? "0 8px 24px rgba(0,0,0,0.4)"
                  : "0 8px 24px rgba(15,20,30,0.12)",
              // The "Add cluster…" mode lists every kubeconfig context —
              // long lists must scroll, not run off the viewport.
              maxHeight: "min(420px, 60vh)",
              overflowY: "auto",
            }}
          >
            {addClusterMode ? (
              <>
                <div
                  style={{
                    padding: "6px 10px 4px",
                    fontSize: FS_XS,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    color: t.textMuted,
                    fontFamily: FF_MONO,
                  }}
                >
                  Add cluster to this view
                </div>
                {addableContexts.length === 0 && (
                  <div
                    style={{
                      padding: "8px 10px",
                      fontSize: FS_MD,
                      color: t.textMuted,
                    }}
                  >
                    No other contexts in your kubeconfig.
                  </div>
                )}
                {addableContexts.map((c) => (
                  <AddMenuItem
                    key={c.id}
                    t={t}
                    icon={Icons.cluster}
                    title={c.name}
                    subtitle={c.cluster}
                    onClick={() => {
                      addScopeExtra(c.id);
                      setAddMenuOpen(false);
                    }}
                  />
                ))}
              </>
            ) : (
              <>
            <AddMenuItem
              t={t}
              icon={Icons.shell}
              title="Terminal"
              subtitle="Run kubectl in this cluster"
              kbd={`${MOD_KEY} \``}
              onClick={() => {
                addDockTab(
                  makeTerminalTab(
                    {
                      mode: "shell",
                      clusterId: context.id,
                      namespace: null,
                    },
                    context.name,
                  ),
                );
              }}
            />
            <AddMenuItem
              t={t}
              icon={Icons.yaml}
              title="YAML scratchpad"
              subtitle="Edit and apply a manifest"
              kbd={`${SHIFT_KEY}${MOD_KEY}Y`}
              onClick={() => addDockTab(makeYamlTab(context.id))}
            />
            <AddMenuItem
              t={t}
              icon={Icons.chat}
              title="AI chat"
              subtitle="Talk to the cluster-aware assistant"
              onClick={() => {
                // Idempotent: if a chat tab is already open for this cluster,
                // focus it instead of stacking another tab. Operators expect
                // "open chat" to land them in the existing chat, not on a
                // fresh blank tab; new sessions live behind the popover's
                // "New chat" button.
                const s = useAppStore.getState();
                const existing = s.dockTabs.find(
                  (tt) =>
                    tt.kind === "chat" &&
                    (tt.state as { clusterId?: string } | undefined)
                      ?.clusterId === context.id,
                );
                if (existing) {
                  s.setDockActiveId(existing.id);
                  s.setDockMin("right", false);
                } else {
                  addDockTab(makeChatTab(context.id, context.name));
                }
              }}
            />
            <AddMenuItem
              t={t}
              icon={Icons.plus}
              title="Add cluster…"
              subtitle="Merge another cluster into this view"
              onClick={() => setAddClusterMode(true)}
            />
              </>
            )}
          </div>
        )}
      </div>

      <NamespaceButton />
    </div>
  );
}

// ── Shared bar controls ─────────────────────────────────────────────────────
// The single-cluster ClusterBar and the multi-cluster VirtualClusterBar must
// present identical control sizing (36px height, same chrome) — they swap in
// for each other when the scope grows/shrinks, and a size jump there reads
// as a glitch. Both bars consume these instead of hand-rolling buttons.

/// 36×36 "+" trigger with the open-dock-tabs count badge. The dropdown
/// itself stays with the caller — only the trigger chrome is shared.
export function AddMenuTrigger({
  open,
  onClick,
  tooltip,
  ariaLabel,
}: {
  open: boolean;
  onClick: () => void;
  tooltip: string;
  ariaLabel: string;
}) {
  const t = useResolvedTheme().tokens;
  const dockTabs = useAppStore((s) => s.dockTabs);
  return (
    <Tooltip label={tooltip}>
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={onClick}
        onMouseEnter={(e) => (e.currentTarget.style.background = t.btnHover)}
        onMouseLeave={(e) =>
          (e.currentTarget.style.background = open ? t.btnHover : t.surface)
        }
        style={{
          border: `1px solid ${t.border}`,
          background: open ? t.btnHover : t.surface,
          color: t.text,
          width: 36,
          height: 36,
          borderRadius: R_MD,
          cursor: "pointer",
          outline: "none",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          flexShrink: 0,
          transition: "background .12s, border-color .12s",
        }}
      >
        {Icons.plus}
        {dockTabs.length > 0 && (
          <span
            style={{
              position: "absolute",
              top: -3,
              right: -3,
              minWidth: 14,
              height: 14,
              padding: "0 3px",
              borderRadius: R_MD,
              background: t.accent,
              color: "#fff",
              fontSize: FS_XS,
              fontWeight: 700,
              fontFamily: FF_MONO,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: `2px solid ${t.headerAlt}`,
            }}
          >
            {dockTabs.length}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

/// The namespace-filter button: 36px tall, two-line label (caption + active
/// filter summary), ⌘I hint, accent chrome while a filter is active. Reads
/// the namespace selection straight from the store so both bars stay in sync.
export function NamespaceButton() {
  const t = useResolvedTheme().tokens;
  const selectedNamespaces = useAppStore((s) => s.selectedNamespaces);
  const openNsModal = useAppStore((s) => s.openNsModal);

  const nsCount = selectedNamespaces.size;
  const nsAll = nsCount === 0;
  const nsList = Array.from(selectedNamespaces);
  const nsSummary = nsAll
    ? "All namespaces"
    : nsCount === 1
      ? nsList[0]
      : `${nsCount} namespaces`;

  return (
    <Tooltip
      label={
        nsAll ? "Filter by namespace" : `Filter: ${nsList.join(", ")}`
      }
    >
      <button
        type="button"
        onClick={openNsModal}
        onMouseEnter={(e) => {
          if (nsAll) e.currentTarget.style.background = t.btnHover;
        }}
        onMouseLeave={(e) => {
          if (nsAll) e.currentTarget.style.background = t.surface;
        }}
        style={{
          border: `1px solid ${nsAll ? t.border : t.accent}`,
          background: nsAll ? t.surface : t.accentSoft,
          color: t.text,
          padding: "5px 10px 5px 9px",
          borderRadius: R_MD,
          fontSize: FS_MD,
          fontFamily: "inherit",
          cursor: "pointer",
          outline: "none",
          height: 36,
          maxWidth: 280,
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
          transition: "background .12s, border-color .12s",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            color: nsAll ? t.textDim : t.accent,
            flexShrink: 0,
          }}
        >
          {Icons.layers}
        </span>
        <span
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            lineHeight: 1.15,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontSize: FS_XS,
              color: t.textMuted,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              fontFamily: FF_MONO,
            }}
          >
            Namespace
          </span>
          <span
            style={{
              fontSize: FS_MD,
              fontWeight: 600,
              fontFamily: nsAll || nsCount > 1 ? "inherit" : FF_MONO,
              color: nsAll ? t.text : t.accent,
              maxWidth: "100%",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {nsSummary}
          </span>
        </span>
        <Kbd t={t} style={{ marginLeft: 4, flexShrink: 0 }}>
          {MOD_KEY}I
        </Kbd>
      </button>
    </Tooltip>
  );
}

function AddMenuItem({
  t,
  icon,
  title,
  subtitle,
  kbd,
  onClick,
}: {
  t: ReturnType<typeof tokens>;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  kbd?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={(e) => (e.currentTarget.style.background = t.hover)}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "8px 10px",
        borderRadius: R_MD,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        textAlign: "left",
        color: t.text,
        fontFamily: "inherit",
      }}
    >
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: R_MD,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: t.chip,
          color: t.textDim,
        }}
      >
        {icon}
      </span>
      <span
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minWidth: 0,
        }}
      >
        <span style={{ fontSize: FS_MD, fontWeight: 600, color: t.text }}>
          {title}
        </span>
        <span style={{ fontSize: FS_XS, color: t.textMuted, marginTop: 1 }}>
          {subtitle}
        </span>
      </span>
      {kbd && (
        <span
          style={{
            fontSize: FS_XS,
            color: t.textMuted,
            fontFamily: FF_MONO,
            padding: "2px 5px",
            border: `1px solid ${t.borderSoft}`,
            borderRadius: R_MD,
            background: t.surfaceAlt,
          }}
        >
          {kbd}
        </span>
      )}
    </button>
  );
}

// ── Cluster CPU + memory gauges ────────────────────────────────────────────
// Hidden until metrics-server has reported at least once. Color thresholds
// match HV2: <65% green, 65–80% amber, >80% red. Per P5 the colour means the
// same thing everywhere — so we route through the same status palette the
// pod table uses, not a custom gradient.
function ClusterGauges({ clusterId }: { mode: ThemeMode; clusterId: string }) {
  const t = useResolvedTheme().tokens;
  // Subscribe lazily — only while the gauges are actually mounted. Gauges
  // are part of the always-on cluster bar today, but isolating the
  // subscription here means future variants of the bar that hide the
  // gauges (e.g. a compact mode) don't pay for metrics polling either.
  useMetricsSubscription(clusterId);
  const metrics = useAppStore((s) => s.metricsByCluster[clusterId] ?? null);
  if (!metrics || !metrics.available || !metrics.cluster) return null;
  const c = metrics.cluster;
  if (c.cpu_capacity_milli === 0 || c.mem_capacity_mib === 0) return null;

  const cpuRatio = c.cpu_used_milli / c.cpu_capacity_milli;
  const memRatio = c.mem_used_mib / c.mem_capacity_mib;
  const colorFor = (r: number) => (r > 0.8 ? t.bad : r > 0.65 ? t.warn : t.good);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <GaugeStat
        label="CPU"
        ratio={cpuRatio}
        color={colorFor(cpuRatio)}
        track={t.borderSoft}
        textMuted={t.textMuted}
        text={t.text}
        title={`${c.cpu_used_milli}m / ${c.cpu_capacity_milli}m`}
      />
      <GaugeStat
        label="MEM"
        ratio={memRatio}
        color={colorFor(memRatio)}
        track={t.borderSoft}
        textMuted={t.textMuted}
        text={t.text}
        title={`${c.mem_used_mib} Mi / ${c.mem_capacity_mib} Mi`}
      />
    </div>
  );
}

function GaugeStat({
  label,
  ratio,
  color,
  track,
  textMuted,
  text,
  title,
}: {
  label: string;
  ratio: number;
  color: string;
  track: string;
  textMuted: string;
  text: string;
  title?: string;
}) {
  const inner = (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Gauge value={ratio} size={36} thickness={3.5} color={color} track={track} />
      <div>
        <div
          style={{
            fontSize: FS_XS,
            color: textMuted,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            fontFamily: FF_MONO,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: FS_MD,
            fontVariantNumeric: "tabular-nums",
            fontWeight: 600,
            color: text,
            fontFamily: FF_MONO,
          }}
        >
          {Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%
        </div>
      </div>
    </div>
  );
  return title ? <Tooltip label={title}>{inner}</Tooltip> : inner;
}
