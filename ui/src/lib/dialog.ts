// Imperative wrappers around the modal / toast slots in the store. Use these
// from anywhere — including non-React callbacks — instead of window.confirm /
// window.alert.

import { useAppStore } from "../store";
import type { Toast, ToastTone } from "../store";

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

function emit(tone: ToastTone, text: string, durationMs?: number): string {
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
    durationMs: durationMs ?? DEFAULT_TOAST_MS[tone],
  };
  useAppStore.getState().pushToast(toast);
  return id;
}

export const toast = {
  info: (text: string, durationMs?: number) => emit("info", text, durationMs),
  ok: (text: string, durationMs?: number) => emit("ok", text, durationMs),
  warn: (text: string, durationMs?: number) => emit("warn", text, durationMs),
  bad: (text: string, durationMs?: number) => emit("bad", text, durationMs),
  dismiss: (id: string) => useAppStore.getState().dismissToast(id),
};
