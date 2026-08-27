// Bulk actions for a multi-row selection.
//
// One implementation, two surfaces: the floating BulkBar and — when the
// operator right-clicks inside a selection — the row context menu. Keeping
// them on the same builders is the point; a second set of "bulk" semantics
// that drifts from the first is how an operator ends up deleting rows they
// thought they were only suspending.
//
// Every action routes through each entry's own cluster: a virtual-context
// selection can span several.

import { api } from "../api";
import { confirm, toast } from "../lib/dialog";
import { bulkClusterPrefix } from "../lib/multiCluster";
import type { SelectionMeta } from "../store";
import type { ResourceKind } from "../types";
import type { BulkAction } from "./BulkBar";
import { Icons } from "./ui";

// Pod-specific bulk actions. Logs / Edit YAML are intentionally absent until
// we ship a multi-stream log view and an apply API — bulk actions need to be
// reliable, idempotent, and obvious. Every action routes through each
// entry's own cluster — a virtual-context selection can span several.
export function buildPodBulkActions(
  selection: Map<string, SelectionMeta>,
  confirmDestructive: boolean,
  clearSelection: () => void,
  labelFor: (clusterId: string) => string,
  degraded: boolean,
) {
  const entries = Array.from(selection.entries());
  const count = entries.length;
  const prefix = bulkClusterPrefix(entries, labelFor);
  const summary = entries
    .slice(0, 5)
    .map(
      ([, m]) =>
        `${prefix(m)}${m.namespace ? `${m.namespace}/${m.name}` : m.name}`,
    )
    .join("\n");
  const more = count > 5 ? `\n…and ${count - 5} more` : "";

  const runForAll = async (
    label: string,
    op: (m: SelectionMeta) => Promise<unknown>,
  ) => {
    const failures: string[] = [];
    await Promise.all(
      entries.map(async ([, m]) => {
        try {
          await op(m);
        } catch (e) {
          failures.push(
            `${prefix(m)}${m.namespace ? `${m.namespace}/` : ""}${m.name}: ${String(e)}`,
          );
        }
      }),
    );
    if (failures.length > 0) {
      toast.bad(
        `${label} failed for ${failures.length} of ${count}:\n${failures
          .slice(0, 8)
          .join(
            "\n",
          )}${failures.length > 8 ? `\n…and ${failures.length - 8} more` : ""}`,
      );
    } else {
      toast.ok(`${label}: ${count} pod${count === 1 ? "" : "s"}.`);
    }
    clearSelection();
  };

  return [
    {
      icon: Icons.refresh,
      label: "Restart",
      disabled: degraded,
      onClick: () => {
        void (async () => {
          if (confirmDestructive) {
            const ok = await confirm({
              title: `Rollout-restart owners of ${count} pod${count === 1 ? "" : "s"}?`,
              body: `This restarts the entire workload — every pod owned by each Deployment / StatefulSet / DaemonSet is recreated, not just the ones you selected. Pods owned by the same workload are restarted together (one rollout per workload).\n\nSelected pods:\n${summary}${more}`,
              confirmLabel: "Restart",
              tone: "danger",
            });
            if (!ok) return;
          }
          // One restart_pods call per origin cluster — the backend resolves
          // pod → owning workload within a single cluster.
          const byCluster = new Map<string, [string, string][]>();
          let noNs = 0;
          for (const [, m] of entries) {
            if (m.namespace == null) {
              noNs += 1;
              continue;
            }
            const bucket = byCluster.get(m.clusterId);
            const pair: [string, string] = [m.namespace, m.name];
            if (bucket) bucket.push(pair);
            else byCluster.set(m.clusterId, [pair]);
          }
          const multi = byCluster.size > 1;
          const cidPrefix = (cid: string) =>
            multi ? `[${labelFor(cid)}] ` : "";
          const patchedLines: string[] = [];
          const failureLines: string[] =
            noNs > 0 ? [`${noNs} selected pod(s) had no namespace`] : [];
          let patchedCount = 0;
          await Promise.all(
            Array.from(byCluster.entries()).map(async ([cid, pairs]) => {
              try {
                const report = await api.restartPods(cid, pairs);
                patchedCount += report.patched.length;
                for (const w of report.patched) {
                  patchedLines.push(
                    `${cidPrefix(cid)}${w.kind} ${w.namespace}/${w.name} (${w.pods.length} pod${w.pods.length === 1 ? "" : "s"})`,
                  );
                }
                for (const f of report.failures) {
                  failureLines.push(
                    `${cidPrefix(cid)}${f.namespace}/${f.pod}: ${f.error}`,
                  );
                }
              } catch (e) {
                failureLines.push(
                  `${cidPrefix(cid)}restart failed: ${String(e)}`,
                );
              }
            }),
          );
          const patchedSummary = patchedLines.join("\n");
          if (failureLines.length > 0) {
            toast.bad(
              `Restarted ${patchedCount} workload(s)${patchedSummary ? `:\n${patchedSummary}` : ""}\n\nFailures (${failureLines.length}):\n${failureLines.slice(0, 8).join("\n")}${failureLines.length > 8 ? `\n…and ${failureLines.length - 8} more` : ""}`,
            );
          } else {
            toast.ok(
              `Restarted ${patchedCount} workload${patchedCount === 1 ? "" : "s"}${patchedSummary ? `:\n${patchedSummary}` : ""}`,
            );
          }
          clearSelection();
        })();
      },
    },
    {
      icon: Icons.copy,
      label: "Copy names",
      onClick: () => {
        const text = entries
          .map(([, m]) => (m.namespace ? `${m.namespace}/${m.name}` : m.name))
          .join("\n");
        navigator.clipboard
          .writeText(text)
          .then(() =>
            toast.ok(`Copied ${count} pod name${count === 1 ? "" : "s"}.`),
          )
          .catch(() => toast.bad("Couldn't copy to clipboard"));
      },
    },
    {
      // Graceful, PDB-aware bulk eviction. Sits ahead of Delete (raw DELETE)
      // so the budget-respecting path is the first destructive option, and
      // carries the divider that opens the destructive group.
      icon: Icons.podDrain,
      label: "Evict",
      disabled: degraded,
      separatorBefore: true,
      danger: true,
      onClick: () => {
        void (async () => {
          if (confirmDestructive) {
            const ok = await confirm({
              title: `Evict ${count} pod${count === 1 ? "" : "s"}?`,
              body: `Graceful, PDB-aware eviction. A pod protected by a PodDisruptionBudget is refused (reported in the summary), not force-killed. Controller-owned pods reschedule; bare pods are gone.\n\n${summary}${more}`,
              confirmLabel: "Evict",
              tone: "danger",
            });
            if (!ok) return;
          }
          await runForAll("Evict", (m) => {
            // Pods are namespaced; guard anyway so a malformed selection lands
            // in the failure summary instead of a bad backend call.
            if (!m.namespace)
              return Promise.reject(new Error("pod has no namespace"));
            return api.evictPod(m.clusterId, m.namespace, m.name);
          });
        })();
      },
    },
    {
      icon: Icons.trash,
      label: "Delete",
      disabled: degraded,
      danger: true,
      onClick: () => {
        void (async () => {
          if (confirmDestructive) {
            const ok = await confirm({
              title: `Delete ${count} pod${count === 1 ? "" : "s"}?`,
              body: `${summary}${more}`,
              confirmLabel: "Delete",
              tone: "danger",
            });
            if (!ok) return;
          }
          await runForAll("Delete", (m) =>
            api.deleteResource(m.clusterId, "pods", m.namespace, m.name, null),
          );
        })();
      },
    },
  ];
}

