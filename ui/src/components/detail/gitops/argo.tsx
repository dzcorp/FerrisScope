import { useState } from "react";
import { api } from "../../../api";
import { DETAIL_LAYOUT, FS_SM, FS_XS, type ThemeMode, type Tokens } from "../../../theme";
import type { ArgoExtras, ArgoHistoryEntry } from "../../../types";
import { Btn, Chip, Dialog, Section, StatusPill, Toggle } from "../../ui";
import { Copyable, DetailRow, ExpandableList, Mono, Mute, ageFromIso } from "..";
import { Labelled } from "./SyncDialog";
import { Cell, DataRow, DataTable } from "./table";
import type { GitOpsController } from "./useGitOps";

const gap = { marginBottom: DETAIL_LAYOUT.sectionGap } as const;

export function ArgoOverview({ t, argo }: { t: Tokens; argo: ArgoExtras }) {
  if (argo.images.length === 0 && argo.urls.length === 0) return null;
  return (
    <section aria-label="Application" style={gap}>
      <Section t={t} title="Application" />
      {argo.urls.length > 0 && (
        <DetailRow t={t} label="External URLs">
          <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {argo.urls.map((u) => (
              <Btn key={u} t={t} size="sm" variant="ghost" title={`Open ${u}`} onClick={() => void api.openExternal(u)}>
                {u.replace(/^https?:\/\//, "")}
              </Btn>
            ))}
          </span>
        </DetailRow>
      )}
      {argo.images.length > 0 && (
        <DetailRow t={t} label="Images">
          <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {argo.images.map((i) => (
              <Copyable key={i} text={i}>
                <Chip t={t}>
                  <Mono size={FS_XS}>{i}</Mono>
                </Chip>
              </Copyable>
            ))}
          </span>
        </DetailRow>
      )}
    </section>
  );
}

export function AutoSyncControl({ t, argo, ctl }: { t: Tokens; argo: ArgoExtras; ctl: GitOpsController }) {
  const { enabled, prune, self_heal } = argo.auto_sync;
  const reason = ctl.blocked();
  const set = (next: { enabled: boolean; prune: boolean; self_heal: boolean }, label: string, confirmation: string) =>
    void ctl.request(label, { type: "set_auto_sync", ...next }, confirmation);
  const subReason = reason ?? (enabled ? undefined : "Enable auto-sync first");
  return (
    <section aria-label="Automated sync" style={gap}>
      <Section t={t} title="Automated sync" right={reason ? <Mute t={t}>{reason}</Mute> : undefined} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 22px", alignItems: "center" }}>
        <Toggle
          t={t}
          label="Auto-sync"
          checked={enabled}
          disabled={!!reason}
          title={reason ?? undefined}
          onChange={(on) =>
            set(
              { enabled: on, prune, self_heal },
              on ? "Enable auto-sync" : "Disable auto-sync",
              on
                ? "Argo CD will sync this application whenever Git changes."
                : "Changes in Git will no longer be applied until someone syncs manually. A parent app-of-apps or ApplicationSet may restore this setting.",
            )
          }
        />
        <Toggle
          t={t}
          size="sm"
          tone="warn"
          label="Prune"
          checked={prune}
          disabled={!!subReason}
          title={subReason}
          onChange={(on) =>
            set({ enabled, prune: on, self_heal }, on ? "Enable auto-prune" : "Disable auto-prune", on ? "Automated syncs will delete resources removed from Git." : "Automated syncs will stop deleting resources removed from Git.")
          }
        />
        <Toggle
          t={t}
          size="sm"
          label="Self-heal"
          checked={self_heal}
          disabled={!!subReason}
          title={subReason}
          onChange={(on) =>
            set({ enabled, prune, self_heal: on }, on ? "Enable self-heal" : "Disable self-heal", on ? "Argo CD will revert live changes that drift from Git." : "Live drift will be reported but not reverted.")
          }
        />
      </div>
    </section>
  );
}

const HISTORY_COLS = "48px minmax(0, 1.2fr) minmax(0, 0.8fr) minmax(0, 0.8fr) auto";

export function ArgoHistory({ t, argo, ctl }: { t: Tokens; argo: ArgoExtras; ctl: GitOpsController }) {
  if (argo.history.length === 0) return null;
  const blocked = argo.rollback_blocked ?? ctl.blocked();
  return (
    <section aria-label="Deployment history" style={gap}>
      <Section t={t} title="Deployment history" right={<Mute t={t}>{argo.history.length}</Mute>} />
      <DataTable t={t} label="Deployment history" columns={HISTORY_COLS} header={["#", "Revision", "Deployed", "By", ""]}>
        <ExpandableList
          t={t}
          items={argo.history}
          render={(items) =>
            items.map((h, i) => (
              <DataRow key={h.id ?? i} t={t} columns={HISTORY_COLS} highlight={i === 0}>
                <Cell><Mono size={FS_SM}>{h.id ?? "—"}</Mono></Cell>
                <Cell title={h.revision ?? undefined}>
                  {h.revision ? (
                    <Copyable text={h.revision}><Mono size={FS_SM}>{h.revision}</Mono></Copyable>
                  ) : "—"}
                </Cell>
                <Cell
                  title={[
                    h.started_at && `Started ${h.started_at}`,
                    h.deployed_at && `Deployed ${h.deployed_at}`,
                  ]
                    .filter(Boolean)
                    .join("\n") || undefined}
                >
                  <span style={{ color: t.textMuted }}>{h.deployed_at ? `${ageFromIso(h.deployed_at)} ago` : "—"}</span>
                </Cell>
                <Cell title={h.source ?? undefined}>
                  <span style={{ color: t.textMuted }}>{h.initiated_by ?? "—"}</span>
                </Cell>
                <Cell>
                  {i === 0 ? (
                    <Mute t={t}>current</Mute>
                  ) : (
                    <Btn
                      t={t}
                      size="sm"
                      variant="ghost"
                      disabled={!!blocked || !h.rollback || h.id === null}
                      title={
                        !h.rollback
                          ? "Deployed without source tracking; sync to this revision instead"
                          : (blocked ?? `Roll back to deployment ${h.id}`)
                      }
                      onClick={() => h.id !== null && ctl.openDialog({ kind: "rollback", id: h.id })}
                    >
                      Rollback
                    </Btn>
                  )}
                </Cell>
              </DataRow>
            ))
          }
        />
      </DataTable>
    </section>
  );
}

export function RollbackDialog({
  t,
  name,
  entry,
  busy,
  onClose,
  onSubmit,
}: {
  t: Tokens;
  name: string;
  entry: ArgoHistoryEntry;
  busy: boolean;
  onClose: () => void;
  onSubmit: (prune: boolean, dryRun: boolean) => void;
}) {
  const [prune, setPrune] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  return (
    <Dialog
      t={t}
      title={`Roll back ${name} to deployment ${entry.id}`}
      subtitle="Syncs the source and revision recorded for that deployment. Auto-sync stays off so it isn't reverted."
      width={480}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Btn t={t} variant="ghost" disabled={busy} onClick={onClose}>Cancel</Btn>
          <Btn t={t} variant="danger" disabled={busy} onClick={() => onSubmit(prune, dryRun)}>
            {busy ? "Rolling back…" : dryRun ? "Dry run" : "Rollback"}
          </Btn>
        </>
      }
    >
      <DetailRow t={t} label="Revision">
        <Mono size={FS_SM}>{entry.revision ?? "—"}</Mono>
      </DetailRow>
      {entry.source && (
        <DetailRow t={t} label="Source"><Mono size={FS_SM}>{entry.source}</Mono></DetailRow>
      )}
      {entry.deployed_at && (
        <DetailRow t={t} label="Deployed">{ageFromIso(entry.deployed_at)} ago</DetailRow>
      )}
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        <Labelled t={t} label="Prune" hint="Delete resources that don't exist in that revision" checked={prune} onChange={setPrune} tone="warn" />
        <Labelled t={t} label="Dry run" hint="Validate only, change nothing" checked={dryRun} onChange={setDryRun} />
      </div>
    </Dialog>
  );
}

const RESULT_COLS = "minmax(0, 0.9fr) minmax(0, 1.3fr) minmax(0, 1.8fr)";

export function SyncResults({ t, mode, argo }: { t: Tokens; mode: ThemeMode; argo: ArgoExtras }) {
  if (argo.sync_result.length === 0) return null;
  const failed = argo.sync_result.filter((r) => r.status && r.status !== "Synced").length;
  return (
    <section aria-label="Last sync result" style={gap}>
      <Section
        t={t}
        title="Last sync result"
        right={<Mute t={t}>{argo.sync_result.length}{failed > 0 ? ` · ${failed} not synced` : ""}</Mute>}
      />
      <DataTable t={t} label="Last sync result" columns={RESULT_COLS} header={["Status", "Resource", "Message"]}>
        <ExpandableList
          t={t}
          items={[...argo.sync_result].sort((a, b) => Number(a.status === "Synced") - Number(b.status === "Synced"))}
          render={(items) =>
            items.map((r, i) => (
              <DataRow key={i} t={t} columns={RESULT_COLS}>
                <Cell>
                  {r.status ? <StatusPill t={t} mode={mode} status={r.status === "SyncFailed" ? "Failed" : r.status} dense /> : "—"}
                </Cell>
                <Cell title={`${r.kind ?? ""}/${r.name ?? ""}`}>
                  <Mono size={FS_SM}>{r.name ?? "—"}</Mono>
                  <span style={{ fontSize: FS_XS, color: t.textMuted }}>
                    {" "}· {r.kind}
                    {r.namespace ? ` · ${r.namespace}` : ""}
                    {r.sync_phase ? ` · ${r.sync_phase}` : ""}
                    {r.hook_type ? ` · ${r.hook_type} hook${r.hook_phase ? ` ${r.hook_phase}` : ""}` : ""}
                  </span>
                </Cell>
                <Cell title={r.message ?? undefined}>
                  <span style={{ color: t.textMuted }}>{r.message ?? "—"}</span>
                </Cell>
              </DataRow>
            ))
          }
        />
      </DataTable>
    </section>
  );
}
