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

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { acceptsPodDelta } from "../../lib/podSelector";
import type { LabelSelectorSummary, ResourceRow } from "../../types";
import type { Json } from "../../lib/yamlEdit";
import type { ThemeMode, Tokens } from "../../theme";
import { PodListSection } from "../detail/podList";
import { DETAIL_POLL_MS } from "../detail/detailPoll";
import type { DetailNavigate } from "../detail";
import { EmptyState } from "../ui";
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
    // Three different causes end up here; say which one it was rather than
    // blaming the selector for a failed fetch.
    const anyReadable = subjects.some(
      (s) => docs.get(s.sid)?.status === "ok",
    );
    const anyNamespaced = subjects.some((s) => s.namespace);
    return (
      <EmptyState
        t={t}
        title="No pods to show"
        hint={
          !anyReadable
            ? "None of the selected manifests could be read."
            : !anyNamespaced
              ? "These objects are cluster-scoped, so they own no pods."
              : "No selected object carries a pod selector we could read."
        }
      />
    );
  }

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {groups.map(([clusterId, usable]) => (
        <ClusterPodList
          key={clusterId}
          t={t}
          mode={mode}
          kindId={kindId}
          clusterId={clusterId}
          usable={usable}
          showClusterName={groups.length > 1}
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
  showClusterName,
  onNavigate,
}: {
  t: Tokens;
  mode: ThemeMode;
  kindId: string;
  clusterId: string;
  usable: Usable[];
  showClusterName: boolean;
  onNavigate?: DetailNavigate;
}) {
  // The true owner mapping comes from the fetch itself — each promise's index
  // says which controller returned that pod. Re-deriving it from selectors
  // would misattribute overlapping selectors (`app=web` vs
  // `app=web,tier=fe`) and return nothing at all for a matchExpressions
  // selector, which can't be evaluated client-side.
  const ownerByUid = useRef(new Map<string, string>());

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
      const owners = new Map<string, string>();
      // Any capped subject caps the union: the merged list is a prefix even if
      // the other subjects returned in full.
      let truncated = false;
      results.forEach((res, i) => {
        if (res.status !== "fulfilled") return;
        const name = usable[i]!.subject.name;
        if (res.value.truncated) truncated = true;
        for (const row of res.value.rows) {
          merged.set(row.uid, row);
          // First writer wins, so a pod claimed by two overlapping selectors
          // is attributed to the earlier subject rather than flip-flopping.
          if (!owners.has(row.uid)) owners.set(row.uid, name);
        }
      });
      ownerByUid.current = owners;
      return { rows: Array.from(merged.values()), truncated };
    },
    [usable, clusterId, kindId],
  );

  const acceptsDelta = useMemo(
    () => (row: ResourceRow, known: ReadonlySet<string>) =>
      usable.some(({ subject, selector }) =>
        acceptsPodDelta(row, subject.namespace, selector, known),
      ),
    [usable],
  );

  // Owner chip. A pod that arrived by delta after the last fetch has no
  // recorded owner yet; fall back to a selector match, which is right whenever
  // the selectors don't overlap.
  const ownerOf = useMemo(
    () =>
      (row: ResourceRow): string | null =>
        ownerByUid.current.get(row.uid) ??
        usable.find(({ subject, selector }) =>
          acceptsPodDelta(row, subject.namespace, selector, new Set()),
        )?.subject.name ??
        null,
    [usable],
  );

  const subjectKey = useMemo(
    () => usable.map(({ subject }) => subject.sid).join("|"),
    [usable],
  );

  // `PodListSection` keeps itself current from the pod delta stream, but a
  // selector it can't evaluate (matchExpressions) refuses unknown pods — so
  // without a periodic authoritative refetch that list would freeze at mount
  // and never show a scale-up. Matches the detail panel's poll interval.
  const [refetchKey, setRefetchKey] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden) return;
      setRefetchKey((n) => n + 1);
    }, DETAIL_POLL_MS);
    return () => clearInterval(id);
  }, []);

  // The union can span namespaces inside one cluster; label the rows when it
  // does, so two same-named controllers aren't an unattributed mixed list.
  const showNamespace =
    new Set(usable.map(({ subject }) => subject.namespace)).size > 1;

  return (
    <div style={{ flex: 1, minHeight: 0 }}>
      <PodListSection
        t={t}
        mode={mode}
        clusterId={clusterId}
        fetchPods={fetchPods}
        acceptsDelta={acceptsDelta}
        subjectKey={subjectKey}
        refetchKey={refetchKey}
        emptyLabel="No pods match these controllers."
        showNode
        showNamespace={showNamespace}
        ownerOf={ownerOf}
        onNavigate={onNavigate}
        variant="pane"
        paneLabel={showClusterName ? usable[0]!.subject.clusterName : undefined}
      />
    </div>
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
