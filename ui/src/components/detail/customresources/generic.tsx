// Schema-driven detail summary for any CRD-backed kind that doesn't have a
// hand-written summary. Walks the live CR's spec/status against the CRD's
// openAPIV3Schema, rendering each field via the standard primitives plus a
// local disclosure stack.
//
// Three rendering depths:
//   1. Top level: flat `<DetailRow>`s — same baseline as hand-written kinds.
//   2. Depth 2: bordered `<CardBranch>` cards — visually anchors major
//      nested groups (e.g. `spec.template.spec` of an Argo Application).
//   3. Depth ≥ 3: `<TreeBranch>` — a left-rule + indented tree row, no card
//      chrome, so deeply nested status trees stay scannable instead of
//      becoming nested-borders soup.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../../../api";
import { FONT_MONO, type ThemeMode, type Tokens } from "../../../theme";
import { tokens } from "../../../theme";
import { Chip, LoadingLine, Section, StatusPill, Tooltip } from "../../ui";
import {
  ChipWrap,
  ConditionChip,
  Copyable,
  DetailRow,
  Mute,
  ageFromIso,
  type ConditionStatus,
  type DetailNavigate,
} from "..";
import { MetaSection } from "../workload/shared";
import type {
  CustomResourceDetail,
  CustomResourceSchemaNode,
} from "../../../types";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; detail: CustomResourceDetail }
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

export function CustomResourceSummary(props: {
  mode: ThemeMode;
  clusterId: string;
  kindId: string;
  namespace: string | null;
  name: string;
  detailVersion: number;
  onNavigate?: DetailNavigate;
}) {
  const t = tokens(props.mode);
  const [refetch, setRefetch] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    api
      .getCustomResourceDetail(
        props.clusterId,
        props.kindId,
        props.namespace,
        props.name,
      )
      .then((detail) => {
        if (reqId.current === id) setState({ kind: "ready", detail });
      })
      .catch((e: unknown) => {
        if (reqId.current === id)
          setState({ kind: "error", message: String(e) });
      });
  }, [
    props.clusterId,
    props.kindId,
    props.namespace,
    props.name,
    props.detailVersion,
    refetch,
  ]);

  if (state.kind === "loading") {
    return (
      <Frame t={t}>
        <LoadingLine t={t} label="Loading…" inline />
      </Frame>
    );
  }
  if (state.kind === "error") {
    return (
      <pre
        style={{
          padding: 18,
          fontFamily: FONT_MONO,
          fontSize: 11.5,
          color: t.bad,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          margin: 0,
        }}
      >
        {state.message}
      </pre>
    );
  }

  const d = state.detail;
  const obj = d.object;
  const spec = (obj.spec ?? null) as Record<string, unknown> | null;
  const status = (obj.status ?? null) as Record<string, unknown> | null;
  const conditions = extractConditions(status);
  const phase = extractPhase(status);
  const headerKindLabel = `${d.kind}${d.group ? `.${d.group}` : ""}`;

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
            fontFamily: FONT_MONO,
            fontSize: 13,
            fontWeight: 600,
            color: t.text,
            wordBreak: "break-all",
          }}
        >
          {headerKindLabel}
        </span>
        {phase && (
          <StatusPill status={phase} t={t} mode={props.mode} dense />
        )}
        <Copyable text={`${d.group}/${d.version}`}>
          <Chip t={t} mono>
            {d.group ? `${d.group}/${d.version}` : d.version}
          </Chip>
        </Copyable>
        {d.meta.created_at && (
          <span style={{ fontSize: 11.5, color: t.textMuted }}>
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
          kindId: props.kindId,
          namespace: props.namespace,
          name: props.name,
        }}
        onSaved={() => setRefetch((n) => n + 1)}
      />

      {d.printer_columns.length > 0 && (
        <>
          <Section t={t} title="Printer Columns" />
          <div style={{ marginBottom: 22 }}>
            {d.printer_columns.map((c) => {
              const v = readJsonPath(obj, c.json_path);
              return (
                <DetailRow t={t} key={c.name} label={c.name}>
                  {v == null ? (
                    <Mute t={t}>—</Mute>
                  ) : (
                    <Copyable text={String(v)}>
                      <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
                        {c.type === "date" && typeof v === "string"
                          ? `${ageFromIso(v)} (${v})`
                          : String(v)}
                      </span>
                    </Copyable>
                  )}
                </DetailRow>
              );
            })}
          </div>
        </>
      )}

      {spec != null && Object.keys(spec).length > 0 && (
        <TreeView
          t={t}
          title="Spec"
          obj={spec}
          schema={d.schema?.spec ?? null}
        />
      )}

      {conditions.length > 0 && (
        <>
          <Section
            t={t}
            title="Conditions"
            right={
              <span
                style={{
                  fontSize: 10.5,
                  fontFamily: FONT_MONO,
                  color: t.textMuted,
                }}
              >
                {conditions.length} total
              </span>
            }
          />
          <div style={{ marginBottom: 22 }}>
            {conditions.map((c) => (
              <DetailRow
                t={t}
                key={`${c.type}-${c.lastTransitionTime ?? ""}`}
                label={c.type}
              >
                <ConditionChip
                  t={t}
                  cond={{ type: c.status, status: c.status }}
                />
                {c.reason && (
                  <span
                    style={{
                      fontSize: 11.5,
                      color: t.textMuted,
                      fontFamily: FONT_MONO,
                    }}
                  >
                    {c.reason}
                  </span>
                )}
                {c.message && (
                  <span
                    style={{
                      fontSize: 11.5,
                      color: t.textMuted,
                      wordBreak: "break-word",
                    }}
                  >
                    {c.message}
                  </span>
                )}
                {c.lastTransitionTime && (
                  <span
                    style={{
                      fontSize: 11,
                      color: t.textMuted,
                      fontFamily: FONT_MONO,
                    }}
                  >
                    {ageFromIso(c.lastTransitionTime)}
                  </span>
                )}
              </DetailRow>
            ))}
          </div>
        </>
      )}

      {status != null && Object.keys(omitKey(status, "conditions")).length > 0 && (
        <TreeView
          t={t}
          title="Status"
          obj={omitKey(status, "conditions")}
          schema={d.schema?.status ?? null}
        />
      )}
    </Frame>
  );
}

