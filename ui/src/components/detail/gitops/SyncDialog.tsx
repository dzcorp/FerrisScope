import { useMemo, useState, type ReactNode } from "react";
import { DETAIL_LAYOUT, FS_SM, FS_XS, R_MD, type ThemeMode, type Tokens } from "../../../theme";
import type {
  ArgoExtras,
  GitOpsResource,
  GitOpsSyncResource,
} from "../../../types";
import {
  Btn,
  Checkbox,
  Dialog,
  Eyebrow,
  Select,
  StatusPill,
  TextInput,
  resolveKindIcon,
} from "../../ui";
import { Mono, Mute } from "..";

export const resourceKey = (r: { group: string; kind: string; namespace: string | null; name: string }) =>
  `${r.group}/${r.kind}/${r.namespace ?? ""}/${r.name}`;

// Known `syncOptions` rendered as checkboxes: option key → value when on.
const KNOWN_OPTIONS: { key: string; on: string; label: string; hint: string }[] = [
  { key: "CreateNamespace", on: "true", label: "Auto-create namespace", hint: "Create the destination namespace if missing" },
  { key: "ServerSideApply", on: "true", label: "Server-side apply", hint: "kubectl apply --server-side" },
  { key: "ApplyOutOfSyncOnly", on: "true", label: "Apply out-of-sync only", hint: "Skip resources already in sync" },
  { key: "PruneLast", on: "true", label: "Prune last", hint: "Prune after every other resource is healthy" },
  { key: "Replace", on: "true", label: "Replace", hint: "kubectl replace/create instead of apply" },
  { key: "Validate", on: "false", label: "Skip schema validation", hint: "kubectl apply --validate=false" },
  { key: "RespectIgnoreDifferences", on: "true", label: "Respect ignore differences", hint: "Don't overwrite ignored fields" },
];
const PROPAGATION = "PrunePropagationPolicy";
const LIST_CAP = 200;

type Parsed = { known: Record<string, string>; propagation: string; rest: string[] };

export function parseSyncOptions(opts: string[]): Parsed {
  const known: Record<string, string> = {};
  let propagation = "foreground";
  const rest: string[] = [];
  for (const o of opts) {
    const [k, v = ""] = o.split("=", 2) as [string, string?];
    if (k === PROPAGATION) propagation = v;
    else if (KNOWN_OPTIONS.some((x) => x.key === k)) known[k] = v;
    else rest.push(o);
  }
  return { known, propagation, rest };
}

export function buildSyncOptions(p: Parsed, pruneOn: boolean, hadPropagation: boolean): string[] {
  const out = KNOWN_OPTIONS.filter((o) => p.known[o.key] === o.on).map((o) => `${o.key}=${o.on}`);
  if (pruneOn && (hadPropagation || p.propagation !== "foreground")) out.push(`${PROPAGATION}=${p.propagation}`);
  return [...out, ...p.rest];
}

type Props = {
  t: Tokens;
  mode: ThemeMode;
  name: string;
  argo: ArgoExtras;
  resources: GitOpsResource[];
  /** Keys preselected when opened from a resource row. */
  preselect?: string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (req: {
    revision: string | null;
    revisions: string[] | null;
    prune: boolean;
    dry_run: boolean;
    force: boolean;
    apply_only: boolean;
    sync_options: string[];
    resources: GitOpsSyncResource[];
    retry: Record<string, unknown> | null;
  }) => void;
};

