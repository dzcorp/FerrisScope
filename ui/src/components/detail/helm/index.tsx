import { useMemo, useState } from "react";
import { useResolvedTheme } from "../../../store";
import { FF_MONO, FS_SM, FS_XS, R_MD, type ThemeMode, type Tokens } from "../../../theme";
import { approxLineDiff, isPendingStatus, valuesToYaml, valuesYamlError } from "../../../lib/helm";
import type { HelmReleaseDetail, HelmReleaseHistoryEntry } from "../../../types";
import { Btn, Dialog, ErrorBlock, IconBtn, Icons, LoadingLine, Section, StatusPill } from "../../ui";
import {
  CollapsibleCard,
  Copyable,
  DetailRow,
  ExpandableList,
  Mono,
  Mute,
  SubGrid,
  ageFromIso,
  type DetailNavigate,
} from "..";
import { EditModeChrome } from "../edit";
import { ResourceList, StatusCards } from "../gitops";
import { Cell, DataRow, DataTable } from "../gitops/table";
import { ExternalLinks, FailureBlock, Frame, HelmMissingNotice, Keywords, Notice, YamlEditor, sectionGap } from "./shared";
import type { HelmController } from "./useHelmRelease";

export { useHelmRelease, type HelmController } from "./useHelmRelease";

type SummaryProps = {
  ctl: HelmController;
  clusterId: string;
  onNavigate?: DetailNavigate;
};

export function HelmReleaseSummary({ ctl, clusterId, onNavigate }: SummaryProps) {
  const { tokens: t, mode } = useResolvedTheme();
  const state = ctl.state;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading release…" />
      </Frame>
    );
  if (state.kind === "error")
    return (
      <Frame t={t}>
        <ErrorBlock t={t} message={state.message} kindLabel="helm release" />
        <Btn t={t} onClick={ctl.reload}>
          Retry
        </Btn>
      </Frame>
    );
  const d = state.detail;
  return (
    <Frame t={t}>
      {ctl.refreshError && (
        <Notice
          t={t}
          tone="warn"
          actions={
            <Btn t={t} size="sm" variant="ghost" onClick={ctl.reload}>
              Retry
            </Btn>
          }
        >
          Couldn't refresh ({ctl.refreshError}). Showing the last loaded revision.
        </Notice>
      )}
      {!d.helm_available && <HelmMissingNotice t={t} what="upgrades, rollbacks and value edits" />}
      {ctl.failure && (
        <FailureBlock t={t} failure={ctl.failure} kindLabel="helm release" onDismiss={ctl.clearFailure} />
      )}
      <StatusCards t={t} mode={mode} cards={d.cards} />
      <Notes t={t} notes={d.notes} />
      <ResourceList t={t} mode={mode} resources={d.resources} clusterId={clusterId} onNavigate={onNavigate} />
      {d.hooks_resources.length > 0 && (
        <ResourceList
          t={t}
          mode={mode}
          title="Hooks"
          resources={d.hooks_resources}
          clusterId={clusterId}
          onNavigate={onNavigate}
        />
      )}
      <History t={t} mode={mode} d={d} ctl={ctl} />
      <Details t={t} d={d} />
      <Chart t={t} d={d} />
      <Values t={t} d={d} ctl={ctl} />
      <section aria-label="Manifest" style={sectionGap}>
        <Section
          t={t}
          title="Manifest"
          right={d.manifest ? <Mute t={t}>{d.manifest.split("\n").length} lines</Mute> : undefined}
        />
        <YamlEditor t={t} label="Manifest" value={d.manifest ?? ""} readOnly height={360} emptyLabel="— no rendered manifest" />
      </section>
      {d.hooks.length > 0 && (
        <section aria-label="Hook manifests" style={sectionGap}>
          <CollapsibleCard t={t} header={() => <Mono>Hook manifests ({d.hooks.length})</Mono>}>
            <YamlEditor t={t} label="Hook manifests" value={valuesToYaml(d.hooks)} readOnly height={260} />
          </CollapsibleCard>
        </section>
      )}
    </Frame>
  );
}

function Notes({ t, notes }: { t: Tokens; notes: string | null }) {
  const text = notes?.trim() ?? "";
  if (!text) return null;
  return (
    <section aria-label="Notes" style={sectionGap}>
      <Section
        t={t}
        title="Notes"
        right={
          <IconBtn t={t} title="Copy notes" onClick={() => void navigator.clipboard?.writeText(text)}>
            {Icons.copy}
          </IconBtn>
        }
      />
      <pre
        className="fs-selectable"
        style={{
          margin: 0,
          padding: "10px 12px",
          fontFamily: FF_MONO,
          fontSize: FS_SM,
          lineHeight: 1.5,
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: R_MD,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: 260,
          overflow: "auto",
        }}
      >
        {text}
      </pre>
    </section>
  );
}