// ── TreeView ──────────────────────────────────────────────────────────────
//
// One self-contained section (Spec or Status) with its own filter input,
// expand-all / collapse-all controls, and recursive renderer. The filter
// scope is per-section because the panel scrolls past one before reaching
// the other.

type TreeCtxValue = {
  // Bumped each time the user hits expand-all / collapse-all so children can
  // listen via the signal pattern. Sentinel 0 means "no broadcast yet".
  expandSignal: number;
  collapseSignal: number;
  // Match-set lookup. `self` = this exact path matches; `ancestor` = a
  // descendant matches and we should auto-open this branch; `miss` = no
  // match anywhere down this path.
  match: (path: string) => "self" | "ancestor" | "miss";
  // True when the user has typed any filter text. Branches default to
  // expanded based on this so empty filter = clean collapse defaults but
  // typed filter = matched paths visible without manual clicks.
  filterActive: boolean;
};

const TreeCtx = createContext<TreeCtxValue>({
  expandSignal: 0,
  collapseSignal: 0,
  match: () => "self",
  filterActive: false,
});

function TreeView({
  t,
  title,
  obj,
  schema,
}: {
  t: Tokens;
  title: string;
  obj: Record<string, unknown>;
  schema: CustomResourceSchemaNode | null;
}) {
  const [filter, setFilter] = useState("");
  const [expandSignal, setExpandSignal] = useState(0);
  const [collapseSignal, setCollapseSignal] = useState(0);

  const matchSets = useMemo(() => buildMatchSets(obj, filter), [obj, filter]);

  const ctx: TreeCtxValue = {
    expandSignal,
    collapseSignal,
    match: (path) => {
      if (!filter) return "self";
      if (matchSets.self.has(path)) return "self";
      if (matchSets.ancestor.has(path)) return "ancestor";
      return "miss";
    },
    filterActive: filter.length > 0,
  };

  return (
    <>
      <Section
        t={t}
        title={title}
        right={
          <SectionToolbar
            t={t}
            filter={filter}
            onFilter={setFilter}
            onExpandAll={() => setExpandSignal((n) => n + 1)}
            onCollapseAll={() => setCollapseSignal((n) => n + 1)}
            matchCount={filter ? matchSets.self.size : null}
          />
        }
      />
      <div style={{ marginBottom: 22 }}>
        <TreeCtx.Provider value={ctx}>
          <RootRows t={t} obj={obj} schema={schema} />
        </TreeCtx.Provider>
      </div>
    </>
  );
}