// Node-specific bulk actions. Cordon / Uncordon are split because a mixed
// selection (some cordoned, some not) needs both intents to be expressible
// without forcing the operator to deselect first. Drain and Delete confirm
// unconditionally — they have real-world consequences a `confirmDestructive`
// toggle shouldn't be able to silence.
export function buildNodeBulkActions(
  selection: Map<string, SelectionMeta>,
  clearSelection: () => void,
  labelFor: (clusterId: string) => string,
  degraded: boolean,
) {
  const entries = Array.from(selection.entries());
  const count = entries.length;
  const prefix = bulkClusterPrefix(entries, labelFor);
  const summary = entries
    .slice(0, 5)
    .map(([, m]) => `${prefix(m)}${m.name}`)
    .join("\n");
  const more = count > 5 ? `\n…and ${count - 5} more` : "";

  const runForAll = async (
    label: string,
    op: (m: SelectionMeta) => Promise<unknown>,
  ) => {
    const failures: string[] = [];
    await Promise.all(
      entries.map(async ([, m]) => {
        try {
          await op(m);
        } catch (e) {
          failures.push(`${prefix(m)}${m.name}: ${String(e)}`);
        }
      }),
    );
    if (failures.length > 0) {
      toast.bad(
        `${label} failed for ${failures.length} of ${count}:\n${failures
          .slice(0, 8)
          .join(
            "\n",
          )}${failures.length > 8 ? `\n…and ${failures.length - 8} more` : ""}`,
      );
    } else {
      toast.ok(`${label}: ${count} node${count === 1 ? "" : "s"}.`);
    }
    clearSelection();
  };

  const drainAll = async () => {
    const reports: { node: string; ev: number; sk: number; fl: number }[] = [];
    const failures: string[] = [];
    await Promise.all(
      entries.map(async ([, m]) => {
        try {
          const r = await api.drainNode(m.clusterId, m.name, false);
          reports.push({
            node: `${prefix(m)}${m.name}`,
            ev: r.evicted.length,
            sk: r.skipped.length,
            fl: r.failures.length,
          });
        } catch (e) {
          failures.push(`${prefix(m)}${m.name}: ${String(e)}`);
        }
      }),
    );
    const lines = reports
      .map((r) => `${r.node}: ${r.ev} evicted, ${r.sk} skipped, ${r.fl} failed`)
      .join("\n");
    if (failures.length > 0 || reports.some((r) => r.fl > 0)) {
      toast.bad(
        `Drain results:\n${lines}${failures.length > 0 ? `\n\nDrain call failed:\n${failures.join("\n")}` : ""}`,
      );
    } else {
      toast.ok(`Drained ${count} node${count === 1 ? "" : "s"}:\n${lines}`);
    }
    clearSelection();
  };

  return [
    {
      icon: Icons.eye,
      label: "Cordon",
      disabled: degraded,
      onClick: () => {
        void (async () => {
          const ok = await confirm({
            title: `Cordon ${count} node${count === 1 ? "" : "s"}?`,
            body: `New pods won't schedule on:\n${summary}${more}`,
            confirmLabel: "Cordon",
          });
          if (!ok) return;
          await runForAll("Cordon", (m) =>
            api.cordonNode(m.clusterId, m.name, true),
          );
        })();
      },
    },
    {
      icon: Icons.check,
      label: "Uncordon",
      disabled: degraded,
      onClick: () => {
        void runForAll("Uncordon", (m) =>
          api.cordonNode(m.clusterId, m.name, false),
        );
      },
    },
    {
      icon: Icons.refresh,
      label: "Drain",
      disabled: degraded,
      onClick: () => {
        void (async () => {
          const ok = await confirm({
            title: `Drain ${count} node${count === 1 ? "" : "s"}?`,
            body: `Cordons each node and evicts every pod on it. DaemonSet-managed and mirror pods are skipped. PDB-protected pods may block; failures are reported per pod.\n\nNodes:\n${summary}${more}`,
            confirmLabel: "Drain",
            tone: "danger",
          });
          if (!ok) return;
          await drainAll();
        })();
      },
    },
    {
      icon: Icons.copy,
      label: "Copy names",
      onClick: () => {
        const text = entries.map(([, m]) => m.name).join("\n");
        navigator.clipboard
          .writeText(text)
          .then(() =>
            toast.ok(`Copied ${count} node name${count === 1 ? "" : "s"}.`),
          )
          .catch(() => toast.bad("Couldn't copy to clipboard"));
      },
    },
    {
      icon: Icons.trash,
      label: "Delete",
      disabled: degraded,
      separatorBefore: true,
      danger: true,
      onClick: () => {
        void (async () => {
          const ok = await confirm({
            title: `Delete ${count} node${count === 1 ? "" : "s"}?`,
            body: `Removes the node from the cluster. The underlying machine isn't stopped. Pods on the node will be rescheduled by their controllers (orphaned bare pods become Lost).\n\n${summary}${more}`,
            confirmLabel: "Delete",
            tone: "danger",
          });
          if (!ok) return;
          await runForAll("Delete", (m) =>
            api.deleteResource(m.clusterId, "nodes", null, m.name, null),
          );
        })();
      },
    },
  ];
}

