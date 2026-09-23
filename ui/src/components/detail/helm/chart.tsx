import { useEffect, useMemo, useRef, useState } from "react";
import { selectClusterDegraded, useAppStore, useResolvedTheme } from "../../../store";
import { api } from "../../../api";
import { confirm, toast } from "../../../lib/dialog";
import {
  namespaceError,
  parseChartUid,
  releaseNameError,
  suggestReleaseName,
  valuesYamlError,
  type ChartUid,
} from "../../../lib/helm";
import { DETAIL_LAYOUT, FS_SM, FS_XS, type ThemeMode, type Tokens } from "../../../theme";
import type { GitOpsCard, HelmChartDetail, HelmChartUsedBy } from "../../../types";
import { Btn, ErrorBlock, LoadingLine, Section, StatusPill, TextInput } from "../../ui";
import { Copyable, DetailRow, ExpandableList, LinkValue, Mono, Mute, ageFromIso, type DetailNavigate } from "..";
import { StatusCards, useNavigable } from "../gitops";
import { Cell, DataRow, DataTable } from "../gitops/table";
import { useDetail } from "../useDetail";
import { ExternalLinks, FailureBlock, Frame, HelmMissingNotice, Keywords, Notice, YamlEditor, sectionGap } from "./shared";
import type { HelmFailure } from "./useHelmRelease";

type Props = {
  clusterId: string;
  uid: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
};

export function HelmChartSummary(props: Props) {
  const t = useResolvedTheme().tokens;
  const parsed = useMemo(() => parseChartUid(props.uid), [props.uid]);
  if (!parsed)
    return (
      <Frame t={t}>
        <ErrorBlock t={t} message={`Cannot parse chart uid: ${props.uid}`} kindLabel="helm chart" />
      </Frame>
    );
  // Keyed so the install form resets when a different chart opens.
  return <ChartView key={`${props.clusterId}\u0000${props.uid}`} {...props} chart={parsed} />;
}

function ChartView({ clusterId, chart, detailVersion, onNavigate }: Props & { chart: ChartUid }) {
  const { tokens: t, mode } = useResolvedTheme();
  const [refetch, setRefetch] = useState(0);
  const state = useDetail(
    () => api.getHelmChartDetail(clusterId, chart.source, chart.name, chart.version),
    [clusterId, chart.source, chart.name, chart.version, detailVersion, refetch],
  );
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading chart…" />
      </Frame>
    );
  if (state.kind === "error")
    return (
      <Frame t={t}>
        <ErrorBlock t={t} message={state.message} kindLabel="helm chart" />
        <Btn t={t} onClick={() => setRefetch((n) => n + 1)}>
          Retry
        </Btn>
      </Frame>
    );
  const d = state.detail;
  const cards: GitOpsCard[] = [
    { label: "Chart", status: null, value: d.chart_name, caption: d.description, at: null },
    {
      label: "Version",
      status: null,
      value: d.chart_version,
      caption: d.app_version ? `app ${d.app_version}` : null,
      at: null,
    },
    {
      label: "Source",
      status: null,
      value: d.source === "cluster" ? "in-cluster" : d.source,
      caption: d.source === "cluster" ? "Extracted from an existing release" : "Local helm repo",
      at: null,
    },
    {
      label: "Used by",
      status: null,
      value: `${d.used_by.length} release${d.used_by.length === 1 ? "" : "s"}`,
      caption: null,
      at: null,
    },
  ];
  return (
    <Frame t={t}>
      {!d.helm_available && <HelmMissingNotice t={t} what="installs" />}
      <StatusCards t={t} mode={mode} cards={cards} />
      <section aria-label="Chart" style={sectionGap}>
        <Section t={t} title="Chart" />
        <DetailRow t={t} label="Description">
          {d.description ? (
            <Copyable text={d.description}>
              <span>{d.description}</span>
            </Copyable>
          ) : (
            <Mute t={t}>—</Mute>
          )}
        </DetailRow>
        {d.home && (
          <DetailRow t={t} label="Home">
            <ExternalLinks t={t} urls={[d.home]} />
          </DetailRow>
        )}
        {d.sources.length > 0 && (
          <DetailRow t={t} label="Sources">
            <ExternalLinks t={t} urls={[...new Set(d.sources)]} />
          </DetailRow>
        )}
        {d.keywords.length > 0 && (
          <DetailRow t={t} label="Keywords">
            <Keywords t={t} keywords={[...new Set(d.keywords)]} />
          </DetailRow>
        )}
      </section>
      <UsedBy t={t} mode={mode} d={d} clusterId={clusterId} onNavigate={onNavigate} />
      <Install t={t} d={d} clusterId={clusterId} onInstalled={() => setRefetch((n) => n + 1)} />
    </Frame>
  );
}

