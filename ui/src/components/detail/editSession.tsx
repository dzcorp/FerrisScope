// Per-panel edit session: every editor inside a detail panel registers its
// partial-patch serializer with the session, then a single `Save (N)`
// across the bottom of the panel deep-merges every dirty editor and fires
// ONE Server-Side Apply request. This replaces the previous flow where
// each editor owned its own `useApply` and saved independently — N edits
// → N round-trips → N conflict surfaces. Now: 1 round-trip, 1 conflict.
//
// Per-row pencils still control whether each row's controls are visible —
// editors call `field.setEditing(true)` on pencil, `false` on Cancel-this-
// row. The session's enter/dirty/save are independent: a row can be dirty
// but no longer "editing" (operator can collapse the row but keep the
// pending change), and the global Save still includes it.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { api } from "../../api";
import type { ApplyResult } from "../../types";
import type { ApplyTarget } from "./edit";

export type ConflictInfo = {
  managers: string[];
  fields: string[];
  message: string;
};

// Callbacks live in a ref so re-renders don't cycle. The dirty bit lives
// in React state (`dirtyMap`) so consumers actually re-render when an
// editor's dirty count crosses zero.
type RegisteredField = {
  serialize: () => Record<string, unknown>;
  reset: () => void;
  validate?: () => string | null;
};

type SessionState = {
  saving: boolean;
  conflict: ConflictInfo | null;
  error: string | null;
};

type EditingMap = Record<string, boolean>;

type SessionApi = {
  target: ApplyTarget;
  // Editor-side: register callbacks (mount/unmount). Returns unregister.
  register(id: string, field: RegisteredField): () => void;
  // Editor-side: tell the session whether this field is currently dirty.
  // Idempotent — same value bails without a re-render.
  setDirty(id: string, dirty: boolean): void;
  // Reactive — components depending on these re-render on state change.
  dirty: number;
  isEditing(id: string): boolean;
  setEditing(id: string, editing: boolean): void;
  saving: boolean;
  conflict: ConflictInfo | null;
  error: string | null;
  saveAll(force?: boolean): Promise<void>;
  cancelAll(): void;
  dismissConflict(): void;
};

const Ctx = createContext<SessionApi | null>(null);

export function useEditSession(): SessionApi | null {
  return useContext(Ctx);
}

