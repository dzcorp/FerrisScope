// Detail summary for CustomResourceDefinition — the only kind in the
// "Custom Resources" category today. Stage 2 of the CRD work will add a
// second view here that lists the actual custom resources of a CRD using
// the dynamic API; until that lands, operators can already drill into a
// CRD's own manifest via the YAML tab and edit it the same way as any
// other kind.

import { useEffect, useRef, useState } from "react";
import { useResolvedTheme } from "../../../store";
import { api } from "../../../api";
import { FF_MONO, type ThemeMode, type Tokens, FS_MD, FS_SM, FS_XS } from "../../../theme";
import {  } from "../../../theme";
import { Chip, ErrorBlock, LoadingLine, Section, StatusPill } from "../../ui";
import {
  ChipWrap,
  Copyable,
  DetailRow,
  Mute,
  ageFromIso,
  type DetailNavigate,
} from "..";
import { MetaSection } from "../workload/shared";
import type { CustomResourceDefinitionDetail } from "../../../types";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; detail: CustomResourceDefinitionDetail }
  | { kind: "error"; message: string };

function Frame({ t, children }: { t: Tokens; children: React.ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        overflow: "auto",
        padding: "18px 22px 22px",
        background: t.bg,
        color: t.text,
      }}
    >
      {children}
    </div>
  );
}

export function CustomResourceDefinitionSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = useResolvedTheme().tokens;
  const [refetch, setRefetch] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    api
      .getCustomResourceDefinitionDetail(props.clusterId, props.name)
      .then((detail) => {
        if (reqId.current === id) setState({ kind: "ready", detail });
      })
      .catch((e: unknown) => {
        if (reqId.current === id)
          setState({ kind: "error", message: String(e) });
      });
  }, [props.clusterId, props.name, props.detailVersion, refetch]);

  if (state.kind === "loading") {
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading CRD…"/>
      </Frame>
    );
  }
  if (state.kind === "error") {
    return (
      <ErrorBlock
        t={t}
        message={state.message}
        kindLabel="custom resource definition"
      />
    );
  }

  const d = state.detail;
  const storageVersion = d.versions.find((v) => v.storage)?.name ?? null;

  return (
    <Frame t={t}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 10,
          marginBottom: 18,
        }}
      >
        <span
          style={{
            fontFamily: FF_MONO,
            fontSize: FS_MD,
            fontWeight: 600,
            color: t.text,
            wordBreak: "break-all",
          }}
        >
          {d.names.kind}
        </span>
        <StatusPill status={d.scope} t={t} mode={props.mode} dense />
        {d.meta.created_at && (
          <span style={{ fontSize: FS_SM, color: t.textMuted }}>
            {ageFromIso(d.meta.created_at)} old
          </span>
        )}
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "customresourcedefinitions",
          namespace: null,
          name: props.name,
        }}
        onSaved={() => setRefetch((n) => n + 1)}
      />

      <Section t={t} title="Spec" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Group">
          <Copyable text={d.group}>
            <span style={{ fontFamily: FF_MONO, fontSize: FS_MD }}>
              {d.group}
            </span>
          </Copyable>
        </DetailRow>
        <DetailRow t={t} label="Kind">
          <Copyable text={d.names.kind}>
            <span style={{ fontFamily: FF_MONO, fontSize: FS_MD }}>
              {d.names.kind}
            </span>
          </Copyable>
        </DetailRow>
        <DetailRow t={t} label="Plural">
          <Copyable text={d.names.plural}>
            <span style={{ fontFamily: FF_MONO, fontSize: FS_MD }}>
              {d.names.plural}
            </span>
          </Copyable>
        </DetailRow>
        {d.names.singular && (
          <DetailRow t={t} label="Singular">
            <Copyable text={d.names.singular}>
              <span style={{ fontFamily: FF_MONO, fontSize: FS_MD }}>
                {d.names.singular}
              </span>
            </Copyable>
          </DetailRow>
        )}
        <DetailRow t={t} label="Scope">
          <span style={{ fontSize: FS_MD }}>{d.scope}</span>
        </DetailRow>
        {d.names.short_names.length > 0 && (
          <DetailRow t={t} label="Short Names">
            <ChipWrap>
              {d.names.short_names.map((s) => (
                <Copyable key={s} text={s}>
                  <Chip t={t} mono>
                    {s}
                  </Chip>
                </Copyable>
              ))}
            </ChipWrap>
          </DetailRow>
        )}
        {d.names.categories.length > 0 && (
          <DetailRow t={t} label="Categories">
            <ChipWrap>
              {d.names.categories.map((c) => (
                <Copyable key={c} text={c}>
                  <Chip t={t} mono>
                    {c}
                  </Chip>
                </Copyable>
              ))}
            </ChipWrap>
          </DetailRow>
        )}
        {d.conversion_strategy && (
          <DetailRow t={t} label="Conversion">
            <span style={{ fontSize: FS_MD }}>{d.conversion_strategy}</span>
          </DetailRow>
        )}
      </div>

      <Section
        t={t}
        title="Versions"
        right={
          storageVersion ? (
            <span
              style={{
                fontSize: FS_XS,
                fontFamily: FF_MONO,
                color: t.textMuted,
              }}
            >
              storage: {storageVersion}
            </span>
          ) : null
        }
      />
      <div style={{ marginBottom: 22 }}>
        {d.versions.map((v) => (
          <DetailRow t={t} key={v.name} label={v.name}>
            <ChipWrap>
              {v.served && (
                <Chip t={t} mono>
                  served
                </Chip>
              )}
              {v.storage && (
                <Chip t={t} mono tone="accent">
                  storage
                </Chip>
              )}
              {v.deprecated && (
                <span
                  style={{
                    fontSize: FS_SM,
                    color: t.warn,
                    fontFamily: FF_MONO,
                  }}
                >
                  deprecated
                </span>
              )}
              {v.printer_columns.length > 0 && (
                <span
                  style={{
                    fontSize: FS_SM,
                    color: t.textMuted,
                    fontFamily: FF_MONO,
                  }}
                >
                  {v.printer_columns.length} printer column
                  {v.printer_columns.length === 1 ? "" : "s"}
                </span>
              )}
            </ChipWrap>
            {v.deprecation_warning && (
              <div
                style={{
                  marginTop: 4,
                  fontSize: FS_SM,
                  color: t.warn,
                  fontFamily: FF_MONO,
                }}
              >
                {v.deprecation_warning}
              </div>
            )}
          </DetailRow>
        ))}
        {d.versions.length === 0 && <Mute t={t}>—</Mute>}
      </div>
    </Frame>
  );
}
