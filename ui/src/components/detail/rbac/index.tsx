// Per-kind detail summaries for the RBAC family — ServiceAccount, Role,
// ClusterRole, RoleBinding, ClusterRoleBinding. Same pattern as the storage +
// network families: fetch via `useDetail`, compose primitives, MetaSection
// carries the editTarget so labels + annotations are inline-editable.
//
// The Role/ClusterRole rules table and the RoleBinding/ClusterRoleBinding
// subjects table are factored out as reusable components so the cluster-scoped
// and namespace-scoped variants share their renderer (the only difference is
// `meta.namespace`).

import { useEffect, useRef, useState } from "react";
import { useResolvedTheme } from "../../../store";
import { api } from "../../../api";
import { FF_MONO, type ThemeMode, type Tokens, R_LG, R_SM, FS_MD, FS_SM, FS_XS } from "../../../theme";
import {  } from "../../../theme";
import { Chip, ErrorBlock, LoadingLine, Section } from "../../ui";
import {
  ChipWrap,
  Copyable,
  DetailRow,
  KeyValueChips,
  LinkValue,
  Mute,
  ageFromIso,
  type DetailNavigate,
} from "..";
import { MetaSection } from "../workload/shared";
import type {
  ClusterRoleBindingDetail,
  ClusterRoleDetail,
  PolicyRule,
  RoleBindingDetail,
  RoleBindingSubject,
  RoleDetail,
  RoleRefSummary,
  ServiceAccountDetail,
} from "../../../types";

type LoadState<T> =
  | { kind: "loading" }
  | { kind: "ready"; detail: T }
  | { kind: "error"; message: string };

