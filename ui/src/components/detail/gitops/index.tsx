import { useMemo, useRef, useState } from "react";
import { useAppStore, useResolvedTheme } from "../../../store";
import {
  DETAIL_LAYOUT,
  FS_SM,
  FS_XS,
  R_LG,
  R_MD,
  statusBucket,
  type StatusBucket,
  type ThemeMode,
  type Tokens,
} from "../../../theme";
import type {
  GitOpsAction,
  GitOpsCard,
  GitOpsCondition,
  GitOpsField,
  GitOpsReference,
  GitOpsResource,
} from "../../../types";
import { resolveResourceKind } from "../../../lib/resourceKinds";
import {
  ContextMenu,
  type MenuItem,
  type MenuPosition,
} from "../../ContextMenu";
import {
  Btn,
  ErrorBlock,
  Eyebrow,
  IconBtn,
  Icons,
  LoadingLine,
  Section,
  StatusPill,
  TextInput,
  resolveKindIcon,
} from "../../ui";
import {
  ChipStrip,
  CollapsibleCard,
  ConditionChip,
  Copyable,
  DetailRow,
  ExpandableList,
  LinkValue,
  Mono,
  Mute,
  SubGrid,
  ageFromIso,
  type DetailNavigate,
} from "..";
import { MetaSection } from "../workload/shared";
import type { GitOpsController } from "./useGitOps";
import { ArgoHistory, ArgoOverview, AutoSyncControl, RollbackDialog, SyncResults } from "./argo";
import { FluxHistory } from "./flux";
import { SyncDialog, resourceKey } from "./SyncDialog";
import { useLiveStatus } from "./useLiveStatus";
import { useTabSlice } from "../../../lib/tabScope";

export { useGitOps, type GitOpsController } from "./useGitOps";

type SummaryProps = {
  ctl: GitOpsController;
  clusterId: string;
  onNavigate?: DetailNavigate;
};