const USED_COLS = "minmax(0, 1.4fr) minmax(0, 1fr) 48px minmax(90px, 0.8fr) minmax(0, 0.7fr)";

function UsedBy({
  t,
  mode,
  d,
  clusterId,
  onNavigate,
}: {
  t: Tokens;
  mode: ThemeMode;
  d: HelmChartDetail;
  clusterId: string;
  onNavigate?: DetailNavigate;
}) {
  return (
    <section aria-label="Used by" style={sectionGap}>
      <Section t={t} title="Used by" right={<Mute t={t}>{d.used_by.length}</Mute>} />
      {d.used_by.length === 0 ? (
        <Mute t={t}>No releases use this chart version.</Mute>
      ) : (
        <DataTable t={t} label="Used by" columns={USED_COLS} header={["Release", "Namespace", "Rev", "Status", "Updated"]}>
          <ExpandableList
            t={t}
            items={d.used_by}
            render={(items) =>
              items.map((r) => (
                <UsedByRow
                  key={`${r.namespace}/${r.name}`}
                  t={t}
                  mode={mode}
                  r={r}
                  clusterId={clusterId}
                  onNavigate={onNavigate}
                />
              ))
            }
          />
        </DataTable>
      )}
    </section>
  );
}

function UsedByRow({
  t,
  mode,
  r,
  clusterId,
  onNavigate,
}: {
  t: Tokens;
  mode: ThemeMode;
  r: HelmChartUsedBy;
  clusterId: string;
  onNavigate?: DetailNavigate;
}) {
  const ref = useMemo(
    () => ({ kind: "HelmRelease", group: "", namespace: r.namespace, name: r.name, local: true }),
    [r.namespace, r.name],
  );
  const navigable = useNavigable(ref, clusterId, onNavigate);
  return (
    <DataRow t={t} columns={USED_COLS}>
      <Cell>
        <LinkValue
          t={t}
          copyText={`${r.namespace}/${r.name}`}
          enabled={navigable}
          truncate
          onClick={() => onNavigate?.("HelmRelease", r.namespace, r.name, clusterId, "")}
        >
          <Mono>{r.name}</Mono>
        </LinkValue>
      </Cell>
      <Cell>
        <Copyable text={r.namespace}>
          <Mono size={FS_SM}>{r.namespace}</Mono>
        </Copyable>
      </Cell>
      <Cell>
        <Mono size={FS_SM}>{r.revision}</Mono>
      </Cell>
      <Cell>{r.status ? <StatusPill t={t} mode={mode} status={r.status} dense /> : "—"}</Cell>
      <Cell title={r.updated ?? undefined}>
        <span style={{ color: t.textMuted }}>{r.updated ? `${ageFromIso(r.updated)} ago` : "—"}</span>
      </Cell>
    </DataRow>
  );
}

function FieldError({ t, children }: { t: Tokens; children: string }) {
  return (
    <div role="alert" style={{ fontSize: FS_XS, color: t.bad, marginTop: 4 }}>
      {children}
    </div>
  );
}