export function SyncDialog({ t, mode, name, argo, resources, preselect, busy, onClose, onSubmit }: Props) {
  const initialOptions = useMemo(() => parseSyncOptions(argo.sync_options), [argo.sync_options]);
  const hadPropagation = argo.sync_options.some((o) => o.startsWith(`${PROPAGATION}=`));
  const [revisions, setRevisions] = useState(argo.sources.map((s) => s.target_revision));
  const [prune, setPrune] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [force, setForce] = useState(false);
  const [applyOnly, setApplyOnly] = useState(false);
  const [options, setOptions] = useState<Parsed>(initialOptions);
  const specRetry = argo.retry as {
    limit?: number;
    refresh?: boolean;
    backoff?: { duration?: string; factor?: number; maxDuration?: string };
  } | null;
  const [retry, setRetry] = useState(!!specRetry);
  const [limit, setLimit] = useState(String(specRetry?.limit ?? 2));
  const [duration, setDuration] = useState(specRetry?.backoff?.duration ?? "5s");
  const [factor, setFactor] = useState(String(specRetry?.backoff?.factor ?? 2));
  const [maxDuration, setMaxDuration] = useState(specRetry?.backoff?.maxDuration ?? "3m");
  const allKeys = useMemo(() => resources.map(resourceKey), [resources]);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(preselect && preselect.length > 0 ? preselect : allKeys),
  );
  const [filter, setFilter] = useState("");

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? resources.filter((r) => `${r.kind} ${r.namespace ?? ""} ${r.name}`.toLowerCase().includes(q)) : resources;
  }, [filter, resources]);

  const limitNum = Number(limit);
  const factorNum = Number(factor);
  // Argo treats a negative limit as unlimited retries.
  const retryInvalid =
    retry &&
    (!Number.isInteger(limitNum) || limitNum === 0 || limitNum < -1 || !Number.isInteger(factorNum) || factorNum < 1);
  // A refetch can drop a selected resource; never let that widen the sync.
  const effective = useMemo(() => allKeys.filter((k) => selected.has(k)), [allKeys, selected]);
  const effectiveSet = useMemo(() => new Set(effective), [effective]);
  const nothingSelected = resources.length > 0 && effective.length === 0;
  const whole = effective.length === allKeys.length;
  const revisionOverridden = argo.sources.some((s, i) => {
    const r = revisions[i]?.trim();
    return !!r && r !== s.target_revision;
  });
  const autoRevert = argo.auto_sync.enabled && revisionOverridden && !dryRun;

  const submit = () => {
    const multi = argo.sources.length > 1;
    onSubmit({
      revision: multi ? null : (revisions[0] ?? null),
      revisions: multi ? revisions : null,
      prune,
      dry_run: dryRun,
      force,
      apply_only: applyOnly,
      sync_options: buildSyncOptions(options, prune, hadPropagation),
      resources: whole
        ? []
        : resources
            .filter((r) => effectiveSet.has(resourceKey(r)))
            .map((r) => ({ group: r.group, kind: r.kind, name: r.name, namespace: r.namespace })),
      retry: retry
        ? {
            limit: limitNum,
            ...(specRetry?.refresh ? { refresh: true } : {}),
            backoff: { duration, factor: factorNum, maxDuration },
          }
        : null,
    });
  };

  const toggle = (key: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <Dialog
      t={t}
      title={dryRun ? `Dry-run sync ${name}` : `Sync ${name}`}
      subtitle="Applies the target revision from Git. Nothing is pruned unless Prune is on."
      width={640}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1, fontSize: FS_SM, color: t.textMuted }}>
            {resources.length === 0 || whole
              ? "Whole application"
              : `${effective.length} of ${resources.length} resources`}
          </span>
          <Btn t={t} variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            t={t}
            variant={force || prune ? "danger" : "primary"}
            disabled={busy || nothingSelected || !!retryInvalid || autoRevert}
            onClick={submit}
          >
            {busy ? "Syncing…" : dryRun ? "Dry run" : "Sync"}
          </Btn>
        </>
      }
    >
      <Group t={t} title="Revision">
        {argo.sources.map((s, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: DETAIL_LAYOUT.columns, gap: DETAIL_LAYOUT.itemGap, alignItems: "center" }}>
            <span title={s.repo ?? undefined} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <Mono size={FS_SM}>{shortRepo(s.repo)}{s.path || s.chart ? ` · ${s.path ?? s.chart}` : ""}</Mono>
            </span>
            <TextInput
              t={t}
              mono
              value={revisions[i] ?? ""}
              placeholder={s.target_revision}
              onChange={(v) => setRevisions((prev) => prev.map((r, j) => (j === i ? v : r)))}
            />
          </div>
        ))}
      </Group>

      {autoRevert && (
        <div role="alert" style={{ fontSize: FS_SM, color: t.warn, margin: "-8px 0 12px" }}>
          Auto-sync is on and would revert a sync to another revision. Use Dry run, or disable auto-sync first.
        </div>
      )}

      <Group t={t} title="Options">
        <Grid>
          <Labelled t={t} label="Prune" hint="Delete resources no longer in Git" checked={prune} onChange={setPrune} />
          <Labelled t={t} label="Dry run" hint="Validate only, change nothing" checked={dryRun} onChange={setDryRun} />
          <Labelled t={t} label="Apply only" hint="Skip PreSync / PostSync hooks" checked={applyOnly} onChange={setApplyOnly} />
          <Labelled t={t} label="Force" hint="Delete and recreate on conflict" checked={force} onChange={setForce} tone="warn" />
        </Grid>
      </Group>

      <Group t={t} title="Sync options">
        <Grid>
          {KNOWN_OPTIONS.map((o) => (
            <Labelled
              key={o.key}
              t={t}
              label={o.label}
              hint={o.hint}
              checked={options.known[o.key] === o.on}
              onChange={(on) =>
                setOptions((p) => {
                  const known = { ...p.known };
                  if (on) known[o.key] = o.on;
                  else delete known[o.key];
                  return { ...p, known };
                })
              }
            />
          ))}
        </Grid>
        {prune && (
          <div style={{ display: "flex", alignItems: "center", gap: DETAIL_LAYOUT.itemGap, marginTop: 8 }}>
            <span style={{ fontSize: FS_SM, color: t.textDim }}>Prune propagation</span>
            <Select
              t={t}
              fullWidth={false}
              value={options.propagation}
              onChange={(v) => setOptions((p) => ({ ...p, propagation: v }))}
              options={[
                { value: "foreground", label: "Foreground" },
                { value: "background", label: "Background" },
                { value: "orphan", label: "Orphan" },
              ]}
            />
          </div>
        )}
        {options.rest.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <Mute t={t}>Kept from spec: </Mute>
            <Mono size={FS_XS}>{options.rest.join(", ")}</Mono>
          </div>
        )}
      </Group>

      <Group t={t} title="Retry">
        <Labelled t={t} label="Retry on failure" hint="Controller retries a failed sync with backoff" checked={retry} onChange={setRetry} />
        {retry && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: DETAIL_LAYOUT.itemGap, marginTop: 8 }}>
            <Field t={t} label="Limit"><TextInput t={t} mono value={limit} onChange={setLimit} /></Field>
            <Field t={t} label="Backoff"><TextInput t={t} mono value={duration} onChange={setDuration} /></Field>
            <Field t={t} label="Factor"><TextInput t={t} mono value={factor} onChange={setFactor} /></Field>
            <Field t={t} label="Max backoff"><TextInput t={t} mono value={maxDuration} onChange={setMaxDuration} /></Field>
          </div>
        )}
        {retryInvalid && (
          <div role="alert" style={{ fontSize: FS_SM, color: t.bad, marginTop: 6 }}>
            Limit must be a whole number (−1 for unlimited, not 0); factor at least 1.
          </div>
        )}
      </Group>

      {resources.length > 0 && (
        <Group
          t={t}
          title={`Resources · ${effective.length}/${resources.length}`}
          right={
            <div style={{ display: "flex", gap: 6 }}>
              <Btn t={t} size="sm" variant="ghost" onClick={() => setSelected(new Set(allKeys))}>All</Btn>
              <Btn
                t={t}
                size="sm"
                variant="ghost"
                onClick={() =>
                  setSelected(new Set(resources.filter((r) => r.sync && r.sync !== "Synced").map(resourceKey)))
                }
              >
                Out of sync
              </Btn>
              <Btn t={t} size="sm" variant="ghost" onClick={() => setSelected(new Set())}>None</Btn>
            </div>
          }
        >
          <TextInput t={t} value={filter} onChange={setFilter} placeholder="Filter resources…" />
          <div
            role="list"
            aria-label="Resources to sync"
            style={{ marginTop: 8, maxHeight: 240, overflowY: "auto", border: `1px solid ${t.border}`, borderRadius: R_MD }}
          >
            {visible.slice(0, LIST_CAP).map((r, i) => {
              const key = resourceKey(r);
              return (
                <div
                  key={key}
                  role="listitem"
                  style={{
                    display: "grid",
                    gridTemplateColumns: "auto 16px minmax(0, 1fr) auto",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 10px",
                    borderTop: i === 0 ? "none" : `1px solid ${t.borderSoft}`,
                  }}
                >
                  <Checkbox t={t} label={`${r.kind} ${r.name}`} checked={selected.has(key)} onChange={(on) => toggle(key, on)} />
                  <span aria-hidden style={{ color: t.textMuted, display: "inline-flex" }}>{resolveKindIcon(r.kind, r.group, "Apps")}</span>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <Mono size={FS_SM}>{r.name}</Mono>
                    <span style={{ fontSize: FS_XS, color: t.textMuted }}> · {r.kind}{r.namespace ? ` · ${r.namespace}` : ""}</span>
                  </span>
                  {r.sync ? <StatusPill t={t} mode={mode} status={r.sync} dense /> : <span />}
                </div>
              );
            })}
            {visible.length === 0 && (
              <div style={{ padding: "8px 10px" }}><Mute t={t}>No resources match.</Mute></div>
            )}
            {visible.length > LIST_CAP && (
              <div style={{ padding: "8px 10px" }}>
                <Mute t={t}>
                  {visible.length - LIST_CAP} more — filter to find them. All / Out of sync / None apply to every resource.
                </Mute>
              </div>
            )}
          </div>
        </Group>
      )}
    </Dialog>
  );
}