function SectionToolbar({
  t,
  filter,
  onFilter,
  onExpandAll,
  onCollapseAll,
  matchCount,
}: {
  t: Tokens;
  filter: string;
  onFilter: (v: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  matchCount: number | null;
}) {
  return (
    <span
      style={{ display: "inline-flex", gap: 8, alignItems: "center" }}
    >
      <input
        value={filter}
        onChange={(e) => onFilter(e.target.value)}
        placeholder="filter…"
        spellCheck={false}
        style={{
          fontFamily: FONT_MONO,
          fontSize: 11,
          padding: "2px 6px",
          minWidth: 140,
          background: t.surface,
          color: t.text,
          border: `1px solid ${t.borderSoft}`,
          borderRadius: 3,
          outline: "none",
        }}
      />
      {matchCount !== null && (
        <span
          style={{
            fontSize: 10,
            fontFamily: FONT_MONO,
            color: matchCount === 0 ? t.warn : t.textMuted,
          }}
        >
          {matchCount} match{matchCount === 1 ? "" : "es"}
        </span>
      )}
      <ToolbarButton t={t} onClick={onExpandAll}>expand all</ToolbarButton>
      <ToolbarButton t={t} onClick={onCollapseAll}>collapse all</ToolbarButton>
    </span>
  );
}

function ToolbarButton({
  t,
  onClick,
  children,
}: {
  t: Tokens;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: FONT_MONO,
        fontSize: 10,
        padding: "2px 6px",
        background: t.surface,
        color: t.textMuted,
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 3,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

// ── Top-level rows ─────────────────────────────────────────────────────────

function RootRows({
  t,
  obj,
  schema,
}: {
  t: Tokens;
  obj: Record<string, unknown>;
  schema: CustomResourceSchemaNode | null;
}) {
  const ctx = useContext(TreeCtx);
  const keys = orderedKeys(obj, schema);
  if (keys.length === 0) return <Mute t={t}>—</Mute>;
  // Per-section matcher: paths are just dotted keys, no `spec.` / `status.`
  // prefix because each TreeView owns its own match-set namespace.
  const shown = ctx.filterActive
    ? keys.filter((k) => ctx.match(k) !== "miss")
    : keys;
  return (
    <>
      {shown.map((k) => {
        const childSchema = schema?.properties?.[k] ?? null;
        return (
          <DetailRow
            t={t}
            key={k}
            label={
              <LabelWithDoc
                label={humanize(k)}
                doc={childSchema?.description ?? null}
                rawKey={k}
                t={t}
              />
            }
          >
            <Leaf
              t={t}
              v={obj[k]}
              schema={childSchema}
              depth={1}
              path={k}
            />
          </DetailRow>
        );
      })}
    </>
  );
}

// `DetailRow` accepts ReactNode for label via composition. We render a tiny
// `?` next to the label when the schema exposes a description. Native
// `title` tooltip — no extra dep, accessible by default.
function LabelWithDoc({
  label,
  doc,
  rawKey,
  t,
}: {
  label: string;
  doc: string | null;
  rawKey: string;
  t: Tokens;
}) {
  const ctx = useContext(TreeCtx);
  const matched =
    ctx.filterActive && ctx.match(rawKey) === "self";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        color: matched ? t.accent : undefined,
      }}
    >
      {label}
      {doc && (
        <Tooltip label={doc}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 12,
              height: 12,
              borderRadius: 6,
              border: `1px solid ${t.borderSoft}`,
              color: t.textMuted,
              fontSize: 9,
              cursor: "help",
              fontFamily: FONT_MONO,
            }}
          >
            ?
          </span>
        </Tooltip>
      )}
    </span>
  );
}