function Install({
  t,
  d,
  clusterId,
  onInstalled,
}: {
  t: Tokens;
  d: HelmChartDetail;
  clusterId: string;
  onInstalled: () => void;
}) {
  const degraded = useAppStore((s) => selectClusterDegraded(s, clusterId));
  const confirmDestructive = useAppStore((s) => s.settings.confirmDestructive);
  const [name, setName] = useState(() => suggestReleaseName(d.chart_name));
  const [namespace, setNamespace] = useState("default");
  const [values, setValues] = useState(d.default_values_yaml);
  const seeded = useRef(d.default_values_yaml);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<HelmFailure | null>(null);

  // Follow refreshed chart defaults only while the operator hasn't edited them.
  useEffect(() => {
    setValues((v) => (v === seeded.current ? d.default_values_yaml : v));
    seeded.current = d.default_values_yaml;
  }, [d.default_values_yaml]);

  const nameErr = releaseNameError(name.trim());
  const nsErr = namespaceError(namespace.trim());
  const valuesErr = valuesYamlError(values);
  const collision = d.used_by.find((r) => r.name === name.trim() && r.namespace === namespace.trim());
  const locked = !d.helm_available || degraded || saving;
  const canInstall = !locked && !nameErr && !nsErr && !valuesErr;
  const why = !d.helm_available ? "helm CLI not found" : degraded ? "Cluster unavailable" : null;

  const install = async () => {
    if (!canInstall) return;
    const rel = name.trim();
    const ns = namespace.trim();
    setSaving(true);
    try {
      if (
        confirmDestructive &&
        !(await confirm({
          title: `Install ${rel} into ${ns}?`,
          body: `Runs helm install for ${d.chart_name} ${d.chart_version} with the values below. The namespace is created if missing. Install hooks run.`,
          confirmLabel: "Install",
        }))
      )
        return;
      if (selectClusterDegraded(useAppStore.getState(), clusterId)) return;
      setFailure(null);
      const r = await api.installHelmChart(clusterId, d.source, ns, rel, d.chart_name, d.chart_version, values);
      if (r.kind === "installed") {
        toast.ok(
          `Installed ${r.release_name} in ${r.namespace} · revision ${r.revision}${r.status ? ` · ${r.status}` : ""}.`,
        );
        onInstalled();
      } else if (r.kind === "failed") {
        setFailure({ title: "Install failed", message: r.message, stderr: r.helm_stderr });
        toast.bad(`Install of ${rel} failed.\n${r.message}`);
      } else {
        toast.bad("Install failed: helm CLI not found.", { route: { section: "tools", anchor: "helm" } });
      }
    } catch (e) {
      toast.bad(`Install failed: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="Install" style={sectionGap}>
      <Section t={t} title="Install" right={<Mute t={t}>helm install --create-namespace</Mute>} />
      {failure && (
        <FailureBlock t={t} failure={failure} kindLabel="helm chart" onDismiss={() => setFailure(null)} />
      )}
      <DetailRow t={t} label="Release name">
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextInput
            t={t}
            mono
            ariaLabel="Release name"
            value={name}
            onChange={setName}
            placeholder={suggestReleaseName(d.chart_name)}
            disabled={locked}
            invalid={!!nameErr}
          />
          {nameErr && <FieldError t={t}>{nameErr}</FieldError>}
        </div>
      </DetailRow>
      <DetailRow t={t} label="Namespace">
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextInput
            t={t}
            mono
            ariaLabel="Namespace"
            value={namespace}
            onChange={setNamespace}
            placeholder="default"
            disabled={locked}
            invalid={!!nsErr}
          />
          {nsErr && <FieldError t={t}>{nsErr}</FieldError>}
        </div>
      </DetailRow>
      {collision && (
        <Notice t={t} tone="warn">
          Release {collision.name} already exists in {collision.namespace}; helm install will refuse to reuse the name.
          Open that release to upgrade it instead.
        </Notice>
      )}
      {valuesErr && (
        <Notice t={t} tone="bad">
          {valuesErr}
        </Notice>
      )}
      <div style={{ marginBottom: DETAIL_LAYOUT.itemGap }}>
        <YamlEditor t={t} label="Install values" value={values} onChange={setValues} readOnly={locked} height={360} />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {why && !saving && <span style={{ flex: 1, fontSize: FS_SM, color: t.textMuted }}>{why}</span>}
        <Btn
          t={t}
          variant="ghost"
          disabled={saving || values === d.default_values_yaml}
          onClick={() => setValues(d.default_values_yaml)}
        >
          Reset values
        </Btn>
        <Btn t={t} variant="primary" disabled={!canInstall} onClick={() => void install()}>
          {saving ? "Installing…" : "Install"}
        </Btn>
      </div>
    </section>
  );
}
