// Union of the pods owned by every selected controller, in one live list.
//
// Selectors come from the manifests the drawer already fetched — `spec.selector`
// is right there — so this needs no per-kind detail dispatch and no second
// round trip.
//
// Grouped per cluster, because `PodListSection` subscribes to ONE cluster's pod
// stream and matches deltas against the selectors it was given. Feeding it a
// cross-cluster mix would match cluster A's pods against cluster B's selectors
// and silently miss deltas for every cluster but one.

import { useMemo } from "react";
import { api } from "../../api";
import { acceptsPodDelta } from "../../lib/podSelector";
import type { LabelSelectorSummary, ResourceRow } from "../../types";
import type { Json } from "../../lib/yamlEdit";
import {
  clusterAccent,
  FF_MONO,
  FS_XS,
  type ThemeMode,
  type Tokens,
} from "../../theme";
import { PodListSection } from "../detail/podList";
import { Mute, type DetailNavigate } from "../detail";
import type { DocState, InspectSubject } from ".";

type Usable = { subject: InspectSubject; selector: LabelSelectorSummary | null };

export function PodsTab({
  t,
  mode,
  kindId,
  subjects,
  docs,
  onNavigate,
}: {
  t: Tokens;
  mode: ThemeMode;
  kindId: string;
  subjects: InspectSubject[];
  docs: Map<string, DocState>;
  onNavigate?: DetailNavigate;
}) {
  // Only namespaced subjects whose manifest arrived can contribute a selector.
  const groups = useMemo(() => {
    const byCluster = new Map<string, Usable[]>();
    for (const s of subjects) {
      const d = docs.get(s.sid);
      if (!s.namespace || d?.status !== "ok") continue;
      const list = byCluster.get(s.clusterId) ?? [];
      list.push({ subject: s, selector: selectorFrom(d.doc) });
      byCluster.set(s.clusterId, list);
    }
    return Array.from(byCluster.entries());
  }, [subjects, docs]);

  if (groups.length === 0) {
    return (
      <div style={{ padding: "18px 22px" }}>
        <Mute t={t}>
          No selected object carries a pod selector we could read.
        </Mute>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "4px 22px 22px" }}>
      {groups.map(([clusterId, usable]) => (
        <ClusterPodList
          key={clusterId}
          t={t}
          mode={mode}
          kindId={kindId}
          clusterId={clusterId}
          usable={usable}
          showClusterHeading={groups.length > 1}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}

function ClusterPodList({
  t,
  mode,
  kindId,
  clusterId,
  usable,
  showClusterHeading,
  onNavigate,
}: {
  t: Tokens;
  mode: ThemeMode;
  kindId: string;
  clusterId: string;
  usable: Usable[];
  showClusterHeading: boolean;
  onNavigate?: DetailNavigate;
}) {
  const fetchPods = useMemo(
    () => async () => {
      const results = await Promise.allSettled(
        usable.map(({ subject }) =>
          api.listPodsForWorkload(
            clusterId,
            kindId,
            subject.namespace!,
            subject.name,
          ),
        ),
      );
      // A controller whose pods fail to list drops out; the others still show.
      // Dedup by uid — two selectors can legitimately match the same pod.
      const merged = new Map<string, ResourceRow>();
      for (const res of results) {
        if (res.status !== "fulfilled") continue;
        for (const row of res.value) merged.set(row.uid, row);
      }
      return Array.from(merged.values());
    },
    [usable, clusterId, kindId],
  );

  const acceptsDelta = useMemo(
    () => (row: ResourceRow, known: ReadonlySet<string>) =>
      usable.some(({ selector }) => acceptsPodDelta(row, selector, known)),
    [usable],
  );

  // Which controller a pod belongs to, for the owner chip. A pod has one
  // controller, so the first matching selector is the right answer even when
  // two selectors overlap.
  const ownerOf = useMemo(
    () =>
      (row: ResourceRow): string | null =>
        usable.find(({ selector }) =>
          acceptsPodDelta(row, selector, new Set()),
        )?.subject.name ?? null,
    [usable],
  );

  const subjectKey = useMemo(
    () => usable.map(({ subject }) => subject.sid).join("|"),
    [usable],
  );

  return (
    <>
      {showClusterHeading && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 14,
            fontFamily: FF_MONO,
            fontSize: FS_XS,
            color: t.textMuted,
            textTransform: "uppercase",
            letterSpacing: 0.6,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: clusterAccent(usable[0]!.subject.colorIdx),
            }}
          />
          {usable[0]!.subject.clusterName}
        </div>
      )}
      <PodListSection
        t={t}
        mode={mode}
        clusterId={clusterId}
        fetchPods={fetchPods}
        acceptsDelta={acceptsDelta}
        subjectKey={subjectKey}
        refetchKey={0}
        emptyLabel="No pods match these controllers."
        showNode
        ownerOf={ownerOf}
        onNavigate={onNavigate}
      />
    </>
  );
}

/// Pull a `LabelSelectorSummary` out of a raw manifest. Shaped to match what
/// `acceptsPodDelta` expects from the typed detail payloads.
export function selectorFrom(doc: Json): LabelSelectorSummary | null {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const spec = doc.spec;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const sel = spec.selector;
  if (!sel || typeof sel !== "object" || Array.isArray(sel)) return null;

  const ml = sel.matchLabels;
  const match_labels: [string, string][] =
    ml && typeof ml === "object" && !Array.isArray(ml)
      ? Object.entries(ml).flatMap(([k, v]) =>
          typeof v === "string" ? [[k, v] as [string, string]] : [],
        )
      : [];
  const me = sel.matchExpressions;
  const match_expressions = Array.isArray(me) ? me.length : 0;
  if (match_labels.length === 0 && match_expressions === 0) return null;
  return { match_labels, match_expressions };
}