// ── Leaf ──────────────────────────────────────────────────────────────────
//
// Polymorphic value renderer. Scalars → inline copy; arrays of scalars →
// chip wrap; objects/structured arrays → branch (card or tree row depending
// on depth).

function Leaf({
  t,
  v,
  schema,
  depth,
  path,
}: {
  t: Tokens;
  v: unknown;
  schema: CustomResourceSchemaNode | null;
  depth: number;
  path: string;
}) {
  if (v == null) return <Mute t={t}>—</Mute>;
  if (typeof v === "string") return <ScalarString t={t} v={v} schema={schema} />;
  if (typeof v === "number" || typeof v === "boolean") {
    const s = String(v);
    return (
      <Copyable text={s}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>{s}</span>
      </Copyable>
    );
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return <Mute t={t}>[ ]</Mute>;
    if (v.every((x) => typeof x === "string")) {
      return (
        <ChipWrap>
          {(v as string[]).map((s, i) => (
            <Copyable key={`${s}-${i}`} text={s}>
              <Chip t={t} mono>
                {s}
              </Chip>
            </Copyable>
          ))}
        </ChipWrap>
      );
    }
    if (v.every((x) => typeof x === "number" || typeof x === "boolean")) {
      const s = v.map(String).join(", ");
      return (
        <Copyable text={s}>
          <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>{s}</span>
        </Copyable>
      );
    }
    return (
      <ArrayBranch t={t} arr={v} schema={schema} depth={depth} path={path} />
    );
  }
  if (typeof v === "object") {
    return (
      <ObjectBranch
        t={t}
        obj={v as Record<string, unknown>}
        schema={schema}
        depth={depth}
        path={path}
      />
    );
  }
  return <Mute t={t}>—</Mute>;
}

function ScalarString({
  t,
  v,
  schema,
}: {
  t: Tokens;
  v: string;
  schema: CustomResourceSchemaNode | null;
}) {
  if (v === "") return <Mute t={t}>—</Mute>;
  if (schema?.format === "date-time" || isIsoDate(v)) {
    return (
      <Copyable text={v}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>
          {ageFromIso(v)} ({v})
        </span>
      </Copyable>
    );
  }
  return (
    <Copyable text={v}>
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: 12,
          wordBreak: "break-all",
        }}
      >
        {v}
      </span>
    </Copyable>
  );
}

// ── Branch routing ────────────────────────────────────────────────────────
//
// Depth ≤ 2 → bordered card disclosure. Depth ≥ 3 → tree row (left rule +
// indent, no card chrome). Threshold lives here so all object/array paths
// agree.

const TREE_DEPTH_THRESHOLD = 3;

function ObjectBranch({
  t,
  obj,
  schema,
  depth,
  path,
}: {
  t: Tokens;
  obj: Record<string, unknown>;
  schema: CustomResourceSchemaNode | null;
  depth: number;
  path: string;
}) {
  const keys = orderedKeys(obj, schema);
  if (keys.length === 0) return <Mute t={t}>{`{ }`}</Mute>;
  const ctx = useContext(TreeCtx);
  const matchKind = ctx.match(path);
  if (matchKind === "miss") return null;
  // Default-open: depth≤1, or we're an ancestor of a filtered match, or
  // the user typed a filter (open the world so matches are visible).
  const initialOpen =
    depth <= 1 || matchKind === "ancestor" || ctx.filterActive;
  const { open, setOpen } = useDisclosureState(initialOpen, ctx);
  const preview = objectPreview(obj, keys);
  const summary = (
    <SummaryLine
      t={t}
      pill={`${keys.length} field${keys.length === 1 ? "" : "s"}`}
      tail={preview}
    />
  );
  if (depth >= TREE_DEPTH_THRESHOLD) {
    return (
      <TreeBranch
        t={t}
        open={open}
        onToggle={() => setOpen(!open)}
        summary={summary}
        copyText={JSON.stringify(obj)}
      >
        <NestedRows t={t} obj={obj} schema={schema} depth={depth + 1} path={path} />
      </TreeBranch>
    );
  }
  return (
    <CardBranch
      t={t}
      open={open}
      onToggle={() => setOpen(!open)}
      summary={summary}
      copyText={JSON.stringify(obj)}
    >
      <NestedRows t={t} obj={obj} schema={schema} depth={depth + 1} path={path} />
    </CardBranch>
  );
}