// Generic bulk actions for any kind that isn't pods or nodes. Copy + Delete
// ride the dynamic API; Restart is added for the workload kinds that support
// `kubectl rollout restart` (Deployment / StatefulSet / DaemonSet) and goes
// through the JSON merge-patch path (`api.restartWorkload`), not SSA — see
// `runRestartWorkload` in DetailPanel for the rationale.
const BULK_RESTARTABLE_KINDS = new Set([
  "deployments",
  "statefulsets",
  "daemonsets",
]);

/// Apply `op` to every selected row, collect per-row failures, and report
/// once. A bulk action must never fail silently on a subset — the operator
/// cleared the selection expecting all of it to have happened.
async function bulkRunForEach(
  entries: [string, SelectionMeta][],
  prefix: (m: SelectionMeta) => string,
  op: (m: SelectionMeta) => Promise<unknown>,
  report: { verb: string; noun: string; nounPlural: string },
): Promise<void> {
  const count = entries.length;
  const failures: string[] = [];
  await Promise.all(
    entries.map(async ([, m]) => {
      try {
        await op(m);
      } catch (e) {
        failures.push(
          `${prefix(m)}${m.namespace ? `${m.namespace}/` : ""}${m.name}: ${String(e)}`,
        );
      }
    }),
  );
  if (failures.length > 0) {
    toast.bad(
      `${report.verb} failed for ${failures.length} of ${count}:\n${failures
        .slice(0, 8)
        .join(
          "\n",
        )}${failures.length > 8 ? `\n…and ${failures.length - 8} more` : ""}`,
    );
  } else {
    toast.ok(
      `${report.verb}: ${count} ${count === 1 ? report.noun : report.nounPlural}.`,
    );
  }
}