function useDetail<T>(
  fetcher: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ kind: "loading" });
  const reqId = useRef(0);
  useEffect(() => {
    const id = ++reqId.current;
    // No `setState({ loading })` on refetch — keep the previous detail on
    // screen until the new fetch resolves so the panel doesn't collapse and
    // snap the scroll container back to the top after every action.
    fetcher()
      .then((detail) => {
        if (reqId.current === id) setState({ kind: "ready", detail });
      })
      .catch((e: unknown) => {
        if (reqId.current === id)
          setState({ kind: "error", message: String(e) });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

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

function StringChips({ t, items }: { t: Tokens; items: string[] }) {
  if (items.length === 0) return <Mute t={t}>—</Mute>;
  return (
    <ChipWrap>
      {items.map((m) => (
        <Copyable key={m} text={m}>
          <Chip t={t} mono>
            {m}
          </Chip>
        </Copyable>
      ))}
    </ChipWrap>
  );
}

// Tone the verbs by destructiveness — read-only verbs render dim, mutating
// verbs render in the warn bucket, and "*" / delete escalate to bad. The
// operator can scan a long rules list quickly that way.
function VerbChip({ t, verb }: { t: Tokens; verb: string }) {
  const danger =
    verb === "*" || verb === "delete" || verb === "deletecollection"
      ? "bad"
      : verb === "create" || verb === "update" || verb === "patch"
        ? "warn"
        : "default";
  const bg =
    danger === "bad"
      ? "rgba(244,63,94,0.16)"
      : danger === "warn"
        ? "rgba(245,158,11,0.16)"
        : t.chip;
  const fg = danger === "bad" ? t.bad : danger === "warn" ? t.warn : t.textDim;
  return (
    <Copyable text={verb}>
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "1px 7px",
          borderRadius: R_SM,
          fontSize: FS_SM,
          fontWeight: 600,
          fontFamily: FF_MONO,
          background: bg,
          color: fg,
        }}
      >
        {verb}
      </span>
    </Copyable>
  );
}

// ── Rules table (shared by Role + ClusterRole) ─────────────────────────────

function RulesSection({
  t,
  rules,
}: {
  t: Tokens;
  rules: PolicyRule[];
}) {
  if (rules.length === 0) return null;
  return (
    <>
      <Section
        t={t}
        title="Rules"
        right={
          <span
            style={{
              fontSize: FS_XS,
              color: t.textMuted,
              fontFamily: FF_MONO,
            }}
          >
            {rules.length} total
          </span>
        }
      />
      <div style={{ marginBottom: 22 }}>
        {rules.map((r, i) => (
          <div
            key={i}
            style={{
              border: `1px solid ${t.borderSoft}`,
              borderRadius: R_LG,
              marginBottom: 10,
              background: t.surface,
              padding: "8px 12px",
            }}
          >
            <DetailRow t={t} label={`Rule ${i + 1}`}>
              <ChipWrap>
                {r.verbs.map((v) => (
                  <VerbChip key={v} t={t} verb={v} />
                ))}
              </ChipWrap>
            </DetailRow>
            {r.api_groups.length > 0 && (
              <DetailRow t={t} label="API Groups">
                <StringChips
                  t={t}
                  items={r.api_groups.map((g) => (g === "" ? "core" : g))}
                />
              </DetailRow>
            )}
            {r.resources.length > 0 && (
              <DetailRow t={t} label="Resources">
                <StringChips t={t} items={r.resources} />
              </DetailRow>
            )}
            {r.resource_names.length > 0 && (
              <DetailRow t={t} label="Resource Names">
                <StringChips t={t} items={r.resource_names} />
              </DetailRow>
            )}
            {r.non_resource_urls.length > 0 && (
              <DetailRow t={t} label="Non-Resource URLs">
                <StringChips t={t} items={r.non_resource_urls} />
              </DetailRow>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ── RoleRef + Subjects table (shared by both binding kinds) ────────────────

function RoleRefRow({
  t,
  roleRef,
  namespace,
  onNavigate,
}: {
  t: Tokens;
  roleRef: RoleRefSummary;
  // The binding's own namespace — RoleRef.kind is "Role" or "ClusterRole";
  // when "Role" we navigate within the binding's namespace.
  namespace: string | null;
  onNavigate?: DetailNavigate;
}) {
  const targetNs = roleRef.kind === "ClusterRole" ? null : namespace;
  return (
    <DetailRow t={t} label="Role">
      <span style={{ fontSize: FS_MD, color: t.textDim }}>{roleRef.kind}</span>
      <LinkValue
        t={t}
        onClick={() => onNavigate?.(roleRef.kind, targetNs, roleRef.name)}
        copyText={roleRef.name}
        enabled={!!onNavigate}
      >
        {roleRef.name}
      </LinkValue>
      {roleRef.api_group && (
        <span style={{ fontSize: FS_SM, color: t.textMuted }}>
          {roleRef.api_group}
        </span>
      )}
    </DetailRow>
  );
}

// Pick a navigation target for a Subject. ServiceAccount → namespaced;
// User / Group are not browseable as Kubernetes objects so we render them as
// plain copyable values. For "ServiceAccount" without a namespace we fall
// back to the binding's namespace (the apiserver does the same when the
// binding is namespace-scoped and the SA reference omits a namespace).
function SubjectRow({
  t,
  subject,
  bindingNamespace,
  onNavigate,
}: {
  t: Tokens;
  subject: RoleBindingSubject;
  bindingNamespace: string | null;
  onNavigate?: DetailNavigate;
}) {
  const isSA = subject.kind === "ServiceAccount";
  const ns = subject.namespace ?? bindingNamespace;
  return (
    <DetailRow t={t} label={subject.kind}>
      {isSA ? (
        <LinkValue
          t={t}
          onClick={() => onNavigate?.("ServiceAccount", ns, subject.name)}
          copyText={subject.name}
          enabled={!!onNavigate}
        >
          {subject.name}
        </LinkValue>
      ) : (
        <Copyable text={subject.name}>
          <span
            style={{
              fontFamily: FF_MONO,
              fontSize: FS_MD,
              wordBreak: "break-all",
            }}
          >
            {subject.name}
          </span>
        </Copyable>
      )}
      {ns && (
        <LinkValue
          t={t}
          onClick={() => onNavigate?.("Namespace", null, ns)}
          copyText={ns}
          enabled={!!onNavigate}
        >
          {ns}
        </LinkValue>
      )}
      {subject.api_group && subject.api_group !== "" && (
        <span style={{ fontSize: FS_SM, color: t.textMuted }}>
          {subject.api_group}
        </span>
      )}
    </DetailRow>
  );
}

function SubjectsSection({
  t,
  subjects,
  bindingNamespace,
  onNavigate,
}: {
  t: Tokens;
  subjects: RoleBindingSubject[];
  bindingNamespace: string | null;
  onNavigate?: DetailNavigate;
}) {
  return (
    <>
      <Section
        t={t}
        title="Subjects"
        right={
          <span
            style={{
              fontSize: FS_XS,
              color: t.textMuted,
              fontFamily: FF_MONO,
            }}
          >
            {subjects.length} total
          </span>
        }
      />
      <div style={{ marginBottom: 22 }}>
        {subjects.length === 0 ? (
          <DetailRow t={t} label="Subjects">
            <Mute t={t}>(none — binding grants no access until subjects are added)</Mute>
          </DetailRow>
        ) : (
          subjects.map((s, i) => (
            <SubjectRow
              key={i}
              t={t}
              subject={s}
              bindingNamespace={bindingNamespace}
              onNavigate={onNavigate}
            />
          ))
        )}
      </div>
    </>
  );
}

// ── ServiceAccount ─────────────────────────────────────────────────────────

export function ServiceAccountSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = useResolvedTheme().tokens;
  const ns = props.namespace;
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<ServiceAccountDetail>(
    () => api.getServiceAccountDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns)
    return <ErrorBlock t={t} message="ServiceAccount requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading service account…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="service account" />;

  const d = state.detail;
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
          }}
        >
          {d.secrets.length} secret{d.secrets.length === 1 ? "" : "s"}
        </span>
        {d.image_pull_secrets.length > 0 && (
          <span style={{ fontSize: FS_SM, color: t.textMuted }}>
            · {d.image_pull_secrets.length} pull secret
            {d.image_pull_secrets.length === 1 ? "" : "s"}
          </span>
        )}
        {d.meta.created_at && (
          <span style={{ fontSize: FS_SM, color: t.textMuted }}>
            · {ageFromIso(d.meta.created_at)} old
          </span>
        )}
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "serviceaccounts",
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((n) => n + 1)}
      />

      <Section t={t} title="Spec" />
      <div style={{ marginBottom: 22 }}>
        <DetailRow t={t} label="Automount Token">
          <span style={{ fontSize: FS_MD }}>
            {d.automount_service_account_token === true
              ? "true"
              : d.automount_service_account_token === false
                ? "false"
                : "(default — true)"}
          </span>
        </DetailRow>
      </div>

      {d.secrets.length > 0 && (
        <>
          <Section
            t={t}
            title="Secrets"
            right={
              <span
                style={{
                  fontSize: FS_XS,
                  color: t.textMuted,
                  fontFamily: FF_MONO,
                }}
              >
                {d.secrets.length} total
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {d.secrets.map((s) => (
              <DetailRow key={s.name} t={t} label={s.kind}>
                <LinkValue
                  t={t}
                  onClick={() =>
                    props.onNavigate?.(s.kind, s.namespace ?? ns, s.name)
                  }
                  copyText={s.name}
                  enabled={!!props.onNavigate}
                >
                  {s.name}
                </LinkValue>
                {s.namespace && s.namespace !== ns && (
                  <span style={{ fontSize: FS_SM, color: t.textMuted }}>
                    ns {s.namespace}
                  </span>
                )}
              </DetailRow>
            ))}
          </div>
        </>
      )}

      {d.image_pull_secrets.length > 0 && (
        <>
          <Section t={t} title="Image Pull Secrets" />
          <div style={{ marginBottom: 22 }}>
            <DetailRow t={t} label="Pull Secrets">
              <ChipWrap>
                {d.image_pull_secrets.map((name) => (
                  <LinkValue
                    key={name}
                    t={t}
                    onClick={() => props.onNavigate?.("Secret", ns, name)}
                    copyText={name}
                    enabled={!!props.onNavigate}
                  >
                    {name}
                  </LinkValue>
                ))}
              </ChipWrap>
            </DetailRow>
          </div>
        </>
      )}
    </Frame>
  );
}

// ── Role / ClusterRole ─────────────────────────────────────────────────────

export function RoleSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = useResolvedTheme().tokens;
  const ns = props.namespace;
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<RoleDetail>(
    () => api.getRoleDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns) return <ErrorBlock t={t} message="Role requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading role…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="role" />;

  const d = state.detail;
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
          }}
        >
          {d.rules.length} rule{d.rules.length === 1 ? "" : "s"}
        </span>
        {d.meta.created_at && (
          <span style={{ fontSize: FS_SM, color: t.textMuted }}>
            · {ageFromIso(d.meta.created_at)} old
          </span>
        )}
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "roles",
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((n) => n + 1)}
      />

      <RulesSection t={t} rules={d.rules} />
    </Frame>
  );
}

