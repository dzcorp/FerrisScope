import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ConnectHint } from "../types";
import type { Tokens } from "../theme";
import { FS_SM } from "../theme";
import { Btn, Chip } from "./ui";
import { Copyable, Mono } from "./detail/primitives";
import { IdentityPicker } from "./IdentityPicker";
import { CloudIdentityModal } from "./CloudIdentityPanel";
import {
  cancelCloudLogin,
  startCloudLogin,
  subscribeCloudLogin,
  type CloudLoginView,
} from "../lib/cloudLogin";

// Small amber note under a failed connect, shown when the backend recognises the
// cause as a cloud-credential problem:
//
//   * identity drift — an unpinned context authenticating as whichever identity
//     the cloud CLI last selected. Remedy: a pin.
//   * a refused pin — a pinned context whose identity got a 403, which may be
//     the wrong identity pinned. Remedy: a repin.
//   * a lapsed session — the plugin needs an identity challenge. Remedy: an
//     interactive login, shared per account (`lib/cloudLogin.ts`).
//   * a blocked plugin — the OS refused to execute the plugin's helper. Remedy:
//     a privacy grant or a quarantine strip.
//
// Provider-neutral: every string that differs between providers arrives in the
// hint, and the backend decides which case this is. Renders nothing for null.
export function CloudIdentityNote({
  t,
  contextId,
  contextName,
  reason,
  onReconnect,
}: {
  t: Tokens;
  /// Composite context id (e.g. "default::prod") — the same value passed to
  /// connect. The backend extracts the context name from it.
  contextId: string;
  /// Display name for the "switch identity" dialog's subtitle.
  contextName?: string;
  /// The connect error, verbatim. The backend parses the authenticated identity
  /// out of it, so it must not be pre-cleaned.
  reason: string;
  /// Called once the note has fixed the cause — a pin, or a login that renewed
  /// the session — so the caller can retry. The enclosing banner's Reconnect
  /// uses the same callback, which is why this note offers no retry of its own.
  onReconnect: () => void;
}) {
  const [hint, setHint] = useState<ConnectHint | null>(null);
  const [login, setLogin] = useState<CloudLoginView>({ running: false, log: "" });
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const reconnectRef = useRef(onReconnect);
  reconnectRef.current = onReconnect;

  useEffect(() => {
    let live = true;
    setHint(null);
    setSettingsError(null);
    setSwitching(false);
    api
      .connectHint(contextId, reason)
      .then((h) => {
        if (live) setHint(h);
      })
      .catch(() => {
        // A failed hint lookup must never replace the real connect error.
        if (live) setHint(null);
      });
    return () => {
      live = false;
    };
  }, [contextId, reason]);

  // Follow this account's login even when another note started it, so one
  // browser round trip reconnects every cluster waiting on the same account.
  const reauth = hint?.reauth ?? null;
  useEffect(() => {
    if (!reauth) return;
    return subscribeCloudLogin(reauth.account, {
      onChange: setLogin,
      onSuccess: () => reconnectRef.current(),
    });
  }, [reauth]);

  if (!hint) return null;

  const pin = hint.pin;

  return (
    <div
      role="note"
      style={{
        marginTop: 8,
        padding: "8px 10px",
        borderRadius: "var(--fs-radius-md, 6px)",
        background: t.warnSoft,
        border: `1px solid ${t.warn}`,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: FS_SM,
      }}
    >
      <div style={{ color: t.warn, fontWeight: 600 }}>{hint.title}</div>
      <div style={{ color: t.text }}>{hint.detail}</div>

      {hint.authenticated_as && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: t.textDim }}>apiserver saw</span>
          <Chip t={t} tone="warn" mono>
            {hint.authenticated_as}
          </Chip>
          {hint.pinned_identity ? (
            <>
              <span style={{ color: t.textDim }}>· pinned</span>
              <Chip t={t} mono>
                {hint.pinned_identity}
              </Chip>
            </>
          ) : (
            hint.active_identity && (
              <>
                <span style={{ color: t.textDim }}>· CLI active</span>
                <Chip t={t} mono>
                  {hint.active_identity}
                </Chip>
              </>
            )
          )}
        </div>
      )}

      {/* A lapsed session, not drift: nothing for a pin to write. The login
          runs in one of our PTYs because gcloud won't do an identity challenge
          without a terminal; the command stays copyable for operators who'd
          rather run it themselves. */}
      {reauth && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Copyable text={reauth.command}>
            <Mono>{reauth.command}</Mono>
          </Copyable>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <Btn
              t={t}
              variant="primary"
              size="sm"
              disabled={login.running}
              onClick={() => startCloudLogin(reauth.account)}
            >
              {login.running ? "Waiting for browser…" : "Log in"}
            </Btn>
            {login.running && (
              <Btn
                t={t}
                variant="secondary"
                size="sm"
                onClick={() => cancelCloudLogin(reauth.account)}
              >
                Cancel
              </Btn>
            )}
            {/* The session may belong to the wrong identity altogether. */}
            {!login.running && (
              <Btn
                t={t}
                variant="ghost"
                size="sm"
                onClick={() => setSwitching(true)}
              >
                Switch identity…
              </Btn>
            )}
            <span style={{ color: t.textDim }}>
              {login.running
                ? "finish the sign-in in your browser"
                : "opens your browser, then reconnects on its own"}
            </span>
          </div>
          {/* gcloud's own output, verbatim — when it fails, the only place the
              reason exists. */}
          {login.log && (
            <pre
              style={{
                margin: 0,
                padding: "6px 8px",
                maxHeight: 120,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                borderRadius: "var(--fs-radius-sm, 4px)",
                background: t.bg,
                color: t.textDim,
                fontFamily: "var(--fs-font-mono, monospace)",
                fontSize: FS_SM,
              }}
            >
              {login.log}
            </pre>
          )}
        </div>
      )}

      {/* The OS refused to execute the plugin's helper (macOS TCC or a
          quarantine xattr) — nothing for a pin or a login to fix. The button
          lands on the Files-and-Folders privacy pane; the xattr command stays
          copyable for the quarantine case, same shape as the reauth command
          above. */}
      {hint.unblock && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {hint.unblock.command && (
            <Copyable text={hint.unblock.command}>
              <Mono>{hint.unblock.command}</Mono>
            </Copyable>
          )}
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <Btn
              t={t}
              variant="primary"
              size="sm"
              onClick={() => {
                setSettingsError(null);
                api.openPrivacySettings().catch((e: unknown) => {
                  setSettingsError(String(e));
                });
              }}
            >
              Open Privacy Settings
            </Btn>
            {/* macOS fixes a process's file-access rights at launch, so a grant
                made now never reaches this instance — reconnecting refuses
                identically and the operator concludes the grant failed. It has
                to be a full quit-and-reopen: an in-app relaunch spawns the
                replacement as this process's child, and TCC judges a child by
                its responsible process, so the stale decision is inherited.
                Said as text rather than offered as a button, because no button
                we can implement actually escapes it. */}
            <span style={{ color: t.textDim }}>
              allow FerrisScope under Files and Folders, then <b>quit
              FerrisScope completely and open it again</b> — macOS only applies
              a new grant to a freshly launched app, so reconnecting (or
              restarting from inside the app) keeps failing
            </span>
          </div>
          {settingsError && (
            <div style={{ color: t.bad }}>{settingsError}</div>
          )}
        </div>
      )}

      {pin && (
        <IdentityPicker
          key={`${contextId}\n${reason}`}
          t={t}
          contextId={contextId}
          identities={hint.identities}
          pinned={hint.pinned_identity}
          suggested={hint.suggested_identity}
          offer={pin}
          onPinned={onReconnect}
        />
      )}

      {switching && (
        <CloudIdentityModal
          t={t}
          contextId={contextId}
          contextName={contextName ?? contextId}
          onPinned={() => {
            setSwitching(false);
            onReconnect();
          }}
          onClose={() => setSwitching(false)}
        />
      )}
    </div>
  );
}
