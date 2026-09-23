import { useState } from "react";
import { useResolvedTheme } from "../../../store";
import { api } from "../../../api";
import {
  DETAIL_LAYOUT,
  FF_MONO,
  FS_LG,
  FS_MD,
  FS_SM,
  FS_XS,
  R_LG,
  type ThemeMode,
  type Tokens,
} from "../../../theme";
import { BarGauge, ErrorBlock, Eyebrow, LoadingLine, Section, StatusPill } from "../../ui";
import {
  ConditionChip,
  Copyable,
  DetailRow,
  EditSessionProvider,
  GlobalSaveBar,
  LinkValue,
  Mute,
  ageFromIso,
  type DetailNavigate,
  useDetail,
} from "..";
import { MetaSection } from "../workload/shared";
import type { HorizontalPodAutoscalerDetail, HpaMetric } from "../../../types";

const KIND_ID = "horizontalpodautoscalers";

// True is the bad state for this condition.
const INVERTED_CONDITIONS = new Set(["ScalingLimited"]);

function Card({ t, label, children }: { t: Tokens; label: string; children: React.ReactNode }) {
  return (
    <div
      role="listitem"
      aria-label={label}
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
      <Eyebrow t={t}>{label}</Eyebrow>
      {children}
    </div>
  );
}