export function ClusterRoleSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = useResolvedTheme().tokens;
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<ClusterRoleDetail>(
    () => api.getClusterRoleDetail(props.clusterId, props.name),
    [props.clusterId, props.name, props.detailVersion, refetch],
  );

  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading cluster role…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="cluster role" />;

  const d = state.detail;
  const aggregated = !!d.aggregation_rule;
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
          }}
        >
          {d.rules.length} rule{d.rules.length === 1 ? "" : "s"}
        </span>
        {aggregated && (
          <span
            style={{
              fontSize: FS_SM,
              fontWeight: 600,
              padding: "1px 7px",
              borderRadius: R_SM,
              background: t.chip,
              color: t.textDim,
              fontFamily: FF_MONO,
            }}
          >
            aggregated
          </span>
        )}
        {d.meta.created_at && (
          <span style={{ fontSize: FS_SM, color: t.textMuted }}>
            · {ageFromIso(d.meta.created_at)} old
          </span>
        )}
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "clusterroles",
          namespace: null,
          name: props.name,
        }}
        onSaved={() => setRefetch((n) => n + 1)}
      />

      {aggregated && d.aggregation_rule && (
        <>
          <Section t={t} title="Aggregation Rule" />
          <div style={{ marginBottom: 22 }}>
            <DetailRow t={t} label="Selectors">
              <span style={{ fontFamily: FF_MONO, fontSize: FS_MD }}>
                {d.aggregation_rule.selector_count}
              </span>
            </DetailRow>
            {d.aggregation_rule.match_labels.length > 0 && (
              <DetailRow t={t} label="Match Labels">
                <KeyValueChips
                  t={t}
                  pairs={d.aggregation_rule.match_labels}
                />
              </DetailRow>
            )}
          </div>
        </>
      )}

      <RulesSection t={t} rules={d.rules} />
    </Frame>
  );
}

