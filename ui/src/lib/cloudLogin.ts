import { api } from "../api";

// One `gcloud auth login` per account, shared by every note offering it (a
// virtual context's members on one account, two tabs): later Log in clicks
// attach, a clean exit fires `onSuccess` on every subscriber, and the process
// dies with its last subscriber.

/// A login's progress as the notes render it.
export type CloudLoginView = {
  running: boolean;
  /// Tail of gcloud's output, or why it could not start.
  log: string;
};

export type CloudLoginSubscriber = {
  onChange: (view: CloudLoginView) => void;
  /// The login exited 0: the session is renewed.
  onSuccess: () => void;
};

type Run = {
  sessionId: string | null;
  detach: (() => void) | null;
  done: boolean;
};

type Entry = {
  subs: Set<CloudLoginSubscriber>;
  view: CloudLoginView;
  run: Run | null;
};

const IDLE: CloudLoginView = { running: false, log: "" };
/// Progress surface, not a terminal: gcloud's browser-launch line is the part
/// worth seeing.
const LOG_TAIL = 2000;

const entries = new Map<string, Entry>();

/// `null` renews whichever account gcloud has active. An empty string is never
/// a real account (the backend refuses one), so it can stand for that.
function keyOf(account: string | null): string {
  return account ?? "";
}

/// PTY frames arrive base64-encoded. Decoded as UTF-8 so gcloud's URL line
/// survives; a frame that splits a multi-byte sequence degrades to a
/// replacement char rather than throwing.
function decodeB64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function entryFor(key: string): Entry {
  let e = entries.get(key);
  if (!e) {
    e = { subs: new Set(), view: IDLE, run: null };
    entries.set(key, e);
  }
  return e;
}

function publish(e: Entry, view: CloudLoginView): void {
  e.view = view;
  for (const s of [...e.subs]) s.onChange(view);
}

function prune(key: string, e: Entry): void {
  if (e.subs.size === 0 && !e.run && entries.get(key) === e) entries.delete(key);
}

/// Close the backend session — not merely detach the channel: the registry
/// keeps its entry otherwise, which leaks the gcloud child and keeps the
/// terminal token slot from ever being reclaimed. A null id means the open ack
/// hasn't landed; its handler sees `done` and closes then.
function release(run: Run): void {
  run.detach?.();
  run.detach = null;
  if (run.sessionId) {
    void api.terminalClose(run.sessionId).catch(() => {});
    run.sessionId = null;
  }
}

function stop(e: Entry): void {
  const run = e.run;
  if (!run) return;
  run.done = true;
  e.run = null;
  release(run);
  publish(e, { running: false, log: e.view.log });
}

/// Follow the login for `account`, whether or not one is running. `onChange`
/// fires immediately with the current view. Returns the unsubscribe.
export function subscribeCloudLogin(
  account: string | null,
  sub: CloudLoginSubscriber,
): () => void {
  const key = keyOf(account);
  const e = entryFor(key);
  e.subs.add(sub);
  sub.onChange(e.view);
  return () => {
    e.subs.delete(sub);
    if (e.subs.size === 0) stop(e);
    prune(key, e);
  };
}

/// Start the login for `account`, or attach to the one already running.
/// `clusterId` only labels the session's owner, so a disconnect of that
/// cluster closes it too.
export function startCloudLogin(clusterId: string, account: string | null): void {
  const key = keyOf(account);
  const e = entryFor(key);
  if (e.run) return;
  const run: Run = { sessionId: null, detach: null, done: false };
  e.run = run;
  publish(e, { running: true, log: "" });
  api
    .cloudLoginOpen(
      clusterId,
      account,
      (b64) => {
        if (run.done) return;
        publish(e, {
          running: true,
          log: (e.view.log + decodeB64(b64)).slice(-LOG_TAIL),
        });
      },
      (code) => {
        if (run.done) return;
        run.done = true;
        e.run = null;
        release(run);
        if (code === 0) {
          publish(e, IDLE);
          for (const s of [...e.subs]) s.onSuccess();
        } else {
          publish(e, {
            running: false,
            log: `${e.view.log}\n[gcloud exited with code ${code}]`.trim(),
          });
        }
        prune(key, e);
      },
    )
    .then((session) => {
      // The ack can arrive after the run already ended: the exit frame
      // outran it (a spawn that died instantly), or every subscriber left.
      if (run.done) {
        session.close();
        void api.terminalClose(session.sessionId).catch(() => {});
        return;
      }
      run.sessionId = session.sessionId;
      run.detach = session.close;
    })
    .catch((err: unknown) => {
      if (run.done) return;
      run.done = true;
      e.run = null;
      publish(e, { running: false, log: String(err) });
      prune(key, e);
    });
}

/// Kill the login for `account` for every subscriber — it is one process.
export function cancelCloudLogin(account: string | null): void {
  const e = entries.get(keyOf(account));
  if (e) stop(e);
}