// Exported for tests: the bulk bar is where a mis-picked transport or a
// silently-swallowed per-row failure does the most damage.
export function buildGenericBulkActions(
  kind: ResourceKind,
  selection: Map<string, SelectionMeta>,
  confirmDestructive: boolean,
  clearSelection: () => void,
  labelFor: (clusterId: string) => string,
  degraded: boolean,
) {
  const entries = Array.from(selection.entries());
  const count = entries.length;
  const prefix = bulkClusterPrefix(entries, labelFor);
  const kindLabel = kind.kind.toLowerCase();
  const plural = kind.plural.toLowerCase();
  const summary = entries
    .slice(0, 5)
    .map(
      ([, m]) =>
        `${prefix(m)}${m.namespace ? `${m.namespace}/${m.name}` : m.name}`,
    )
    .join("\n");
  const more = count > 5 ? `\n…and ${count - 5} more` : "";

  const actions: BulkAction[] = [];

  // Batch workloads.
  if (kind.id === "cronjobs" || kind.id === "jobs") {
    const isCronJob = kind.id === "cronjobs";
    const nouns = { noun: kindLabel, nounPlural: plural };

    const confirmThen = async (
      subset: [string, SelectionMeta][],
      title: string,
      body: string,
      confirmLabel: string,
      tone: "neutral" | "danger",
      verb: string,
      op: (m: SelectionMeta) => Promise<unknown>,
    ) => {
      if (confirmDestructive) {
        const skipped = count - subset.length;
        const ok = await confirm({
          title,
          body: `${body}${
            skipped > 0
              ? `\n\n${skipped} of the ${count} selected will be skipped — the verb can't affect them.`
              : ""
          }\n\n${summary}${more}`,
          confirmLabel,
          tone,
        });
        if (!ok) return;
      }
      await bulkRunForEach(subset, prefix, op, { verb, ...nouns });
      clearSelection();
    };

    actions.push({
      icon: isCronJob ? Icons.bolt : Icons.refresh,
      label: isCronJob ? "Run now" : "Re-run",
      disabled: degraded,
      onClick: () => {
        void confirmThen(
          entries,
          isCronJob
            ? `Run ${count} ${count === 1 ? kindLabel : plural} now?`
            : `Run ${count} ${count === 1 ? kindLabel : plural} again?`,
          isCronJob
            ? "Creates one Job per CronJob from its template, owned by it so history limits still apply. Schedules and suspend flags are unchanged."
            : "A Job's spec is immutable, so each is copied under a new name. The originals are left in place.",
          isCronJob ? "Run now" : "Re-run",
          "neutral",
          isCronJob ? "Triggered" : "Re-ran",
          async (m) => {
            if (!m.namespace) throw new Error("no namespace");
            return isCronJob
              ? api.triggerCronJob(m.clusterId, m.namespace, m.name)
              : api.rerunJob(m.clusterId, m.namespace, m.name);
          },
        );
      },
    });

    // A finished Job can't be suspended or resumed — the apiserver accepts the
    // patch and the controller ignores it. CronJobs have no terminal state, so
    // this only narrows Jobs.
    const settleable = isCronJob
      ? entries
      : entries.filter(
          ([, m]) => m.phase !== "Succeeded" && m.phase !== "Failed",
        );

    // Only offer the direction that would change something. A row whose
    // suspend state we never captured lands in both lists: the patch is an
    // explicit request either way, and guessing a default is what puts the
    // wrong verb in front of the operator.
    const directions: { suspend: boolean; rows: [string, SelectionMeta][] }[] = [
      { suspend: true, rows: settleable.filter(([, m]) => m.suspend !== true) },
      { suspend: false, rows: settleable.filter(([, m]) => m.suspend !== false) },
    ];

    for (const { suspend, rows } of directions) {
      if (rows.length === 0) continue;
      const verb = suspend ? "Suspend" : "Resume";
      // Name the subset when it isn't the whole selection, so the button never
      // implies it covers rows it will skip.
      const label = rows.length === count ? verb : `${verb} (${rows.length})`;
      actions.push({
        icon: suspend ? Icons.pause : Icons.play,
        label,
        disabled: degraded,
        onClick: () => {
          void confirmThen(
            rows,
            `${verb} ${rows.length} ${rows.length === 1 ? kindLabel : plural}?`,
            suspend
              ? isCronJob
                ? "No new Jobs will be created. Runs already in flight keep going, and missed schedules are not backfilled on resume."
                : "The Job controller deletes each Job's running pods; their work is lost unless it is idempotent. On resume the Job starts fresh pods and its activeDeadlineSeconds timer restarts."
              : isCronJob
                ? "Scheduling resumes from the next matching time. Missed runs are not backfilled."
                : "Each Job creates fresh pods and continues toward its completion count. Its activeDeadlineSeconds timer restarts.",
            verb,
            suspend ? "danger" : "neutral",
            suspend ? "Suspended" : "Resumed",
            async (m) => {
              if (!m.namespace) throw new Error("no namespace");
              // Merge patch, not SSA — a partial SSA apply drops every other
              // spec field this app's field manager owns. See the note on the
              // single-object path in DetailPanel.
              return api.mergePatchResource(
                m.clusterId,
                kind.id,
                m.namespace,
                m.name,
                { spec: { suspend } },
                null,
              );
            },
          );
        },
      });
    }
  }

  if (BULK_RESTARTABLE_KINDS.has(kind.id)) {
    actions.push({
      icon: Icons.refresh,
      label: "Restart",
      disabled: degraded,
      onClick: () => {
        void (async () => {
          if (confirmDestructive) {
            const ok = await confirm({
              title: `Rollout-restart ${count} ${count === 1 ? kindLabel : plural}?`,
              body: `Patches each workload's pod-template annotation. Every pod owned by each is recreated; rollout respects maxSurge / maxUnavailable / PDBs.\n\n${summary}${more}`,
              confirmLabel: "Restart",
              tone: "danger",
            });
            if (!ok) return;
          }
          const failures: string[] = [];
          let noNs = 0;
          await Promise.all(
            entries.map(async ([, m]) => {
              if (!m.namespace) {
                noNs += 1;
                return;
              }
              try {
                await api.restartWorkload(
                  m.clusterId,
                  kind.kind,
                  m.namespace,
                  m.name,
                );
              } catch (e) {
                failures.push(
                  `${prefix(m)}${m.namespace}/${m.name}: ${String(e)}`,
                );
              }
            }),
          );
          const lines = [
            ...(noNs > 0
              ? [
                  `${noNs} selected ${noNs === 1 ? kindLabel : plural} had no namespace`,
                ]
              : []),
            ...failures,
          ];
          if (lines.length > 0) {
            toast.bad(
              `Restart failed for ${lines.length} of ${count}:\n${lines.slice(0, 8).join("\n")}${lines.length > 8 ? `\n…and ${lines.length - 8} more` : ""}`,
            );
          } else {
            toast.ok(
              `Rollout restart triggered on ${count} ${count === 1 ? kindLabel : plural}.`,
            );
          }
          clearSelection();
        })();
      },
    });
  }

  actions.push(
    {
      icon: Icons.copy,
      label: "Copy names",
      onClick: () => {
        const text = entries
          .map(([, m]) => (m.namespace ? `${m.namespace}/${m.name}` : m.name))
          .join("\n");
        navigator.clipboard
          .writeText(text)
          .then(() =>
            toast.ok(
              `Copied ${count} ${count === 1 ? kindLabel : plural} name${count === 1 ? "" : "s"}.`,
            ),
          )
          .catch(() => toast.bad("Couldn't copy to clipboard"));
      },
    },
    {
      icon: Icons.trash,
      label: "Delete",
      disabled: degraded,
      separatorBefore: true,
      danger: true,
      onClick: () => {
        void (async () => {
          if (confirmDestructive) {
            const ok = await confirm({
              title: `Delete ${count} ${count === 1 ? kindLabel : plural}?`,
              body: `${summary}${more}`,
              confirmLabel: "Delete",
              tone: "danger",
            });
            if (!ok) return;
          }
          const failures: string[] = [];
          await Promise.all(
            entries.map(async ([, m]) => {
              try {
                await api.deleteResource(
                  m.clusterId,
                  kind.id,
                  m.namespace,
                  m.name,
                  null,
                );
              } catch (e) {
                failures.push(
                  `${prefix(m)}${m.namespace ? `${m.namespace}/` : ""}${m.name}: ${String(e)}`,
                );
              }
            }),
          );
          if (failures.length > 0) {
            toast.bad(
              `Delete failed for ${failures.length} of ${count}:\n${failures
                .slice(0, 8)
                .join(
                  "\n",
                )}${failures.length > 8 ? `\n…and ${failures.length - 8} more` : ""}`,
            );
          } else {
            toast.ok(`Deleted ${count} ${count === 1 ? kindLabel : plural}.`);
          }
          clearSelection();
        })();
      },
    },
  );

  return actions;
}


/// The bulk action set for `kind`, whatever it is. Single entry point so a
/// new surface never has to re-derive which builder applies.
export function bulkActionsFor(
  kind: ResourceKind,
  selection: Map<string, SelectionMeta>,
  confirmDestructive: boolean,
  clearSelection: () => void,
  labelFor: (clusterId: string) => string,
  degraded: boolean,
): BulkAction[] {
  if (kind.id === "pods") {
    return buildPodBulkActions(
      selection,
      confirmDestructive,
      clearSelection,
      labelFor,
      degraded,
    );
  }
  if (kind.id === "nodes") {
    return buildNodeBulkActions(selection, clearSelection, labelFor, degraded);
  }
  return buildGenericBulkActions(
    kind,
    selection,
    confirmDestructive,
    clearSelection,
    labelFor,
    degraded,
  );
}