function ArrayBranch({
  t,
  arr,
  schema,
  depth,
  path,
}: {
  t: Tokens;
  arr: unknown[];
  schema: CustomResourceSchemaNode | null;
  depth: number;
  path: string;
}) {
  const ctx = useContext(TreeCtx);
  const matchKind = ctx.match(path);
  if (matchKind === "miss") return null;
  const initialOpen =
    depth <= 1 || matchKind === "ancestor" || ctx.filterActive;
  const { open, setOpen } = useDisclosureState(initialOpen, ctx);
  const itemSchema = schema?.items ?? null;
  const summary = (
    <SummaryLine
      t={t}
      pill={`${arr.length} item${arr.length === 1 ? "" : "s"}`}
      tail={
        arr.length > 0
          ? arr
              .slice(0, 3)
              .map((x) => itemTitle(x))
              .filter((s): s is string => !!s)
              .join(", ") || null
          : null
      }
    />
  );
  const body = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        width: "100%",
      }}
    >
      {arr.map((item, i) => (
        <ArrayItem
          key={i}
          t={t}
          index={i}
          item={item}
          schema={itemSchema}
          depth={depth + 1}
          path={`${path}[${i}]`}
        />
      ))}
    </div>
  );
  if (depth >= TREE_DEPTH_THRESHOLD) {
    return (
      <TreeBranch
        t={t}
        open={open}
        onToggle={() => setOpen(!open)}
        summary={summary}
        copyText={JSON.stringify(arr)}
      >
        {body}
      </TreeBranch>
    );
  }
  return (
    <CardBranch
      t={t}
      open={open}
      onToggle={() => setOpen(!open)}
      summary={summary}
      copyText={JSON.stringify(arr)}
    >
      {body}
    </CardBranch>
  );
}

function ArrayItem({
  t,
  index,
  item,
  schema,
  depth,
  path,
}: {
  t: Tokens;
  index: number;
  item: unknown;
  schema: CustomResourceSchemaNode | null;
  depth: number;
  path: string;
}) {
  const ctx = useContext(TreeCtx);
  const matchKind = ctx.match(path);
  if (matchKind === "miss") return null;

  if (item == null || typeof item !== "object") {
    return (
      <div
        style={{
          border: `1px solid ${t.borderSoft}`,
          borderRadius: 6,
          padding: "6px 10px",
          background: t.surface,
          fontFamily: FONT_MONO,
          fontSize: 12,
        }}
      >
        <span style={{ color: t.textMuted, marginRight: 8 }}>[{index}]</span>
        <Leaf t={t} v={item} schema={schema} depth={depth} path={path} />
      </div>
    );
  }
  const obj = item as Record<string, unknown>;
  const title = itemTitle(obj) ?? `item ${index}`;
  const keys = orderedKeys(obj, schema);
  const initialOpen =
    depth <= 2 || matchKind === "ancestor" || ctx.filterActive;
  const { open, setOpen } = useDisclosureState(initialOpen, ctx);

  const titleNode = (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center", minWidth: 0 }}>
      <span style={{ color: t.textMuted, fontFamily: FONT_MONO, fontSize: 11 }}>
        [{index}]
      </span>
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: 12,
          fontWeight: 600,
          color: t.text,
          wordBreak: "break-all",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {title}
      </span>
      <Pill t={t}>{keys.length} field{keys.length === 1 ? "" : "s"}</Pill>
    </span>
  );

  if (depth >= TREE_DEPTH_THRESHOLD) {
    return (
      <TreeBranch
        t={t}
        open={open}
        onToggle={() => setOpen(!open)}
        summary={titleNode}
        copyText={JSON.stringify(obj)}
      >
        <NestedRows
          t={t}
          obj={obj}
          schema={schema}
          depth={depth + 1}
          path={path}
        />
      </TreeBranch>
    );
  }
  return (
    <div
      style={{
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 6,
        background: t.surface,
        overflow: "hidden",
      }}
    >
      <DisclosureHeader
        t={t}
        open={open}
        onToggle={() => setOpen(!open)}
        copyText={JSON.stringify(obj)}
      >
        {titleNode}
      </DisclosureHeader>
      {open && (
        <div style={{ padding: "6px 10px 8px" }}>
          <NestedRows
            t={t}
            obj={obj}
            schema={schema}
            depth={depth + 1}
            path={path}
          />
        </div>
      )}
    </div>
  );
}