const HISTORY_COLS =
  "40px minmax(90px, 0.8fr) minmax(0, 0.8fr) minmax(0, 0.7fr) minmax(0, 0.6fr) minmax(0, 1.4fr) auto";

function History({ t, mode, d, ctl }: { t: Tokens; mode: ThemeMode; d: HelmReleaseDetail; ctl: HelmController }) {
  if (d.history.length === 0) return null;
  const blocked = ctl.blocked();
  return (
    <section aria-label="History" style={sectionGap}>
      <Section t={t} title="History" right={<Mute t={t}>{d.history.length}</Mute>} />
      <DataTable
        t={t}
        label="History"
        columns={HISTORY_COLS}
        header={["#", "Status", "Chart", "App", "Updated", "Description", ""]}
      >
        <ExpandableList
          t={t}
          items={d.history}
          render={(items) =>
            items.map((h) => {
              const current = h.revision === d.revision;
              return (
                <DataRow key={h.revision} t={t} columns={HISTORY_COLS} highlight={current}>
                  <Cell>
                    <Mono size={FS_SM}>{h.revision}</Mono>
                  </Cell>
                  <Cell>{h.status ? <StatusPill t={t} mode={mode} status={h.status} dense /> : "—"}</Cell>
                  <Cell title={h.chart ?? undefined}>
                    <Mono size={FS_SM}>{h.chart_version ?? "—"}</Mono>
                  </Cell>
                  <Cell>
                    <Mono size={FS_SM}>{h.app_version ?? "—"}</Mono>
                  </Cell>
                  <Cell title={h.updated ?? undefined}>
                    <span style={{ color: t.textMuted }}>{h.updated ? `${ageFromIso(h.updated)} ago` : "—"}</span>
                  </Cell>
                  <Cell title={h.description ?? undefined}>
                    <span style={{ color: t.textMuted }}>{h.description ?? "—"}</span>
                  </Cell>
                  <Cell>
                    {current ? (
                      <Mute t={t}>current</Mute>
                    ) : (
                      <Btn
                        t={t}
                        size="sm"
                        variant="ghost"
                        disabled={!!blocked}
                        title={blocked ?? `Roll back to revision ${h.revision}`}
                        onClick={() => ctl.openRollback(h.revision)}
                      >
                        Rollback
                      </Btn>
                    )}
                  </Cell>
                </DataRow>
              );
            })
          }
        />
      </DataTable>
    </section>
  );
}

function Opt({ t, v }: { t: Tokens; v: string | null | undefined }) {
  return v ? (
    <Copyable text={v}>
      <Mono>{v}</Mono>
    </Copyable>
  ) : (
    <Mute t={t}>—</Mute>
  );
}

function When({ t, iso }: { t: Tokens; iso: string | null }) {
  if (!iso) return <Mute t={t}>—</Mute>;
  return (
    <Copyable text={iso}>
      <Mono>
        {ageFromIso(iso)} ago <span style={{ color: t.textMuted }}>({iso})</span>
      </Mono>
    </Copyable>
  );
}

function Details({ t, d }: { t: Tokens; d: HelmReleaseDetail }) {
  return (
    <section aria-label="Details" style={sectionGap}>
      <Section t={t} title="Details" />
      <DetailRow t={t} label="Name">
        <Opt t={t} v={d.name} />
      </DetailRow>
      <DetailRow t={t} label="Namespace">
        <Opt t={t} v={d.namespace} />
      </DetailRow>
      <DetailRow t={t} label="Revision">
        <Opt t={t} v={String(d.revision)} />
      </DetailRow>
      <DetailRow t={t} label="Description">
        <Opt t={t} v={d.description} />
      </DetailRow>
      <DetailRow t={t} label="First deployed">
        <When t={t} iso={d.first_deployed} />
      </DetailRow>
      <DetailRow t={t} label="Last deployed">
        <When t={t} iso={d.last_deployed} />
      </DetailRow>
      {d.deleted && (
        <DetailRow t={t} label="Deleted">
          <When t={t} iso={d.deleted} />
        </DetailRow>
      )}
    </section>
  );
}

