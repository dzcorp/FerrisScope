import { DETAIL_LAYOUT, FS_SM, type ThemeMode, type Tokens } from "../../../theme";
import type { FluxExtras } from "../../../types";
import { Section, StatusPill } from "../../ui";
import { Copyable, ExpandableList, Mono, Mute, ageFromIso } from "..";
import { Cell, DataRow, DataTable } from "./table";

const COLS = "56px minmax(0, 0.9fr) minmax(0, 1.3fr) minmax(0, 0.8fr) minmax(0, 0.8fr)";

export function FluxHistory({ t, mode, flux }: { t: Tokens; mode: ThemeMode; flux: FluxExtras }) {
  if (flux.history.length === 0) return null;
  return (
    <section aria-label="Release history" style={{ marginBottom: DETAIL_LAYOUT.sectionGap }}>
      <Section
        t={t}
        title="Release history"
        right={
          <Mute t={t}>
            {flux.history.length}
            {flux.failures ? ` · ${flux.failures} failures` : ""}
          </Mute>
        }
      />
      <DataTable t={t} label="Release history" columns={COLS} header={["Rev", "Status", "Chart", "App", "Deployed"]}>
        <ExpandableList
          t={t}
          items={flux.history}
          render={(items) =>
            items.map((h, i) => (
              <DataRow key={h.version ?? i} t={t} columns={COLS} highlight={i === 0}>
                <Cell><Mono size={FS_SM}>{h.version ?? "—"}</Mono></Cell>
                <Cell>{h.status ? <StatusPill t={t} mode={mode} status={h.status} dense /> : "—"}</Cell>
                <Cell title={h.digest ?? undefined}>
                  <Copyable text={`${h.chart ?? ""}@${h.chart_version ?? ""}`}>
                    <Mono size={FS_SM}>{h.chart ?? "—"}{h.chart_version ? `@${h.chart_version}` : ""}</Mono>
                  </Copyable>
                </Cell>
                <Cell><span style={{ color: t.textMuted }}>{h.app_version ?? "—"}</span></Cell>
                <Cell
                  title={[
                    h.first_deployed && `First deployed ${h.first_deployed}`,
                    h.deployed_at && `Last deployed ${h.deployed_at}`,
                    h.config_digest && `Config ${h.config_digest}`,
                  ]
                    .filter(Boolean)
                    .join("\n") || undefined}
                >
                  <span style={{ color: t.textMuted }}>
                    {h.deployed_at ? `${ageFromIso(h.deployed_at)} ago` : "—"}
                    {h.action ? ` · ${h.action}` : ""}
                  </span>
                </Cell>
              </DataRow>
            ))
          }
        />
      </DataTable>
    </section>
  );
}