function shortRepo(repo: string | null): string {
  if (!repo) return "—";
  return repo.replace(/^https?:\/\//, "").replace(/\.git$/, "");
}

function Group({ t, title, right, children }: { t: Tokens; title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <Eyebrow t={t}>{title}</Eyebrow>
        {right}
      </div>
      {children}
    </section>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "8px 16px" }}>
      {children}
    </div>
  );
}

function Field({ t, label, children }: { t: Tokens; label: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: FS_XS, color: t.textMuted }}>
      {label}
      {children}
    </label>
  );
}

export function Labelled({
  t,
  label,
  hint,
  checked,
  onChange,
  tone,
  disabled,
}: {
  t: Tokens;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  tone?: "warn";
  disabled?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ paddingTop: 2 }}>
        <Checkbox t={t} label={label} checked={checked} disabled={disabled} onChange={onChange} />
      </span>
      <span
        onClick={() => !disabled && onChange(!checked)}
        style={{ cursor: disabled ? "default" : "pointer", minWidth: 0 }}
      >
        <span style={{ fontSize: FS_SM, color: tone === "warn" && checked ? t.warn : t.text }}>{label}</span>
        {hint && <span style={{ display: "block", fontSize: FS_XS, color: t.textMuted }}>{hint}</span>}
      </span>
    </div>
  );
}
