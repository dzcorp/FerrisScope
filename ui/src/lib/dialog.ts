// Imperative wrappers around the modal / toast slots in the store. Use these
// from anywhere — including non-React callbacks — instead of window.confirm /
// window.alert.

import { useAppStore } from "../store";
import type { NotificationMeta, Toast, ToastTone } from "../store";
import type { SettingsTarget } from "../types";

export type ConfirmOpts = {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // "danger" gives the primary button the bad-tone color (Delete, etc.).
  tone?: "neutral" | "danger";
};

let nextId = 1;
const makeId = () => `m${nextId++}`;

export function confirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    useAppStore.getState().pushModal({
      id: makeId(),
      title: opts.title,
      body: opts.body,
      confirmLabel: opts.confirmLabel ?? "Confirm",
      cancelLabel: opts.cancelLabel ?? "Cancel",
      tone: opts.tone ?? "neutral",
      resolve,
    });
  });
}

const DEFAULT_TOAST_MS: Record<ToastTone, number> = {
  ok: 3500,
  info: 4000,
  warn: 6000,
  bad: 0, // sticky — operator must dismiss
};

/// Extra, optional toast behaviour. `route` deep-links the toast (and its
/// notification-log entry) to a Settings target instead of the notifications
/// panel — see `Toast.route`. `meta` carries structured context for the
/// NotificationsPanel's expanded row (see `Toast.meta`); the active kube
/// context/cluster is auto-captured when the caller doesn't supply them.
export type ToastOptions = {
  durationMs?: number;
  route?: SettingsTarget;
  meta?: NotificationMeta;
};

// Merge the caller's `meta` over the active kube context/cluster resolved from
// the live store. Caller-supplied fields win. Returns `undefined` when nothing
// is populated so plain toasts stay meta-free (no expand affordance, existing
// tests/rows unchanged). Kept side-effect free beyond the one `getState()` read
// so it's callable from any (non-React) context, like the rest of this module.
function resolveMeta(callerMeta?: NotificationMeta): NotificationMeta | undefined {
  const s = useAppStore.getState();
  const active =
    s.selectedContext != null
      ? (s.contexts.find((c) => c.id === s.selectedContext) ?? null)
      : null;
  const merged: NotificationMeta = {
    context: callerMeta?.context ?? active?.name ?? undefined,
    cluster: callerMeta?.cluster ?? active?.cluster ?? undefined,
    namespace: callerMeta?.namespace ?? undefined,
    kind: callerMeta?.kind ?? undefined,
    name: callerMeta?.name ?? undefined,
    reason: callerMeta?.reason ?? undefined,
    extra: callerMeta?.extra,
  };
  const hasField =
    merged.context != null ||
    merged.cluster != null ||
    merged.namespace != null ||
    merged.kind != null ||
    merged.name != null ||
    merged.reason != null ||
    (merged.extra?.length ?? 0) > 0;
  return hasField ? merged : undefined;
}

function emit(tone: ToastTone, text: string, opts?: ToastOptions): string {
  const id = makeId();
  // Header strip can only render one line — split multi-line input so the
  // first line stays the headline and the rest moves into `body`, which is
  // visible in the NotificationsPanel. Existing call sites that pass
  // `${headline}\n${detail}` strings keep working without per-site edits.
  const newline = text.indexOf("\n");
  const headline = newline >= 0 ? text.slice(0, newline) : text;
  const body = newline >= 0 ? text.slice(newline + 1) : undefined;
  const toast: Toast = {
    id,
    tone,
    text: headline,
    body,
    durationMs: opts?.durationMs ?? DEFAULT_TOAST_MS[tone],
    route: opts?.route,
    meta: resolveMeta(opts?.meta),
  };
  useAppStore.getState().pushToast(toast);
  return id;
}

// Back-compat: callers may pass a bare `durationMs` number (legacy) or a
// `ToastOptions` object. Normalise to options.
function toOptions(arg?: number | ToastOptions): ToastOptions | undefined {
  return typeof arg === "number" ? { durationMs: arg } : arg;
}

export const toast = {
  info: (text: string, arg?: number | ToastOptions) =>
    emit("info", text, toOptions(arg)),
  ok: (text: string, arg?: number | ToastOptions) =>
    emit("ok", text, toOptions(arg)),
  warn: (text: string, arg?: number | ToastOptions) =>
    emit("warn", text, toOptions(arg)),
  bad: (text: string, arg?: number | ToastOptions) =>
    emit("bad", text, toOptions(arg)),
  dismiss: (id: string) => useAppStore.getState().dismissToast(id),
};