function Chart({ t, d }: { t: Tokens; d: HelmReleaseDetail }) {
  return (
    <section aria-label="Chart" style={sectionGap}>
      <Section t={t} title="Chart" />
      <DetailRow t={t} label="Reference">
        <Opt t={t} v={d.chart} />
        <SubGrid
          t={t}
          entries={[
            { key: "name", value: d.chart_name },
            { key: "version", value: d.chart_version },
            { key: "app version", value: d.app_version },
            { key: "description", value: d.chart_description },
          ]}
        />
      </DetailRow>
      {d.chart_home && (
        <DetailRow t={t} label="Home">
          <ExternalLinks t={t} urls={[d.chart_home]} />
        </DetailRow>
      )}
      {d.chart_sources.length > 0 && (
        <DetailRow t={t} label="Sources">
          <ExternalLinks t={t} urls={[...new Set(d.chart_sources)]} />
        </DetailRow>
      )}
      {d.chart_keywords.length > 0 && (
        <DetailRow t={t} label="Keywords">
          <Keywords t={t} keywords={[...new Set(d.chart_keywords)]} />
        </DetailRow>
      )}
    </section>
  );
}

function Values({ t, d, ctl }: { t: Tokens; d: HelmReleaseDetail; ctl: HelmController }) {
  const [tab, setTab] = useState<"user" | "defaults">("user");
  const userText = useMemo(() => valuesToYaml(d.values_user), [d.values_user]);
  const defaultsText = useMemo(() => valuesToYaml(d.values_chart_defaults), [d.values_chart_defaults]);
  const draft = ctl.draft;
  const editing = draft !== null;
  const saving = ctl.busy === "values";
  const parseError = useMemo(() => (draft ? valuesYamlError(draft.text) : null), [draft]);
  const stale = editing && draft.revision !== d.revision;
  const reason = ctl.blocked();
  const readOnlyReason = !d.helm_available
    ? "read-only · helm CLI not found"
    : isPendingStatus(d.status)
      ? "read-only · operation in progress"
      : reason === "Cluster unavailable"
        ? "read-only · cluster unavailable"
        : null;

  const save = () => {
    if (!draft || parseError) return;
    void ctl.saveValues(draft.text);
  };

  return (
    <section aria-label="Values" style={sectionGap}>
      <Section
        t={t}
        title="Values"
        right={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Btn t={t} size="sm" variant="ghost" pressed={tab === "user"} onClick={() => setTab("user")}>
              User
            </Btn>
            <Btn t={t} size="sm" variant="ghost" pressed={tab === "defaults"} onClick={() => setTab("defaults")}>
              Chart defaults
            </Btn>
            {tab === "user" &&
              (readOnlyReason && !editing ? (
                <span style={{ fontSize: FS_XS, color: t.textMuted }}>{readOnlyReason}</span>
              ) : (
                <EditModeChrome
                  t={t}
                  editing={editing}
                  dirty={editing ? approxLineDiff(userText, draft.text) : 0}
                  saving={saving}
                  onEnter={() => ctl.setDraft({ text: userText, revision: d.revision })}
                  onCancel={() => ctl.setDraft(null)}
                  onSave={stale || parseError || readOnlyReason ? undefined : save}
                />
              ))}
          </span>
        }
      />
      {tab === "user" && editing && (
        <>
          {stale && (
            <Notice
              t={t}
              tone="warn"
              actions={
                <>
                  <Btn t={t} size="sm" variant="ghost" disabled={saving} onClick={() => ctl.setDraft(null)}>
                    Reload
                  </Btn>
                  <Btn t={t} size="sm" variant="danger" disabled={saving || !!reason || !!parseError} onClick={save}>
                    Apply anyway
                  </Btn>
                </>
              }
            >
              Release changed to revision {d.revision} since you started editing revision {draft.revision}. Saving
              replaces its values with yours.
            </Notice>
          )}
          {parseError && (
            <Notice t={t} tone="bad">
              {parseError}
            </Notice>
          )}
          {reason && readOnlyReason && (
            <Notice t={t} tone="warn">
              {reason} — your edits are kept.
            </Notice>
          )}
        </>
      )}
      {tab === "user" && editing ? (
        <YamlEditor
          t={t}
          label="User values"
          value={draft.text}
          onChange={(text) => ctl.setDraft({ text, revision: draft.revision })}
          readOnly={saving}
          height={320}
        />
      ) : (
        <YamlEditor
          t={t}
          label={tab === "user" ? "User values" : "Chart default values"}
          value={tab === "user" ? userText : defaultsText}
          readOnly
          height={320}
          emptyLabel={tab === "user" ? "— no overrides (chart defaults)" : "— no defaults"}
        />
      )}
    </section>
  );
}

