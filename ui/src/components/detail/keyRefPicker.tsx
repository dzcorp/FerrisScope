// Modal picker for namespace-scoped resources used as refs from elsewhere
// in the workload spec.
//
// Two layouts, one component:
//   - ConfigMap / Secret with `keyMode: "required"`: two-pane name → key
//     drill-down with an "Optional" toggle. Used by env `valueFrom` refs
//     where you need a specific key.
//   - ConfigMap / Secret / PersistentVolumeClaim with `keyMode: "none"`:
//     single-pane name list. Used by envFrom (whole-source) and by the
//     volumes editor where the source is a whole CM / Secret / PVC.
//
// Data comes from the on-demand list APIs in `api.ts`. No caching — the
// dialog is short-lived and operators expect fresh data each open.

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { FF_MONO, type Tokens, R_LG, FS_LG, FS_MD, FS_SM, FS_XS } from "../../theme";
import type {
  ConfigMapKeysSummary,
  PvcSummary,
  SecretKeysSummary,
} from "../../types";
import { Btn, Checkbox, ErrorBlock, Icons } from "../ui";

export type KeyRefSelection = {
  name: string;
  // Empty in `keyMode: "none"`.
  key: string;
  // Caller-decides semantics: valueFrom.optional, envFrom.optional, or
  // ignored entirely. Always false in `keyMode: "none"` since the picker
  // doesn't show the toggle.
  optional: boolean;
};

export type KeyRefPickerKind = "ConfigMap" | "Secret" | "PersistentVolumeClaim";

export type KeyRefPickerProps = {
  t: Tokens;
  clusterId: string;
  namespace: string;
  // Source kind. PersistentVolumeClaim implies `keyMode: "none"` regardless
  // of the prop (PVCs don't have keys).
  kind: KeyRefPickerKind;
  // "required" → two-pane drill-down + "Optional" toggle.
  // "none"     → single-pane name list, no toggle.
  keyMode?: "required" | "none";
  // Pre-fill — used when re-editing an existing ref.
  initial?: Partial<KeyRefSelection>;
  onCancel: () => void;
  onConfirm: (sel: KeyRefSelection) => void;
};

// Per-row data the picker holds in its list. PVC entries carry storage
// metadata as a hint string; ConfigMap entries have keys; Secret entries
// have keys + a Secret type. The list rendering only reads `name`, `keys`,
// and `hint` so the variants compose cleanly.
type ListEntry = {
  name: string;
  keys: string[];
  hint: string | null;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; entries: ListEntry[] }
  | { kind: "error"; message: string };

