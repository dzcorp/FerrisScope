// Imperative wrappers around the modal / toast slots in the store. Use these
// from anywhere — including non-React callbacks — instead of window.confirm /
// window.alert.

import { useAppStore } from "../store";
import type { Toast, ToastTone } from "../store";
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
/// panel — see `Toast.route`.
export type ToastOptions = {
  durationMs?: number;
  route?: SettingsTarget;
};

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