function CardGrid({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="list"
      aria-label={label}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(${DETAIL_LAYOUT.cardMinWidth}px, 1fr))`,
        gap: DETAIL_LAYOUT.itemGap,
        marginBottom: DETAIL_LAYOUT.sectionGap,
      }}
    >
      {children}
    </div>
  );
}

function Caption({ t, children, title }: { t: Tokens; children: React.ReactNode; title?: string }) {
  return (
    <div
      title={title}
      style={{
        fontSize: FS_SM,
        color: t.textMuted,
        display: "-webkit-box",
        WebkitLineClamp: 3,
        WebkitBoxOrient: "vertical",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

const BIG = {
  fontFamily: FF_MONO,
  fontSize: FS_LG,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
} as const;

export function HpaOverview({
  t,
  mode,
  detail: d,
  namespace,
  onNavigate,
}: {
  t: Tokens;
  mode: ThemeMode;
  detail: HorizontalPodAutoscalerDetail;
  namespace: string | null;
  onNavigate?: DetailNavigate;
}) {
  const min = d.min_replicas ?? 1;
  const current = d.current_replicas;
  const desired = d.desired_replicas;
  const moving = current != null && desired != null && current !== desired;
  const pinned = current != null && (current >= d.max_replicas || current <= min);
  const target = d.scale_target_ref;
  return (
    <CardGrid label="Autoscaler overview">
      <Card t={t} label="Scaling">
        <div>
          <StatusPill t={t} mode={mode} status={d.scaling.status} />
        </div>
        {(d.scaling.message || d.scaling.reason) && (
          <Caption t={t} title={d.scaling.message ?? undefined}>
            {d.scaling.message ?? d.scaling.reason}
          </Caption>
        )}
      </Card>

      <Card t={t} label="Replicas">
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={BIG} data-testid="hpa-current-replicas">
            {current ?? "—"}
          </span>
          {moving && (
            <span style={{ ...BIG, color: t.accent }} data-testid="hpa-desired-replicas">
              → {desired}
            </span>
          )}
          <span style={{ fontSize: FS_SM, color: t.textMuted }}>of {d.max_replicas}</span>
        </div>
        {d.max_replicas > 0 && (
          <BarGauge
            value={(current ?? 0) / d.max_replicas}
            marker={moving ? (desired ?? 0) / d.max_replicas : undefined}
            markerColor={t.accent}
            color={pinned ? t.warn : t.good}
            track={t.borderSoft}
            width="100%"
            height={6}
          />
        )}
        <Caption t={t}>
          min {min} · max {d.max_replicas}
        </Caption>
      </Card>

      <Card t={t} label="Target">
        {target ? (
          <LinkValue
            t={t}
            onClick={() => onNavigate?.(target.kind, namespace, target.name)}
            copyText={target.name}
            enabled={!!onNavigate}
          >
            <span style={{ fontFamily: FF_MONO, fontSize: FS_MD, wordBreak: "break-all" }}>
              {target.kind}/{target.name}
            </span>
          </LinkValue>
        ) : (
          <Mute t={t}>—</Mute>
        )}
        <Caption t={t} title={d.last_scale_time ?? undefined}>
          {d.last_scale_time ? `scaled ${ageFromIso(d.last_scale_time)} ago` : "never scaled"}
        </Caption>
      </Card>
    </CardGrid>
  );
}

// The bar spans past the target so overshoot stays visible; the tick is the target.
export function HpaMetricCard({ t, metric: m }: { t: Tokens; metric: HpaMetric }) {
  const over = m.ratio != null && m.ratio > 1;
  const scale = Math.max(1.5, (m.ratio ?? 0) * 1.1);
  const value = `${m.current_display ?? "<unknown>"} / ${m.target_display}`;
  return (
    <Card t={t} label={m.type}>
      <span
        title={m.name}
        style={{
          fontFamily: FF_MONO,
          fontSize: FS_MD,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {m.name}
      </span>
      <Copyable text={value}>
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
          <span
            data-testid="hpa-metric-current"
            style={{ ...BIG, color: m.current_display == null ? t.textDim : over ? t.warn : t.text }}
          >
            {m.current_display ?? "<unknown>"}
          </span>
          <span style={{ fontFamily: FF_MONO, fontSize: FS_SM, color: t.textMuted }}>
            / {m.target_display}
          </span>
        </span>
      </Copyable>
      {m.ratio != null ? (
        <>
          <span
            role="meter"
            aria-label={`${m.name} vs target`}
            aria-valuenow={Math.round(m.ratio * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <BarGauge
              value={m.ratio / scale}
              marker={1 / scale}
              markerColor={t.text}
              color={over ? t.warn : t.accent}
              track={t.borderSoft}
              width="100%"
              height={6}
            />
          </span>
          <span style={{ fontSize: FS_XS, color: t.textMuted }}>
            {Math.round(m.ratio * 100)}% of target
          </span>
        </>
      ) : (
        <span style={{ fontSize: FS_XS, color: t.textMuted }}>
          {m.current_display == null ? "no reading from metrics API" : "—"}
        </span>
      )}
    </Card>
  );
}

export function HorizontalPodAutoscalerSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = useResolvedTheme().tokens;
  const [refetch, setRefetch] = useState(0);
  const ns = props.namespace;
  const state = useDetail<HorizontalPodAutoscalerDetail>(
    () => api.getHorizontalPodAutoscalerDetail(props.clusterId, ns ?? "", props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns) return <ErrorBlock t={t} message="HorizontalPodAutoscaler requires a namespace." />;
  if (state.kind === "loading")
    return (
      <div style={{ padding: DETAIL_LAYOUT.padding, background: t.bg }}>
        <LoadingLine t={t} label="Loading hpa…" />
      </div>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="hpa" />;

  const d = state.detail;
  const target = { clusterId: props.clusterId, kindId: KIND_ID, namespace: ns, name: props.name };
  return (
    <EditSessionProvider target={target} onSaved={() => setRefetch((r) => r + 1)}>
      <div
        style={{
          height: "100%",
          overflow: "auto",
          padding: DETAIL_LAYOUT.padding,
          background: t.bg,
          color: t.text,
        }}
      >
        <HpaOverview
          t={t}
          mode={props.mode}
          detail={d}
          namespace={ns}
          onNavigate={props.onNavigate}
        />

        <Section
          t={t}
          title="Metrics"
          right={d.metrics.length > 0 ? `live · ${d.metrics.length}` : undefined}
        />
        {d.metrics.length > 0 ? (
          <CardGrid label="Metrics">
            {d.metrics.map((m, i) => (
              <HpaMetricCard key={`${m.type}:${m.name}:${i}`} t={t} metric={m} />
            ))}
          </CardGrid>
        ) : (
          <div style={{ marginBottom: DETAIL_LAYOUT.sectionGap }}>
            <Mute t={t}>No metrics — the controller defaults to 80% CPU.</Mute>
          </div>
        )}

        {d.conditions.length > 0 && (
          <>
            <Section t={t} title="Conditions" />
            <div style={{ marginBottom: DETAIL_LAYOUT.sectionGap }}>
              {d.conditions.map((c) => (
                <DetailRow key={c.type} t={t} label={c.type}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <ConditionChip
                      t={t}
                      cond={c}
                      invert={INVERTED_CONDITIONS.has(c.type)}
                    />
                    {c.reason && (
                      <Copyable text={c.reason}>
                        <span style={{ fontFamily: FF_MONO, fontSize: FS_MD }}>{c.reason}</span>
                      </Copyable>
                    )}
                    {c.last_transition_time && (
                      <Mute t={t}>{ageFromIso(c.last_transition_time)} ago</Mute>
                    )}
                  </span>
                  {c.message && (
                    <div style={{ fontSize: FS_SM, color: t.textMuted, marginTop: 2, width: "100%" }}>
                      {c.message}
                    </div>
                  )}
                </DetailRow>
              ))}
            </div>
          </>
        )}

        <MetaSection t={t} meta={d.meta} onNavigate={props.onNavigate} editTarget={target} />
        <GlobalSaveBar t={t} />
      </div>
    </EditSessionProvider>
  );
}