export function KeyRefPicker({
  t,
  clusterId,
  namespace,
  kind,
  keyMode: rawKeyMode,
  initial,
  onCancel,
  onConfirm,
}: KeyRefPickerProps) {
  // PVCs have no keys, so the prop can't override the layout.
  const keyMode: "required" | "none" =
    kind === "PersistentVolumeClaim" ? "none" : rawKeyMode ?? "required";
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [selectedName, setSelectedName] = useState<string>(initial?.name ?? "");
  const [selectedKey, setSelectedKey] = useState<string>(initial?.key ?? "");
  const [optional, setOptional] = useState<boolean>(initial?.optional ?? false);
  const [pane, setPane] = useState<"name" | "key">("name");

  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    const fetcher: Promise<
      ConfigMapKeysSummary[] | SecretKeysSummary[] | PvcSummary[]
    > =
      kind === "ConfigMap"
        ? api.listConfigMapsInNamespace(clusterId, namespace)
        : kind === "Secret"
          ? api.listSecretsInNamespace(clusterId, namespace)
          : api.listPvcsInNamespace(clusterId, namespace);
    fetcher
      .then((rows) => {
        if (cancelled) return;
        const entries: ListEntry[] = rows.map((r) => {
          if ("keys" in r) {
            // ConfigMap or Secret summary.
            return {
              name: r.name,
              keys: r.keys,
              hint: "type" in r && r.type !== "" ? r.type : null,
            };
          }
          // PVC summary.
          const parts: string[] = [];
          if (r.requested_storage) parts.push(r.requested_storage);
          if (r.storage_class) parts.push(r.storage_class);
          return {
            name: r.name,
            keys: [],
            hint: parts.length > 0 ? parts.join(" · ") : null,
          };
        });
        setState({ kind: "ready", entries });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [clusterId, namespace, kind]);

  const filtered = useMemo(() => {
    if (state.kind !== "ready") return [] as ListEntry[];
    const q = query.trim().toLowerCase();
    if (q === "") return state.entries;
    return state.entries.filter((e) => {
      if (e.name.toLowerCase().includes(q)) return true;
      return e.keys.some((k) => k.toLowerCase().includes(q));
    });
  }, [state, query]);

  const activeEntry = useMemo(
    () => filtered.find((e) => e.name === selectedName) ?? null,
    [filtered, selectedName],
  );

  // When the visible list changes (e.g. on first load or as the operator
  // types), make sure a name is always selected — pick the first match.
  useEffect(() => {
    if (state.kind !== "ready") return;
    if (filtered.length === 0) return;
    if (!filtered.find((e) => e.name === selectedName)) {
      setSelectedName(filtered[0]!.name);
      setSelectedKey("");
    }
  }, [filtered, selectedName, state.kind]);

  const visibleKeys = useMemo(() => {
    if (!activeEntry) return [] as string[];
    const q = query.trim().toLowerCase();
    if (q === "") return activeEntry.keys;
    if (activeEntry.name.toLowerCase().includes(q)) return activeEntry.keys;
    return activeEntry.keys.filter((k) => k.toLowerCase().includes(q));
  }, [activeEntry, query]);

  // Keep a sane default key when the entry changes.
  useEffect(() => {
    if (!activeEntry) return;
    if (selectedKey === "" || !activeEntry.keys.includes(selectedKey)) {
      setSelectedKey(visibleKeys[0] ?? "");
    }
  }, [activeEntry, selectedKey, visibleKeys]);

  const canConfirm =
    selectedName !== "" && (keyMode === "none" || selectedKey !== "");

  function commit() {
    if (!canConfirm) return;
    onConfirm({
      name: selectedName,
      key: keyMode === "none" ? "" : selectedKey,
      optional: keyMode === "none" ? false : optional,
    });
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === "Tab" && keyMode === "required") {
      e.preventDefault();
      setPane((p) => (p === "name" ? "key" : "name"));
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const onKeyPane = keyMode === "required" && pane === "key";
      if (onKeyPane) {
        const i = visibleKeys.indexOf(selectedKey);
        const next =
          visibleKeys[(i + dir + visibleKeys.length) % Math.max(1, visibleKeys.length)];
        if (next != null) setSelectedKey(next);
      } else {
        const i = filtered.findIndex((x) => x.name === selectedName);
        const next = filtered[(i + dir + filtered.length) % Math.max(1, filtered.length)];
        if (next) {
          setSelectedName(next.name);
          setSelectedKey("");
        }
      }
      return;
    }
    if (keyMode === "required") {
      if (e.key === "ArrowRight" && pane === "name") {
        e.preventDefault();
        setPane("key");
        return;
      }
      if (e.key === "ArrowLeft" && pane === "key") {
        e.preventDefault();
        setPane("name");
      }
    }
  }

  const titleKind =
    kind === "ConfigMap"
      ? "ConfigMap"
      : kind === "Secret"
        ? "Secret"
        : "PersistentVolumeClaim";
  const titleSuffix = keyMode === "required" ? " key" : "";

  return (
    <>
      <div
        onClick={onCancel}
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          left: 0,
          background: "rgba(8,10,14,0.32)",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
          zIndex: 60,
          animation: "fs-fade-in .12s ease",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Pick ${titleKind}${titleSuffix}`}
        onKeyDown={onKey}
        tabIndex={-1}
        style={{
          position: "fixed",
          top: "calc(14% + var(--fs-titlebar-h, 0px))",
          left: "50%",
          transform: "translateX(-50%)",
          width: 640,
          maxWidth: "92vw",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          background: t.paletteBg,
          border: `1px solid ${t.paletteBorder}`,
          borderRadius: R_LG,
          boxShadow: "0 24px 56px rgba(0,0,0,0.25)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          zIndex: 61,
          overflow: "hidden",
          color: t.text,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 18px",
            borderBottom: `1px solid ${t.borderSoft}`,
          }}
        >
          <span style={{ color: t.textMuted, display: "inline-flex" }}>
            {Icons.search}
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Filter ${titleKind.toLowerCase()}s in ${namespace}…`}
            spellCheck={false}
            autoComplete="off"
            style={{
              flex: 1,
              border: 0,
              outline: 0,
              background: "transparent",
              color: t.text,
              fontSize: FS_LG,
              fontFamily: FF_MONO,
            }}
          />
          <span
            style={{
              fontSize: FS_XS,
              fontFamily: FF_MONO,
              color: t.textMuted,
              textTransform: "uppercase",
              letterSpacing: 0.4,
            }}
          >
            {titleKind} · {namespace}
          </span>
        </div>

        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <NamePane
            t={t}
            entries={filtered}
            selected={selectedName}
            onSelect={(n) => {
              setSelectedName(n);
              setSelectedKey("");
              setPane("name");
            }}
            state={state}
            kind={kind}
            // Stretch the name pane to full width when there's no key pane
            // beside it (envFrom / volume sources / PVC).
            wide={keyMode === "none"}
          />
          {keyMode === "required" && (
            <>
              <div style={{ width: 1, background: t.borderSoft }} />
              <KeyPane
                t={t}
                keys={visibleKeys}
                selected={selectedKey}
                onSelect={(k) => {
                  setSelectedKey(k);
                  setPane("key");
                }}
                empty={
                  activeEntry == null
                    ? "Pick a name on the left."
                    : activeEntry.keys.length === 0
                      ? "(no keys)"
                      : "No keys match the filter."
                }
              />
            </>
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 14px",
            borderTop: `1px solid ${t.borderSoft}`,
            background: t.surfaceAlt,
          }}
        >
          {keyMode === "required" ? (
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: FS_MD,
                color: t.textDim,
                cursor: "pointer",
              }}
            >
              <Checkbox t={t} checked={optional} onChange={setOptional} />
              Optional (don't fail if missing)
            </label>
          ) : null}
          <span style={{ flex: 1 }} />
          <Btn t={t} variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Btn>
          <Btn
            t={t}
            variant="primary"
            size="sm"
            onClick={commit}
            disabled={!canConfirm}
            kbd="↵"
          >
            Use this key
          </Btn>
        </div>
      </div>
    </>
  );
}