// ── Indented label/value rows (used inside a Disclosure body) ──────────────

function NestedRows({
  t,
  obj,
  schema,
  depth,
  path,
}: {
  t: Tokens;
  obj: Record<string, unknown>;
  schema: CustomResourceSchemaNode | null;
  depth: number;
  path: string;
}) {
  const ctx = useContext(TreeCtx);
  const allKeys = orderedKeys(obj, schema);
  const keys = ctx.filterActive
    ? allKeys.filter((k) => ctx.match(`${path}.${k}`) !== "miss")
    : allKeys;
  if (keys.length === 0) return <Mute t={t}>—</Mute>;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(140px, max-content) 1fr",
        columnGap: 14,
        rowGap: 6,
        width: "100%",
      }}
    >
      {keys.map((k) => {
        const childSchema = schema?.properties?.[k] ?? null;
        const childPath = `${path}.${k}`;
        return (
          <NestedRow
            key={k}
            t={t}
            label={
              <LabelWithDoc
                label={humanize(k)}
                doc={childSchema?.description ?? null}
                rawKey={childPath}
                t={t}
              />
            }
            value={
              <Leaf
                t={t}
                v={obj[k]}
                schema={childSchema}
                depth={depth}
                path={childPath}
              />
            }
          />
        );
      })}
    </div>
  );
}

function NestedRow({
  t,
  label,
  value,
}: {
  t: Tokens;
  label: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: t.textMuted,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          fontFamily: FONT_MONO,
          alignSelf: "start",
          marginTop: 3,
        }}
      >
        {label}
      </div>
      <div
        style={{
          minWidth: 0,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
          color: t.text,
        }}
      >
        {value}
      </div>
    </>
  );
}

// ── Disclosure shells ─────────────────────────────────────────────────────
//
// `<CardBranch>` is the bordered-card style used at shallow depths.
// `<TreeBranch>` is the lighter left-rule + indent style used past the
// threshold so nested-borders soup never shows up.

function CardBranch({
  t,
  open,
  onToggle,
  summary,
  copyText,
  children,
}: {
  t: Tokens;
  open: boolean;
  onToggle: () => void;
  summary: React.ReactNode;
  copyText?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        width: "100%",
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 6,
        background: t.surface,
        overflow: "hidden",
      }}
    >
      <DisclosureHeader
        t={t}
        open={open}
        onToggle={onToggle}
        copyText={copyText}
      >
        {summary}
      </DisclosureHeader>
      {open && <div style={{ padding: "8px 10px 10px" }}>{children}</div>}
    </div>
  );
}