// ── RoleBinding / ClusterRoleBinding ───────────────────────────────────────

export function RoleBindingSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = useResolvedTheme().tokens;
  const ns = props.namespace;
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<RoleBindingDetail>(
    () => api.getRoleBindingDetail(props.clusterId, ns!, props.name),
    [props.clusterId, ns, props.name, props.detailVersion, refetch],
  );

  if (!ns)
    return <ErrorBlock t={t} message="RoleBinding requires a namespace." />;
  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading role binding…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="role binding" />;

  const d = state.detail;
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
          }}
        >
          {d.role_ref.kind} / {d.role_ref.name}
        </span>
        <span style={{ fontSize: FS_SM, color: t.textMuted }}>
          → {d.subjects.length} subject{d.subjects.length === 1 ? "" : "s"}
        </span>
        {d.meta.created_at && (
          <span style={{ fontSize: FS_SM, color: t.textMuted }}>
            · {ageFromIso(d.meta.created_at)} old
          </span>
        )}
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "rolebindings",
          namespace: ns,
          name: props.name,
        }}
        onSaved={() => setRefetch((n) => n + 1)}
      />

      <Section t={t} title="Role Reference" />
      <div style={{ marginBottom: 22 }}>
        <RoleRefRow
          t={t}
          roleRef={d.role_ref}
          namespace={ns}
          onNavigate={props.onNavigate}
        />
      </div>

      <SubjectsSection
        t={t}
        subjects={d.subjects}
        bindingNamespace={ns}
        onNavigate={props.onNavigate}
      />
    </Frame>
  );
}

export function ClusterRoleBindingSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = useResolvedTheme().tokens;
  const [refetch, setRefetch] = useState(0);
  const state = useDetail<ClusterRoleBindingDetail>(
    () => api.getClusterRoleBindingDetail(props.clusterId, props.name),
    [props.clusterId, props.name, props.detailVersion, refetch],
  );

  if (state.kind === "loading")
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading cluster role binding…"/>
      </Frame>
    );
  if (state.kind === "error")
    return <ErrorBlock t={t} message={state.message} kindLabel="cluster role binding" />;

  const d = state.detail;
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
          }}
        >
          {d.role_ref.kind} / {d.role_ref.name}
        </span>
        <span style={{ fontSize: FS_SM, color: t.textMuted }}>
          → {d.subjects.length} subject{d.subjects.length === 1 ? "" : "s"}
        </span>
        {d.meta.created_at && (
          <span style={{ fontSize: FS_SM, color: t.textMuted }}>
            · {ageFromIso(d.meta.created_at)} old
          </span>
        )}
      </div>

      <MetaSection
        t={t}
        meta={d.meta}
        onNavigate={props.onNavigate}
        editTarget={{
          clusterId: props.clusterId,
          kindId: "clusterrolebindings",
          namespace: null,
          name: props.name,
        }}
        onSaved={() => setRefetch((n) => n + 1)}
      />

      <Section t={t} title="Role Reference" />
      <div style={{ marginBottom: 22 }}>
        <RoleRefRow
          t={t}
          roleRef={d.role_ref}
          namespace={null}
          onNavigate={props.onNavigate}
        />
      </div>

      <SubjectsSection
        t={t}
        subjects={d.subjects}
        bindingNamespace={null}
        onNavigate={props.onNavigate}
      />
    </Frame>
  );
}