function NamePane({
  t,
  entries,
  selected,
  onSelect,
  state,
  kind,
  wide,
}: {
  t: Tokens;
  entries: ListEntry[];
  selected: string;
  onSelect: (name: string) => void;
  state: LoadState;
  kind: KeyRefPickerKind;
  // Single-pane layout (no key drilldown) — let the names list stretch.
  wide: boolean;
}) {
  // Pretty-printed kind for empty/loading messages. PVC is the only one
  // that needs the long name; CM/Secret already read fine lowercased.
  const kindWord =
    kind === "PersistentVolumeClaim" ? "PVC" : kind.toLowerCase();
  return (
    <div
      style={{
        flex: wide ? 1 : "0 0 280px",
        overflowY: "auto",
        padding: "6px 0",
      }}
    >
      {state.kind === "loading" && (
        <div style={msgStyle(t)}>Loading {kindWord}s…</div>
      )}
      {state.kind === "error" && (
        <div style={msgStyle(t)}>
          <ErrorBlock
            t={t}
            message={state.message}
            kindLabel={`${kindWord} list`}
            inline
          />
        </div>
      )}
      {state.kind === "ready" && entries.length === 0 && (
        <div style={msgStyle(t)}>No {kindWord}s match the filter.</div>
      )}
      {entries.map((e) => (
        <Row
          key={e.name}
          t={t}
          selected={e.name === selected}
          onClick={() => onSelect(e.name)}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {e.name}
          </span>
          {e.hint && (
            <span style={{ fontSize: FS_XS, opacity: 0.55 }}>{e.hint}</span>
          )}
          {e.keys.length > 0 && (
            <span style={{ fontSize: FS_XS, opacity: 0.6 }}>
              {e.keys.length}
            </span>
          )}
        </Row>
      ))}
    </div>
  );
}

function KeyPane({
  t,
  keys,
  selected,
  onSelect,
  empty,
}: {
  t: Tokens;
  keys: string[];
  selected: string;
  onSelect: (key: string) => void;
  empty: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "6px 0",
        minWidth: 0,
      }}
    >
      {keys.length === 0 ? (
        <div style={msgStyle(t)}>{empty}</div>
      ) : (
        keys.map((k) => (
          <Row
            key={k}
            t={t}
            selected={k === selected}
            onClick={() => onSelect(k)}
          >
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {k}
            </span>
          </Row>
        ))
      )}
    </div>
  );
}

// Row visual mirrors the CommandPalette result row: accentSoft + accent
// text on selection, t.hover on hover, mono font, generous padding.
function Row({
  t,
  selected,
  onClick,
  children,
}: {
  t: Tokens;
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        width: "100%",
        alignItems: "center",
        gap: 10,
        padding: "8px 18px",
        border: 0,
        background: selected ? t.accentSoft : hover ? t.hover : "transparent",
        color: selected ? t.accent : t.text,
        fontFamily: FF_MONO,
        fontSize: FS_MD,
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      {children}
    </button>
  );
}

function msgStyle(t: Tokens): React.CSSProperties {
  return {
    padding: "10px 14px",
    fontSize: FS_SM,
    color: t.textDim,
    fontFamily: FF_MONO,
  };
}