function TreeBranch({
  t,
  open,
  onToggle,
  summary,
  copyText,
  children,
}: {
  t: Tokens;
  open: boolean;
  onToggle: () => void;
  summary: React.ReactNode;
  copyText?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ width: "100%" }}>
      <DisclosureHeader
        t={t}
        open={open}
        onToggle={onToggle}
        copyText={copyText}
        compact
      >
        {summary}
      </DisclosureHeader>
      {open && (
        <div
          style={{
            marginLeft: 5,
            paddingLeft: 10,
            paddingTop: 4,
            paddingBottom: 4,
            borderLeft: `1px solid ${t.borderSoft}`,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function DisclosureHeader({
  t,
  open,
  onToggle,
  copyText,
  compact = false,
  children,
}: {
  t: Tokens;
  open: boolean;
  onToggle: () => void;
  copyText?: string;
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        } else if (e.key === "ArrowRight" && !open) {
          e.preventDefault();
          onToggle();
        } else if (e.key === "ArrowLeft" && open) {
          e.preventDefault();
          onToggle();
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: compact ? "2px 4px" : "5px 10px",
        cursor: "pointer",
        userSelect: "none",
        background: !compact && open ? t.surfaceAlt : "transparent",
        borderRadius: 3,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
          flex: 1,
        }}
      >
        <Caret open={open} t={t} />
        {children}
      </span>
      {copyText && (
        <Copyable text={copyText}>
          <span
            onClick={(e) => e.stopPropagation()}
            style={{
              fontSize: 10,
              fontFamily: FONT_MONO,
              color: t.textMuted,
              padding: "1px 6px",
              border: `1px solid ${t.borderSoft}`,
              borderRadius: 3,
            }}
          >
            copy
          </span>
        </Copyable>
      )}
    </div>
  );
}

function Caret({ open, t }: { open: boolean; t: Tokens }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        textAlign: "center",
        color: t.textMuted,
        fontFamily: FONT_MONO,
        fontSize: 11,
        transition: "transform 80ms ease",
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
      }}
    >
      ▸
    </span>
  );
}

function Pill({ t, children }: { t: Tokens; children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontFamily: FONT_MONO,
        color: t.textMuted,
        background: t.surfaceAlt,
        border: `1px solid ${t.borderSoft}`,
        padding: "0 5px",
        borderRadius: 3,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function SummaryLine({
  t,
  pill,
  tail,
}: {
  t: Tokens;
  pill: string;
  tail: string | null;
}) {
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", minWidth: 0 }}>
      <Pill t={t}>{pill}</Pill>
      {tail && (
        <span
          style={{
            fontSize: 11.5,
            color: t.textMuted,
            fontFamily: FONT_MONO,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 360,
          }}
        >
          {tail}
        </span>
      )}
    </span>
  );
}

// ── Disclosure state hook ─────────────────────────────────────────────────
//
// Combines local toggle state with broadcast signals from the section
// toolbar (expand-all / collapse-all). Each branch listens via the signal
// pattern: when the signal value changes, update local `open`. Filter-driven
// auto-open is handled by passing a derived `initialOpen` from the caller.

function useDisclosureState(initialOpen: boolean, ctx: TreeCtxValue) {
  const [open, setOpen] = useState(initialOpen);
  const [seenExpand, setSeenExpand] = useState(ctx.expandSignal);
  const [seenCollapse, setSeenCollapse] = useState(ctx.collapseSignal);
  const [seenInitial, setSeenInitial] = useState(initialOpen);

  // initialOpen flips when the filter activates / changes; treat the flip
  // as a reset so a previously-collapsed branch auto-opens for matches.
  if (seenInitial !== initialOpen) {
    setSeenInitial(initialOpen);
    setOpen(initialOpen);
  }
  if (ctx.expandSignal !== seenExpand) {
    setSeenExpand(ctx.expandSignal);
    setOpen(true);
  }
  if (ctx.collapseSignal !== seenCollapse) {
    setSeenCollapse(ctx.collapseSignal);
    setOpen(false);
  }

  return { open, setOpen };
}

// ── Filter match-set construction ─────────────────────────────────────────
//
// Walk the tree once and produce two sets of dotted paths:
//   * `self`: paths whose key or scalar value contains the query.
//   * `ancestor`: every path on the route from root to a `self` path —
//     used to auto-open enclosing branches.
//
// Path syntax matches what we pass through `path` props: dot-joined keys,
// `[N]` for array indices.

function buildMatchSets(
  obj: Record<string, unknown>,
  filter: string,
): { self: Set<string>; ancestor: Set<string> } {
  const self = new Set<string>();
  const ancestor = new Set<string>();
  if (!filter) return { self, ancestor };
  const q = filter.toLowerCase();

  function visit(node: unknown, path: string, key: string | null): boolean {
    let hit = false;
    if (key && key.toLowerCase().includes(q)) hit = true;
    if (typeof node === "string" && node.toLowerCase().includes(q)) hit = true;
    if (
      (typeof node === "number" || typeof node === "boolean") &&
      String(node).toLowerCase().includes(q)
    ) {
      hit = true;
    }

    let descendantHit = false;
    if (node && typeof node === "object") {
      if (Array.isArray(node)) {
        node.forEach((child, i) => {
          if (visit(child, `${path}[${i}]`, null)) descendantHit = true;
        });
      } else {
        for (const [k, v] of Object.entries(node)) {
          const sub = path === "" ? k : `${path}.${k}`;
          if (visit(v, sub, k)) descendantHit = true;
        }
      }
    }

    if (hit) self.add(path);
    if (descendantHit) ancestor.add(path);
    return hit || descendantHit;
  }

  for (const [k, v] of Object.entries(obj)) {
    visit(v, k, k);
  }
  return { self, ancestor };
}

// ── Helpers ────────────────────────────────────────────────────────────────

type ConditionLike = {
  type: string;
  status: ConditionStatus;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
};

function extractConditions(
  status: Record<string, unknown> | null,
): ConditionLike[] {
  if (!status) return [];
  const raw = status.conditions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (c): c is Record<string, unknown> =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as Record<string, unknown>).type === "string",
    )
    .map((c) => ({
      type: String(c.type),
      status: String(c.status ?? "Unknown") as ConditionStatus,
      reason: typeof c.reason === "string" ? c.reason : undefined,
      message: typeof c.message === "string" ? c.message : undefined,
      lastTransitionTime:
        typeof c.lastTransitionTime === "string"
          ? c.lastTransitionTime
          : undefined,
    }));
}