/** Title-bar actions, same slot and shape as the GitOps / CronJob buttons. */
export function HelmActions({ t, mode, ctl }: { t: Tokens; mode: ThemeMode; ctl: HelmController }) {
  if (ctl.state.kind !== "ready") return null;
  const d = ctl.state.detail;
  const reason = ctl.blocked();
  const previous = d.history.find((h) => h.revision !== d.revision);
  const update = d.update_available;
  const upgradeReason = reason ?? (ctl.draft ? "Save or cancel the values edit first" : null);
  const repoReason = !d.helm_available ? "helm CLI not found" : ctl.busy ? "Another request is in flight" : null;
  const label = (base: string, why: string | null, busy: boolean) =>
    busy ? `${base}…` : why ? `${base} — ${why}` : base;
  return (
    <>
      {update && (
        <IconBtn
          t={t}
          size="lg"
          title={label(`Upgrade to ${update.version}`, upgradeReason, ctl.busy === "upgrade")}
          disabled={!!upgradeReason}
          onClick={() => void ctl.upgradeToLatest()}
        >
          {Icons.upgrade}
        </IconBtn>
      )}
      <IconBtn
        t={t}
        size="lg"
        title={label("Rollback…", reason ?? (previous ? null : "No earlier revision"), ctl.busy === "rollback")}
        disabled={!!reason || !previous}
        onClick={() => previous && ctl.openRollback(previous.revision)}
      >
        {Icons.rollback}
      </IconBtn>
      <IconBtn
        t={t}
        size="lg"
        title={label("Update repos", repoReason, ctl.busy === "repo_update")}
        disabled={!!repoReason}
        onClick={() => void ctl.repoUpdate()}
      >
        {Icons.refresh}
      </IconBtn>
      {ctl.rollbackDialog !== null && (
        <RollbackDialog t={t} mode={mode} d={d} ctl={ctl} initial={ctl.rollbackDialog} />
      )}
    </>
  );
}

const DIALOG_COLS = "40px minmax(90px, 0.9fr) minmax(0, 0.8fr) minmax(0, 0.6fr)";

function RollbackDialog({
  t,
  mode,
  d,
  ctl,
  initial,
}: {
  t: Tokens;
  mode: ThemeMode;
  d: HelmReleaseDetail;
  ctl: HelmController;
  initial: number;
}) {
  const [selected, setSelected] = useState(initial);
  const busy = ctl.busy === "rollback";
  const reason = busy ? null : ctl.blocked();
  const options: HelmReleaseHistoryEntry[] = d.history.filter((h) => h.revision !== d.revision);
  const valid = options.some((h) => h.revision === selected);
  return (
    <Dialog
      t={t}
      title={`Roll back ${d.name}`}
      subtitle="helm rollback re-deploys the chosen revision's chart and values as a new revision. Rollback hooks run."
      width={560}
      busy={busy}
      onClose={ctl.closeRollback}
      footer={
        <>
          {reason && <span style={{ flex: 1, fontSize: FS_SM, color: t.textMuted }}>{reason}</span>}
          <Btn t={t} variant="ghost" disabled={busy} onClick={ctl.closeRollback}>
            Cancel
          </Btn>
          <Btn
            t={t}
            variant="danger"
            disabled={busy || !valid || !!reason}
            onClick={async () => {
              if (await ctl.rollback(selected)) ctl.closeRollback();
            }}
          >
            {busy ? "Rolling back…" : `Roll back to ${selected}`}
          </Btn>
        </>
      }
    >
      <DataTable t={t} label="Revisions" columns={DIALOG_COLS} header={["#", "Status", "Chart", "Updated"]}>
        <div role="radiogroup" aria-label="Revision">
          {options.map((h) => (
            <div
              key={h.revision}
              role="radio"
              aria-checked={h.revision === selected}
              aria-label={`Revision ${h.revision}`}
              tabIndex={0}
              onClick={() => setSelected(h.revision)}
              onKeyDown={(e) => {
                if (e.key === " " || e.key === "Enter") {
                  e.preventDefault();
                  setSelected(h.revision);
                }
              }}
              style={{ cursor: "pointer" }}
            >
              <DataRow t={t} columns={DIALOG_COLS} highlight={h.revision === selected}>
                <Cell>
                  <Mono size={FS_SM}>{h.revision}</Mono>
                </Cell>
                <Cell>{h.status ? <StatusPill t={t} mode={mode} status={h.status} dense /> : "—"}</Cell>
                <Cell title={h.description ?? undefined}>
                  <Mono size={FS_SM}>{h.chart_version ?? "—"}</Mono>
                  {h.app_version && <span style={{ color: t.textMuted }}> · app {h.app_version}</span>}
                </Cell>
                <Cell title={h.updated ?? undefined}>
                  <span style={{ color: t.textMuted }}>{h.updated ? `${ageFromIso(h.updated)} ago` : "—"}</span>
                </Cell>
              </DataRow>
            </div>
          ))}
        </div>
      </DataTable>
    </Dialog>
  );
}