export function GitOpsSummary({ ctl, clusterId, onNavigate }: SummaryProps) {
  const { tokens: t, mode } = useResolvedTheme();
  const state = ctl.state;
  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        padding: DETAIL_LAYOUT.padding,
        background: t.bg,
        color: t.text,
        overflowWrap: "anywhere",
      }}
    >
      {state.kind === "loading" ? (
        <LoadingLine t={t} label="Loading GitOps resource..." />
      ) : state.kind === "error" ? (
        <>
          <ErrorBlock t={t} message={state.message} />
          <Btn t={t} onClick={ctl.reload}>
            Retry
          </Btn>
        </>
      ) : (
        <>
          <StatusCards t={t} mode={mode} cards={state.detail.cards} />
          {state.detail.argo && state.detail.actions.length > 0 && (
            <AutoSyncControl t={t} argo={state.detail.argo} ctl={ctl} />
          )}
          {state.detail.notice && (
            <p style={{ margin: `0 0 ${DETAIL_LAYOUT.sectionGap}px` }}>
              <Mute t={t}>{state.detail.notice}</Mute>
            </p>
          )}
          {state.detail.argo && <ArgoOverview t={t} argo={state.detail.argo} />}
          {state.detail.resources && (
            <ResourceList
              t={t}
              mode={mode}
              resources={state.detail.resources}
              clusterId={clusterId}
              onNavigate={onNavigate}
              onSync={
                state.detail.actions.some((a) => a.id === "sync") && !ctl.blocked()
                  ? (key) => ctl.openDialog({ kind: "sync", preselect: [key] })
                  : undefined
              }
            />
          )}
          {state.detail.argo && <SyncResults t={t} mode={mode} argo={state.detail.argo} />}
          <Conditions
            t={t}
            conditions={state.detail.conditions}
            generation={state.detail.meta.generation}
          />
          {state.detail.argo && <ArgoHistory t={t} argo={state.detail.argo} ctl={ctl} />}
          {state.detail.flux && <FluxHistory t={t} mode={mode} flux={state.detail.flux} />}
          <MetaSection t={t} meta={state.detail.meta} onNavigate={onNavigate} />
          {state.detail.sections.map((section) => {
            const fields = section.fields.filter((f) => f.value !== null);
            if (fields.length === 0 && section.items.length === 0) return null;
            return (
              <section
                key={section.title}
                aria-label={section.title}
                style={{ marginBottom: DETAIL_LAYOUT.sectionGap }}
              >
                <Section
                  t={t}
                  title={section.title}
                  right={
                    section.items.length > 0 ? (
                      <Mute t={t}>{section.items.length}</Mute>
                    ) : undefined
                  }
                />
                {fields.map((field, i) => (
                  <GitOpsValue
                    key={i}
                    t={t}
                    field={field}
                    clusterId={clusterId}
                    onNavigate={onNavigate}
                  />
                ))}
                {section.items.length > 0 && (
                  <ExpandableList
                    t={t}
                    items={section.items}
                    render={(items) =>
                      items.map((item, i) => (
                        <CollapsibleCard
                          key={i}
                          t={t}
                          defaultOpen={section.items.length <= 3}
                          header={() => (
                            <Mono style={{ overflowWrap: "anywhere" }}>
                              {item.title}
                            </Mono>
                          )}
                        >
                          {item.fields
                            .filter((f) => f.value !== null)
                            .map((field, j) => (
                              <GitOpsValue
                                key={j}
                                t={t}
                                field={field}
                                clusterId={clusterId}
                                onNavigate={onNavigate}
                              />
                            ))}
                        </CollapsibleCard>
                      ))
                    }
                  />
                )}
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

export function StatusCards({
  t,
  mode,
  cards,
}: {
  t: Tokens;
  mode: ThemeMode;
  cards: GitOpsCard[];
}) {
  if (cards.length === 0) return null;
  return (
    <div
      role="list"
      aria-label="Status"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(${DETAIL_LAYOUT.cardMinWidth}px, 1fr))`,
        gap: DETAIL_LAYOUT.itemGap,
        marginBottom: DETAIL_LAYOUT.sectionGap,
      }}
    >
      {cards.map((card) => (
        <div
          key={card.label}
          role="listitem"
          aria-label={card.label}
          style={{
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: DETAIL_LAYOUT.cardPadding,
            border: `1px solid ${t.border}`,
            borderRadius: R_LG,
            background: t.surface,
          }}
        >
          <Eyebrow t={t}>{card.label}</Eyebrow>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minWidth: 0,
            }}
          >
            {card.status && (
              <StatusPill t={t} mode={mode} status={card.status} />
            )}
            {card.value && (
              <Copyable text={card.value}>
                <Mono
                  style={{
                    display: "block",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {card.value}
                </Mono>
              </Copyable>
            )}
            {!card.status && !card.value && <Mute t={t}>—</Mute>}
          </div>
          {card.caption && (
            <div
              title={card.caption}
              style={{
                fontSize: FS_SM,
                color: t.textMuted,
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {card.caption}
            </div>
          )}
          {card.at && (
            <span title={card.at} style={{ fontSize: FS_XS, color: t.textMuted }}>
              {ageFromIso(card.at)} ago
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

const BUCKET_RANK: Record<StatusBucket, number> = {
  bad: 0,
  warn: 1,
  unknown: 2,
  info: 2,
  good: 3,
};

const rank = (r: GitOpsResource) =>
  Math.min(
    r.sync ? BUCKET_RANK[statusBucket(r.sync)] : 3,
    r.health ? BUCKET_RANK[statusBucket(r.health)] : 3,
  );

type ResourceFilter = "all" | "drift" | "unhealthy" | "prune";

const FILTERS: { id: ResourceFilter; label: string; test: (r: GitOpsResource) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "drift", label: "Out of sync", test: (r) => !!r.sync && r.sync !== "Synced" },
  { id: "unhealthy", label: "Unhealthy", test: (r) => !!r.health && statusBucket(r.health) !== "good" },
  { id: "prune", label: "Prune", test: (r) => r.prune },
];

export function ResourceList({
  t,
  mode,
  resources,
  clusterId,
  onNavigate,
  onSync,
  title = "Managed resources",
}: {
  t: Tokens;
  mode: ThemeMode;
  resources: GitOpsResource[];
  clusterId: string;
  onNavigate?: DetailNavigate;
  onSync?: (key: string) => void;
  title?: string;
}) {
  const [filter, setFilter] = useState<ResourceFilter>("all");
  const [query, setQuery] = useState("");
  const live = useLiveStatus(clusterId, resources);
  // Argo omits per-resource health by default and Flux reports none; fill
  // from live cluster state so both read like Argo's resource tree.
  const merged = useMemo(
    () =>
      resources.map((r) => {
        const l = live.get(resourceKey(r));
        return l ? { ...r, health: r.health ?? l.status, ready: l.ready } : r;
      }),
    [resources, live],
  );
  // Problems first; stable within a rank so the controller's order holds.
  const sorted = useMemo(
    () =>
      merged
        .map((r, i) => ({ r, i, k: rank(r) }))
        .sort((a, b) => a.k - b.k || a.i - b.i)
        .map((x) => x.r),
    [merged],
  );
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.id, merged.filter(f.test).length])) as Record<ResourceFilter, number>,
    [merged],
  );
  const shown = useMemo(() => {
    const test = FILTERS.find((f) => f.id === filter)?.test ?? (() => true);
    const q = query.trim().toLowerCase();
    return sorted.filter(
      (r) => test(r) && (!q || `${r.kind} ${r.namespace ?? ""} ${r.name}`.toLowerCase().includes(q)),
    );
  }, [sorted, filter, query]);
  const summary = [
    String(resources.length),
    counts.drift > 0 ? `${counts.drift} out of sync` : null,
    counts.unhealthy > 0 ? `${counts.unhealthy} not healthy` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const toolbar = resources.length > 5 || counts.drift + counts.unhealthy + counts.prune > 0;
  return (
    <section
      aria-label={title}
      style={{ marginBottom: DETAIL_LAYOUT.sectionGap }}
    >
      <Section
        t={t}
        title={title}
        right={<Mute t={t}>{summary}</Mute>}
      />
      {resources.length === 0 ? (
        <Mute t={t}>None reported.</Mute>
      ) : (
        <>
          {toolbar && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              {FILTERS.filter((f) => f.id === "all" || counts[f.id] > 0).map((f) => (
                <Btn
                  key={f.id}
                  t={t}
                  size="sm"
                  variant="ghost"
                  pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label} {counts[f.id]}
                </Btn>
              ))}
              <div style={{ flex: "1 1 160px", minWidth: 0 }}>
                <TextInput t={t} value={query} onChange={setQuery} placeholder="Filter by kind, namespace, name…" />
              </div>
            </div>
          )}
          <div
            role="table"
            aria-label={title}
            style={{
              border: `1px solid ${t.border}`,
              borderRadius: R_MD,
              overflow: "hidden",
            }}
          >
            {shown.length === 0 ? (
              <div style={{ padding: "8px 12px" }}>
                <Mute t={t}>No resources match.</Mute>
              </div>
            ) : (
              <ExpandableList
                key={`${filter}|${query}`}
                t={t}
                items={shown}
                render={(items) =>
                  items.map((r, i) => (
                    <ResourceRow
                      key={resourceKey(r)}
                      t={t}
                      mode={mode}
                      resource={r}
                      first={i === 0}
                      clusterId={clusterId}
                      onNavigate={onNavigate}
                      onSync={onSync}
                    />
                  ))
                }
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function useNavigable(
  reference: GitOpsReference | null,
  clusterId: string,
  onNavigate?: DetailNavigate,
): boolean {
  const kinds = useAppStore((s) => s.kinds);
  const kindClusters = useTabSlice((v) => v.kindClusters);
  if (!reference?.local || !onNavigate) return false;
  const target = resolveResourceKind(
    kinds,
    kindClusters,
    reference.kind,
    clusterId,
    reference.group,
  );
  return !!target && (!target.namespaced || reference.namespace !== null);
}

function ResourceRow({
  t,
  mode,
  resource: r,
  first,
  clusterId,
  onNavigate,
  onSync,
}: {
  t: Tokens;
  mode: ThemeMode;
  resource: GitOpsResource & { ready?: string | null };
  first: boolean;
  clusterId: string;
  onNavigate?: DetailNavigate;
  onSync?: (key: string) => void;
}) {
  const navigable = useNavigable(r, clusterId, onNavigate);
  const path = r.namespace ? `${r.kind}/${r.namespace}/${r.name}` : `${r.kind}/${r.name}`;
  return (
    <div
      role="row"
      style={{
        display: "grid",
        gridTemplateColumns: "16px minmax(0, 1fr) auto",
        alignItems: "start",
        gap: DETAIL_LAYOUT.itemGap,
        padding: "8px 12px",
        borderTop: first ? "none" : `1px solid ${t.borderSoft}`,
      }}
    >
      <span
        aria-hidden
        style={{ color: t.textMuted, display: "inline-flex", paddingTop: 1 }}
      >
        {resolveKindIcon(r.kind, r.group, "Apps")}
      </span>
      <div role="cell" style={{ minWidth: 0 }}>
        <LinkValue
          t={t}
          copyText={path}
          enabled={navigable}
          truncate
          onClick={() =>
            onNavigate?.(r.kind, r.namespace, r.name, clusterId, r.group)
          }
        >
          <Mono>{r.name}</Mono>
        </LinkValue>
        <div
          title={r.version ? `${r.group ? `${r.group}/` : ""}${r.version}` : undefined}
          style={{ fontSize: FS_XS, color: t.textMuted, marginTop: 2 }}
        >
          {r.kind}
          {r.namespace ? ` · ${r.namespace}` : ""}
          {r.sync_wave != null && r.sync_wave !== 0 ? ` · wave ${r.sync_wave}` : ""}
          {r.hook ? " · hook" : ""}
        </div>
        {r.message && (
          <div
            style={{
              fontSize: FS_XS,
              color: t.textMuted,
              marginTop: 2,
              overflowWrap: "anywhere",
            }}
          >
            {r.message}
          </div>
        )}
      </div>
      <div
        role="cell"
        style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end", alignItems: "center" }}
      >
        {r.prune && (
          <ChipStrip t={t} mono={false} items={[{ label: "Prune", tone: "warn" }]} />
        )}
        {r.ready && (
          <Mono size={FS_XS} style={{ color: t.textMuted }}>
            {r.ready}
          </Mono>
        )}
        {r.sync && <StatusPill t={t} mode={mode} status={r.sync} dense />}
        {r.health && <StatusPill t={t} mode={mode} status={r.health} dense />}
        {onSync && (
          <IconBtn t={t} title={`Sync ${r.kind} ${r.name}…`} onClick={() => onSync(resourceKey(r))}>
            {Icons.sync}
          </IconBtn>
        )}
      </div>
    </div>
  );
}

function Conditions({
  t,
  conditions,
  generation,
}: {
  t: Tokens;
  conditions: GitOpsCondition[];
  generation: number | null;
}) {
  if (conditions.length === 0) return null;
  return (
    <section
      aria-label="Conditions"
      style={{ marginBottom: DETAIL_LAYOUT.sectionGap }}
    >
      <Section t={t} title="Conditions" />
      {conditions.map((c) => (
        <DetailRow key={c.type} t={t} label={c.type}>
          <ConditionChip
            t={t}
            cond={{ type: c.status, status: c.status }}
            invert={c.negative}
          />
          {c.reason && (
            <Mono size={FS_SM} style={{ color: t.textMuted }}>
              {c.reason}
            </Mono>
          )}
          {c.message && (
            <Copyable text={c.message}>
              <span style={{ fontSize: FS_SM, color: t.textDim }}>
                {c.message}
              </span>
            </Copyable>
          )}
          {c.at && (
            <span title={c.at} style={{ fontSize: FS_XS, color: t.textMuted }}>
              {ageFromIso(c.at)} ago
            </span>
          )}
          {c.observed_generation != null && (
            <span
              title="Generation the controller last observed"
              style={{
                fontSize: FS_XS,
                color:
                  generation != null && c.observed_generation < generation
                    ? t.warn
                    : t.textMuted,
              }}
            >
              gen {c.observed_generation}
              {generation != null && c.observed_generation < generation
                ? ` (spec is at ${generation})`
                : ""}
            </span>
          )}
        </DetailRow>
      ))}
    </section>
  );
}

function GitOpsValue({
  t,
  field,
  clusterId,
  onNavigate,
}: {
  t: Tokens;
  field: GitOpsField;
  clusterId: string;
  onNavigate?: DetailNavigate;
}) {
  const reference = field.reference;
  const navigable = useNavigable(reference, clusterId, onNavigate);
  const value = field.value ?? "";
  return (
    <DetailRow
      t={t}
      label={
        field.entries?.length ? (
          <Copyable text={value}>{field.label}</Copyable>
        ) : (
          field.label
        )
      }
    >
      {reference ? (
        <LinkValue
          t={t}
          copyText={value}
          enabled={navigable}
          onClick={() =>
            onNavigate?.(
              reference.kind,
              reference.namespace,
              reference.name,
              clusterId,
              reference.group,
            )
          }
        >
          <span style={{ overflowWrap: "anywhere", minWidth: 0 }}>{value}</span>
        </LinkValue>
      ) : field.entries && field.entries.length > 0 ? (
        <ExpandableList
          t={t}
          items={field.entries}
          render={(entries) => (
            <SubGrid
              t={t}
              copyKeyJoin=":"
              entries={entries.map(([key, v]) => ({ key, value: v }))}
            />
          )}
        />
      ) : (
        <Copyable text={value}>
          <Mono style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {value}
          </Mono>
        </Copyable>
      )}
    </DetailRow>
  );
}

const ACTION_ICON = {
  sync: Icons.sync,
  terminate: Icons.stop,
  reconcile: Icons.sync,
  refresh: Icons.refresh,
  hard_refresh: Icons.refresh,
  suspend: Icons.pause,
  resume: Icons.play,
} as const;

/** Argo CD's Delete choices; cascade is set through the resources finalizer. */
export function argoDeleteItems(ctl: GitOpsController, name: string): MenuItem[] {
  const blocked = !!ctl.blocked();
  const del = (label: string, cascade: "foreground" | "background" | "non_cascading", body: string) => ({
    kind: "item" as const,
    label,
    danger: true,
    disabled: blocked,
    onClick: () => void ctl.request("Delete", { type: "delete_app", cascade }, body),
  });
  return [
    del(
      `Delete ${name} and its resources`,
      "foreground",
      "Argo CD deletes every managed resource first, then the Application (foreground cascade).",
    ),
    del(
      "Delete, clean up resources in background",
      "background",
      "Argo CD deletes managed resources with background propagation (dependents are garbage-collected afterwards), then removes the Application.",
    ),
    { kind: "separator" },
    del(
      "Delete Application only (keep resources)",
      "non_cascading",
      "Removes the Application but leaves every deployed resource running and unmanaged.",
    ),
  ];
}

type MenuState = { kind: "refresh" | "reconcile"; pos: MenuPosition } | null;

// Title-bar buttons, same slot and shape as CronJob Run-now / Suspend.
export function GitOpsActions({
  t,
  mode,
  ctl,
  name,
  clusterId,
}: {
  t: Tokens;
  mode: ThemeMode;
  ctl: GitOpsController;
  name: string;
  clusterId: string;
}) {
  const refreshRef = useRef<HTMLButtonElement | null>(null);
  const reconcileRef = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const kinds = useAppStore((s) => s.kinds);
  const kindClusters = useTabSlice((v) => v.kindClusters);
  if (ctl.state.kind !== "ready") return null;
  const detail = ctl.state.detail;
  const actions = detail.actions;
  const find = (id: GitOpsAction["id"]) => actions.find((a) => a.id === id);
  const title = (a: GitOpsAction) => {
    if (ctl.busy === a.id) return `${a.label}…`;
    const reason = ctl.blocked(a);
    return reason ? `${a.label} — ${reason}` : a.label;
  };
  const openMenu = (kind: "refresh" | "reconcile", el: HTMLButtonElement | null) => {
    const r = el?.getBoundingClientRect();
    if (r) setMenu({ kind, pos: { x: r.right - 210, y: r.bottom + 4 } });
  };
  const button = (a: GitOpsAction | undefined, onClick?: () => void) =>
    a && (
      <IconBtn
        key={a.id}
        t={t}
        size="lg"
        title={title(a)}
        disabled={!!ctl.blocked(a)}
        onClick={onClick ?? (() => void ctl.run(a))}
      >
        {ACTION_ICON[a.id]}
      </IconBtn>
    );

  const sync = find("sync");
  const reconcile = find("reconcile");
  const refresh = find("refresh");
  const hard = find("hard_refresh");
  const flux = detail.flux;
  const sourceKind =
    flux?.source &&
    resolveResourceKind(kinds, kindClusters, flux.source.kind, clusterId, flux.source.group);
  const reconcileBlocked = reconcile ? ctl.blocked(reconcile) : "Unavailable";
  const reconcileRequest = (label: string, force: boolean, reset: boolean, withSource: boolean, confirmation: string) =>
    void ctl.request(
      label,
      {
        type: "reconcile",
        force,
        reset,
        with_source:
          withSource && flux?.source && sourceKind
            ? { kind_id: sourceKind.id, namespace: flux.source.namespace, name: flux.source.name }
            : null,
      },
      confirmation,
    );
  const RECONCILE_CONFIRM =
    "Flux may apply changes, upgrade workloads, or prune resources according to this object's policy.";
  const reconcileMenu = !!reconcile && (!!flux?.source || !!flux?.force_reset);

  const menuItems: MenuItem[] =
    menu?.kind === "refresh"
      ? [refresh, hard]
          .filter((a): a is GitOpsAction => !!a)
          .map((a) => ({
            kind: "item",
            label: a.label,
            disabled: !!ctl.blocked(a),
            onClick: () => void ctl.run(a),
          }))
      : menu?.kind === "reconcile" && reconcile
        ? [
            { kind: "item", label: "Reconcile", disabled: !!reconcileBlocked, onClick: () => void ctl.run(reconcile) },
            ...(flux?.source
              ? [
                  {
                    kind: "item" as const,
                    label: sourceKind ? `Reconcile with source (${flux.source.kind})` : "Reconcile with source — source kind not discovered",
                    disabled: !!reconcileBlocked || !sourceKind,
                    onClick: () =>
                      reconcileRequest(
                        "Reconcile with source",
                        false,
                        false,
                        true,
                        `Fetches ${flux.source!.kind} ${flux.source!.name} first, waits for it, then reconciles. ${RECONCILE_CONFIRM}`,
                      ),
                  },
                ]
              : []),
            ...(flux?.force_reset
              ? [
                  { kind: "separator" as const },
                  {
                    kind: "item" as const,
                    label: "Force upgrade",
                    disabled: !!reconcileBlocked,
                    onClick: () =>
                      reconcileRequest(
                        "Force upgrade",
                        true,
                        false,
                        false,
                        "Runs a one-off install/upgrade even though the release is in sync. Hooks run again.",
                      ),
                  },
                  {
                    kind: "item" as const,
                    label: "Reset retries",
                    disabled: !!reconcileBlocked,
                    onClick: () =>
                      reconcileRequest(
                        "Reset retries",
                        false,
                        true,
                        false,
                        "Clears the failure counters so an exhausted install/upgrade retry budget runs again.",
                      ),
                  },
                ]
              : []),
          ]
        : [];

  const dialog = ctl.dialog;
  const argo = detail.argo;
  const rollbackEntry =
    dialog?.kind === "rollback" ? argo?.history.find((h) => h.id === dialog.id) : undefined;

  return (
    <>
      {sync && button(sync, () => ctl.openDialog({ kind: "sync" }))}
      {reconcile &&
        (reconcileMenu ? (
          <IconBtn
            ref={reconcileRef}
            t={t}
            size="lg"
            title={reconcileBlocked ? `Reconcile — ${reconcileBlocked}` : "Reconcile…"}
            active={menu?.kind === "reconcile"}
            disabled={!!reconcileBlocked}
            onClick={() => openMenu("reconcile", reconcileRef.current)}
          >
            {Icons.sync}
          </IconBtn>
        ) : (
          button(reconcile)
        ))}
      {button(find("terminate"))}
      {refresh && hard ? (
        <IconBtn
          ref={refreshRef}
          t={t}
          size="lg"
          title="Refresh…"
          active={menu?.kind === "refresh"}
          disabled={!!ctl.blocked(refresh) && !!ctl.blocked(hard)}
          onClick={() => openMenu("refresh", refreshRef.current)}
        >
          {Icons.refresh}
        </IconBtn>
      ) : (
        button(refresh ?? hard)
      )}
      {button(find("suspend") ?? find("resume"))}
      {menu && (
        <ContextMenu
          mode={mode}
          position={menu.pos}
          rowName={name}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
      {dialog?.kind === "sync" && argo && (
        <SyncDialog
          t={t}
          mode={mode}
          name={name}
          argo={argo}
          resources={detail.resources ?? []}
          preselect={dialog.preselect}
          busy={ctl.busy === "sync"}
          onClose={ctl.closeDialog}
          onSubmit={async (req) => {
            const ok = await ctl.request(req.dry_run ? "Dry-run sync" : "Sync", { type: "sync", ...req });
            if (ok) ctl.closeDialog();
          }}
        />
      )}
      {dialog?.kind === "rollback" && rollbackEntry && (
        <RollbackDialog
          t={t}
          name={name}
          entry={rollbackEntry}
          busy={ctl.busy === "rollback"}
          onClose={ctl.closeDialog}
          onSubmit={async (prune, dryRun) => {
            if (rollbackEntry.id === null) return;
            const ok = await ctl.request(dryRun ? "Dry-run rollback" : "Rollback", {
              type: "rollback",
              id: rollbackEntry.id,
              prune,
              dry_run: dryRun,
            });
            if (ok) ctl.closeDialog();
          }}
        />
      )}
    </>
  );
}