function extractPhase(status: Record<string, unknown> | null): string | null {
  if (!status) return null;
  const p = status.phase;
  return typeof p === "string" && p.length > 0 ? p : null;
}

function omitKey(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (k !== key) out[k] = obj[k];
  }
  return out;
}

function orderedKeys(
  obj: Record<string, unknown>,
  schema: CustomResourceSchemaNode | null,
): string[] {
  const present = Object.keys(obj);
  if (!schema?.properties) return present;
  const required = new Set(schema.required ?? []);
  const declared = Object.keys(schema.properties);
  const declaredSet = new Set(declared);
  const declaredFiltered = declared.filter((k) => k in obj);
  declaredFiltered.sort((a, b) => {
    const ar = required.has(a) ? 0 : 1;
    const br = required.has(b) ? 0 : 1;
    return ar - br;
  });
  const extras = present.filter((k) => !declaredSet.has(k));
  return [...declaredFiltered, ...extras];
}

function humanize(key: string): string {
  if (/^[A-Z0-9_-]+$/.test(key)) return key;
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s);
}

function objectPreview(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    if (typeof v === "string") {
      parts.push(`${k}=${truncate(v, 28)}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k}=${String(v)}`);
    }
    if (parts.length >= 3) break;
  }
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

function itemTitle(item: unknown): string | null {
  if (item == null || typeof item !== "object") {
    if (typeof item === "string") return truncate(item, 40);
    if (typeof item === "number" || typeof item === "boolean") return String(item);
    return null;
  }
  const obj = item as Record<string, unknown>;
  for (const k of ["name", "type", "kind", "key", "id"]) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function readJsonPath(root: unknown, path: string): unknown {
  const trimmed = path.trim().replace(/^\./, "");
  if (trimmed === "") return undefined;
  const segs: string[] = [];
  for (const piece of trimmed.split(".")) {
    const m = /^([A-Za-z0-9_-]+)((?:\[\d+\])*)$/.exec(piece);
    if (!m) return undefined;
    segs.push(m[1]!);
    const idxs = m[2] ?? "";
    const idxRe = /\[(\d+)\]/g;
    let im;
    while ((im = idxRe.exec(idxs))) segs.push(im[1]!);
  }
  let cur: unknown = root;
  for (const s of segs) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(s);
      if (Number.isNaN(i)) return undefined;
      cur = cur[i];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[s];
    } else {
      return undefined;
    }
  }
  return cur;
}
