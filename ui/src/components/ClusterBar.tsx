import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ContextInfo, ClusterInfo } from "../types";
import { tokens, FONT_MONO, type ThemeMode } from "../theme";
import { useAppStore } from "../store";
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
  const t = tokens(mode);

  const selectedNamespaces = useAppStore((s) => s.selectedNamespaces);
  const openNsModal = useAppStore((s) => s.openNsModal);
  const addMenuOpen = useAppStore((s) => s.addMenuOpen);
  const setAddMenuOpen = useAppStore((s) => s.setAddMenuOpen);
  const dockTabs = useAppStore((s) => s.dockTabs);
  const addDockTab = useAppStore((s) => s.addDockTab);

  const nsCount = selectedNamespaces.size;
  const nsAll = nsCount === 0;
  const nsList = Array.from(selectedNamespaces);
  const nsSummary = nsAll
    ? "All namespaces"
    : nsCount === 1
      ? nsList[0]
      : `${nsCount} namespaces`;

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
          <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
            {context.cluster}
          </span>
        }
      />
      {showUser && context.user && (
        <Stat
          t={t}
          label="User"
          value={
            <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
              {context.user}
            </span>
          }
        />
      )}

      <div style={{ flex: 1 }} />

      {showGauges && <ClusterGauges mode={mode} clusterId={context.id} />}

      {/* "+" menu — opens terminal or YAML in dock */}
      <div ref={menuWrapRef} style={{ position: "relative" }}>
        <Tooltip label="New terminal or YAML scratchpad">
        <button
          type="button"
          onClick={() => setAddMenuOpen(!addMenuOpen)}
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = t.btnHover)
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = addMenuOpen
              ? t.btnHover
              : t.surface)
          }
          style={{
            border: `1px solid ${t.border}`,
            background: addMenuOpen ? t.btnHover : t.surface,
            color: t.text,
            width: 36,
            height: 36,
            borderRadius: 7,
            cursor: "pointer",
            outline: "none",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
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
                borderRadius: 7,
                background: t.accent,
                color: "#fff",
                fontSize: 9,
                fontWeight: 700,
                fontFamily: FONT_MONO,
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
        {addMenuOpen && (
          <div
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 6px)",
              background: t.surface,
              border: `1px solid ${t.border}`,
              borderRadius: 8,
              padding: 4,
              minWidth: 240,
              zIndex: 22,
              boxShadow:
                mode === "dark"
                  ? "0 8px 24px rgba(0,0,0,0.4)"
                  : "0 8px 24px rgba(15,20,30,0.12)",
            }}
          >
            <AddMenuItem
              t={t}
              icon={Icons.shell}
              title="New terminal"
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
              title="New YAML scratchpad"
              subtitle="Write or paste a manifest, then apply"
              kbd={`${SHIFT_KEY}${MOD_KEY}Y`}
              onClick={() => addDockTab(makeYamlTab(context.id))}
            />
            <AddMenuItem
              t={t}
              icon={Icons.chat}
              title="AI chat"
              subtitle="Cluster-aware assistant — resumes the latest session"
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
          </div>
        )}
      </div>

      <Tooltip
        label={
          nsAll
            ? "Filter by namespace"
            : `Filter: ${Array.from(selectedNamespaces).join(", ")}`
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
          borderRadius: 7,
          fontSize: 12,
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
              fontSize: 9.5,
              color: t.textMuted,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              fontFamily: FONT_MONO,
            }}
          >
            Namespace
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              fontFamily: nsAll || nsCount > 1 ? "inherit" : FONT_MONO,
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
    </div>
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
        borderRadius: 5,
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
          borderRadius: 5,
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
        <span style={{ fontSize: 12.5, fontWeight: 600, color: t.text }}>
          {title}
        </span>
        <span style={{ fontSize: 10.5, color: t.textMuted, marginTop: 1 }}>
          {subtitle}
        </span>
      </span>
      {kbd && (
        <span
          style={{
            fontSize: 10,
            color: t.textMuted,
            fontFamily: FONT_MONO,
            padding: "2px 5px",
            border: `1px solid ${t.borderSoft}`,
            borderRadius: 4,
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
function ClusterGauges({ mode, clusterId }: { mode: ThemeMode; clusterId: string }) {
  const t = tokens(mode);
  // Subscribe lazily — only while the gauges are actually mounted. Gauges
  // are part of the always-on cluster bar today, but isolating the
  // subscription here means future variants of the bar that hide the
  // gauges (e.g. a compact mode) don't pay for metrics polling either.
  useMetricsSubscription(clusterId);
  const metrics = useAppStore((s) => s.metrics);
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
            fontSize: 10,
            color: textMuted,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            fontFamily: FONT_MONO,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 12,
            fontVariantNumeric: "tabular-nums",
            fontWeight: 600,
            color: text,
            fontFamily: FONT_MONO,
          }}
        >
          {Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%
        </div>
      </div>
    </div>
  );
  return title ? <Tooltip label={title}>{inner}</Tooltip> : inner;
}