// Provider — instantiate one per detail panel. `key` should change with
// the underlying resource so the session resets when the operator
// switches to a different object.
export function EditSessionProvider({
  target,
  onSaved,
  children,
}: {
  target: ApplyTarget;
  // Bumped after a successful save — caller typically increments a
  // refetch counter so the panel re-fetches and re-seeds editor buffers.
  onSaved: () => void;
  children: ReactNode;
}) {
  // Mutable callback registry — editors stash fresh closures here every
  // render so the session always sees the latest serialize / reset /
  // validate. Mutating a ref doesn't trigger renders, which is exactly
  // what we want: closures change on every keystroke; we'd thrash if each
  // one bumped state.
  const fields = useRef(new Map<string, RegisteredField>());

  // Reactive dirty bit per field. Editors call `setDirty(id, true|false)`
  // when their `dirtyCount(buffer) > 0` flips. Bail-on-equal keeps this
  // stable across renders that don't change the dirty bit (typing inside
  // an already-dirty editor doesn't re-render the session bar — only the
  // editor itself).
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});

  const [editing, setEditingMap] = useState<EditingMap>({});
  const [state, setState] = useState<SessionState>({
    saving: false,
    conflict: null,
    error: null,
  });

  const register = useCallback((id: string, field: RegisteredField) => {
    fields.current.set(id, field);
    return () => {
      fields.current.delete(id);
      setDirtyMap((m) => {
        if (!(id in m)) return m;
        const next = { ...m };
        delete next[id];
        return next;
      });
    };
  }, []);

  const setDirty = useCallback((id: string, dirty: boolean) => {
    setDirtyMap((m) => {
      const cur = m[id] === true;
      if (cur === dirty) return m;
      if (!dirty && !(id in m)) return m;
      const next = { ...m, [id]: dirty };
      return next;
    });
  }, []);

  const dirty = useMemo(() => {
    let n = 0;
    for (const v of Object.values(dirtyMap)) if (v) n += 1;
    return n;
  }, [dirtyMap]);

  const isEditing = useCallback((id: string) => editing[id] === true, [editing]);
  const setEditing = useCallback((id: string, ed: boolean) => {
    setEditingMap((m) => {
      if ((m[id] === true) === ed) return m;
      return { ...m, [id]: ed };
    });
  }, []);

  // Snapshot the current dirty map in a ref so saveAll reads the latest
  // value without becoming a dependency of its own callback (otherwise we
  // recreate `saveAll` on every keystroke, which churns the GlobalSaveBar
  // memoisation).
  const dirtyMapRef = useRef(dirtyMap);
  dirtyMapRef.current = dirtyMap;

  const saveAll = useCallback(
    async (force = false) => {
      const dirtyIds = Object.entries(dirtyMapRef.current)
        .filter(([, v]) => v)
        .map(([k]) => k);
      setState({ saving: true, conflict: null, error: null });
      // Validate first — block save if any editor reports a problem.
      for (const id of dirtyIds) {
        const f = fields.current.get(id);
        const v = f?.validate?.();
        if (v) {
          setState({ saving: false, conflict: null, error: v });
          return;
        }
      }
      // Merge every dirty field's partial patch into one tree.
      let payload: Record<string, unknown> = {};
      for (const id of dirtyIds) {
        const f = fields.current.get(id);
        if (!f) continue;
        try {
          payload = mergePatch(payload, f.serialize()) as Record<
            string,
            unknown
          >;
        } catch (e) {
          setState({
            saving: false,
            conflict: null,
            error: `serialize ${id}: ${String(e)}`,
          });
          return;
        }
      }
      try {
        const result: ApplyResult = await api.applyResource(
          target.clusterId,
          target.kindId,
          target.namespace,
          target.name,
          payload,
          force,
        );
        if (result.kind === "applied") {
          // Collapse every edit-mode row. Don't reset buffers — the
          // values they hold are what we just saved; the parent's
          // `onSaved` will trigger a refetch and the new props will
          // re-seed buffers naturally on the next `enter()`. Calling
          // reset() here would race against the parent state update
          // (initialRef still points at the pre-refetch closure).
          setEditingMap({});
          setDirtyMap({});
          setState({ saving: false, conflict: null, error: null });
          onSaved();
        } else {
          setState({
            saving: false,
            conflict: {
              managers: result.managers,
              fields: result.fields,
              message: result.message,
            },
            error: null,
          });
        }
      } catch (e) {
        setState({ saving: false, conflict: null, error: String(e) });
      }
    },
    [target.clusterId, target.kindId, target.namespace, target.name, onSaved],
  );

  const cancelAll = useCallback(() => {
    for (const f of fields.current.values()) f.reset();
    setEditingMap({});
    setDirtyMap({});
    setState({ saving: false, conflict: null, error: null });
  }, []);

  const dismissConflict = useCallback(() => {
    setState((s) => ({ ...s, conflict: null }));
  }, []);

  const value: SessionApi = {
    target,
    register,
    setDirty,
    dirty,
    isEditing,
    setEditing,
    saving: state.saving,
    conflict: state.conflict,
    error: state.error,
    saveAll,
    cancelAll,
    dismissConflict,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ── useEditField ───────────────────────────────────────────────────────────
//
// Editor-side hook. Same lifecycle as the old `useApply` but save / cancel
// come from the session — the local `save()` is just "stop showing my
// controls"; the actual SSA fires from the global bar.

export function useEditField<B>(opts: {
  // Stable id per editor instance. Convention: `<kind>:<container>:<area>`
  // (e.g. `pod:c1:env`, `deploy:replicas`).
  id: string;
  initial: () => B;
  serialize: (buffer: B) => Record<string, unknown>;
  dirtyCount: (buffer: B) => number;
  // Optional pre-flight validator. Returning a non-null string blocks the
  // global save and surfaces in the bar.
  validate?: (buffer: B) => string | null;
}) {
  const session = useEditSession();
  const [buffer, setBuffer] = useState<B>(opts.initial);

  // Refs so the closures we hand to the session always see the latest
  // values without us needing to re-register on every keystroke.
  const initialRef = useRef(opts.initial);
  initialRef.current = opts.initial;
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;
  const serializeRef = useRef(opts.serialize);
  serializeRef.current = opts.serialize;
  const validateRef = useRef(opts.validate);
  validateRef.current = opts.validate;

  const dirty = opts.dirtyCount(buffer);

  // Register callbacks once per (session, id) pair. Cleanup deletes the
  // entry from the registry. Stale closures aren't a risk because each
  // callback reads through a ref.
  useEffect(() => {
    if (!session) return;
    return session.register(opts.id, {
      serialize: () => serializeRef.current(bufferRef.current),
      reset: () => setBuffer(initialRef.current()),
      validate: validateRef.current
        ? () => validateRef.current!(bufferRef.current)
        : undefined,
    });
  }, [session, opts.id]);

  // Push the dirty bit to the session whenever it changes. The session
  // bails on equal so a no-op write here doesn't trigger a re-render of
  // the GlobalSaveBar (or any other consumer of `session.dirty`).
  useEffect(() => {
    if (!session) return;
    session.setDirty(opts.id, dirty > 0);
  }, [session, opts.id, dirty]);

  const editing = session?.isEditing(opts.id) ?? false;

  const enter = useCallback(() => {
    if (!session) return;
    setBuffer(initialRef.current());
    session.setEditing(opts.id, true);
  }, [session, opts.id]);

  const cancel = useCallback(() => {
    if (!session) return;
    setBuffer(initialRef.current());
    session.setEditing(opts.id, false);
  }, [session, opts.id]);

  return {
    buffer,
    setBuffer,
    editing,
    dirty,
    enter,
    cancel,
    // True when the global save is mid-flight — editors can disable
    // controls if they want; most just dim the chrome.
    saving: session?.saving ?? false,
    conflict: session?.conflict ?? null,
    error: session?.error ?? null,
  };
}

// ── mergePatch ─────────────────────────────────────────────────────────────
//
// Deep-merge partial SSA patches. Object keys merge recursively; arrays at
// known K8s listMap paths merge by their merge key (containers.name,
// volumeMounts.mountPath, …). Unknown arrays replace.
//
// Two editors patching the same container thus produce ONE container
// entry with both fields applied: env from one, volumeMounts from the
// other, both keyed by the container's `name`.

const ARRAY_MERGE_KEYS: Record<string, string | null> = {
  // Pod template containers
  containers: "name",
  initContainers: "name",
  ephemeralContainers: "name",
  // Container sub-arrays
  env: "name",
  volumeMounts: "mountPath",
  ports: "containerPort",
  // Pod template volumes / image pull secrets
  volumes: "name",
  imagePullSecrets: "name",
  // envFrom has no merge key — last writer wins. Keep null so our merge
  // appends rather than de-dups by index.
  envFrom: null,
};

export function mergePatch(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) {
    return b;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) {
      const cur = out[k];
      if (Array.isArray(cur) && Array.isArray(v)) {
        const mergeKey = ARRAY_MERGE_KEYS[k];
        out[k] = mergeKey ? mergeListMap(cur, v, mergeKey) : v;
      } else {
        out[k] = mergePatch(cur, v);
      }
    }
    return out;
  }
  return b;
}

function mergeListMap(a: unknown[], b: unknown[], mergeKey: string): unknown[] {
  const out: unknown[] = [...a];
  for (const item of b) {
    if (!isPlainObject(item)) {
      out.push(item);
      continue;
    }
    const k = item[mergeKey];
    const idx = out.findIndex(
      (x) => isPlainObject(x) && x[mergeKey] === k,
    );
    if (idx >= 0) {
      out[idx] = mergePatch(out[idx], item);
    } else {
      out.push(item);
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}
