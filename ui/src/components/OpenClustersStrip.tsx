import { useState } from "react";
import { useAppStore, useClusterLabels } from "../store";
import { clusterAccent, FS_SM, FS_XS, R_SM, type Tokens } from "../theme";
import { clusterColorIndexMap } from "../lib/multiCluster";
import { Icons, Tooltip } from "./ui";
import {
  closeClusterTab,
  clusterTabFullLabel,
  clusterTabLabel,
  clusterTabPrimaryId,
} from "../lib/clusterTabs";

type Props = {
  t: Tokens;
  // Whether the rail is expanded (labels shown) or collapsed (dots only).
  open: boolean;
};

/// The list of open cluster tabs, pinned above the kind list in the rail. Only
/// shown when more than one cluster tab is open — a single tab needs no
/// switcher. Clicking a row switches to that tab (preserving every tab's state
/// via the store's stash/restore); the × closes it and disconnects the cluster
/// if no other tab still uses it. The active tab is highlighted.
export function OpenClustersStrip({ t, open }: Props) {
  const openTabs = useAppStore((s) => s.openTabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const switchTab = useAppStore((s) => s.switchTab);
  const contexts = useAppStore((s) => s.contexts);
  const virtualContexts = useAppStore((s) => s.virtualContexts);
  const labels = useClusterLabels();
  const [hoverId, setHoverId] = useState<string | null>(null);

  if (openTabs.length < 2) return null;

  const colorIdx = clusterColorIndexMap(
    openTabs.map((tab) => clusterTabPrimaryId(tab, contexts, virtualContexts)),
  );

  return (
    <div
      role="list"
      aria-label="Open clusters"
      data-testid="open-clusters-strip"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: open ? "2px 8px 8px" : "2px 6px 8px",
        marginBottom: 6,
        borderBottom: `1px solid ${t.border}`,
      }}
    >
      {open && (
        <div
          style={{
            fontSize: FS_XS,
            color: t.textMuted,
            fontWeight: 600,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            padding: "4px 6px 2px",
          }}
        >
          Open clusters
        </div>
      )}
      {openTabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const label = clusterTabLabel(tab, contexts, virtualContexts, labels);
        // The rail is narrow, so the row shows only the short name; the full
        // context name stays reachable via the tooltip / aria-label.
        const fullLabel = clusterTabFullLabel(tab, contexts, virtualContexts);
        const primaryId = clusterTabPrimaryId(tab, contexts, virtualContexts);
        const dot = clusterAccent(colorIdx[primaryId] ?? 0);
        const row = (
          <div
            key={tab.id}
            role="listitem"
            aria-current={isActive ? "true" : undefined}
            onMouseEnter={() => setHoverId(tab.id)}
            onMouseLeave={() => setHoverId((h) => (h === tab.id ? null : h))}
            onClick={() => switchTab(tab.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
              padding: open ? "4px 6px" : "5px 0",
              justifyContent: open ? "flex-start" : "center",
              borderRadius: R_SM,
              background: isActive ? t.accentSoft : "transparent",
              color: isActive ? t.text : t.textDim,
            }}
          >
            <span
              aria-hidden
              style={{
                flexShrink: 0,
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: dot,
                boxShadow: isActive ? `0 0 0 2px ${t.chip}` : "none",
              }}
            />
            {open && (
              <>
                <span
                  title={fullLabel}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: FS_SM,
                    fontWeight: isActive ? 600 : 500,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {label}
                </span>
                <button
                  type="button"
                  aria-label={`Close ${fullLabel}`}
                  title="Close cluster tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeClusterTab(tab.id);
                  }}
                  style={{
                    flexShrink: 0,
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    color: t.textMuted,
                    display: "inline-flex",
                    padding: 2,
                    borderRadius: R_SM,
                    opacity: hoverId === tab.id || isActive ? 1 : 0,
                    transition: "opacity .12s",
                  }}
                >
                  {Icons.close}
                </button>
              </>
            )}
          </div>
        );
        // Collapsed rail: dots only, name in a tooltip.
        return open ? row : <Tooltip key={tab.id} label={fullLabel}>{row}</Tooltip>;
      })}
    </div>
  );
}
