import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { ConnectionDiagnostics } from "../types";
import type { Tokens } from "../theme";
import { FS_MD, FS_SM } from "../theme";
import { Section, Chip, Btn } from "./ui";
import { Copyable, Mono, Mute } from "./detail/primitives";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: ConnectionDiagnostics };

// Passive, read-only "why can't I connect" surface. Shows the PATH the app
// actually sees, whether the context's exec credential plugin is findable, and
// which cloud/proxy/TLS env vars are present (presence only — never values).
// Mirrors `diagnose_connection_cmd`; never executes the plugin.
export function ConnectionDiagnosticsModal({
  t,
  contextId,
  contextName,
  onClose,
}: {
  t: Tokens;
  /// The composite context id (e.g. "default::prod") — same value passed to
  /// connect. The backend extracts the context name from it.
  contextId: string;
  contextName: string;
  onClose: () => void;
}) {
  const [s, setS] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let live = true;
    setS({ status: "loading" });
    api
      .diagnoseConnection(contextId)
      .then((data) => {
        if (live) setS({ status: "loaded", data });
      })
      .catch((e: unknown) => {
        if (live) setS({ status: "error", message: String(e) });
      });
    return () => {
      live = false;
    };
  }, [contextId]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Connection diagnostics for ${contextName}`}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: t.scrim,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: 10,
          width: "min(640px, 100%)",
          maxHeight: "85vh",
          overflow: "auto",
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: t.text, fontSize: FS_MD, fontWeight: 600 }}>
              Connection diagnostics
            </div>
            <Mute t={t}>{contextName}</Mute>
          </div>
          <Btn t={t} variant="secondary" size="sm" onClick={onClose}>
            Close
          </Btn>
        </div>

        {s.status === "loading" && <Mute t={t}>Inspecting…</Mute>}
        {s.status === "error" && (
          <div style={{ color: t.bad, fontSize: FS_SM }}>{s.message}</div>
        )}
        {s.status === "loaded" && <DiagnosticsBody t={t} data={s.data} />}
      </div>
    </div>,
    document.body,
  );
}

function DiagnosticsBody({ t, data }: { t: Tokens; data: ConnectionDiagnostics }) {
  return (
    <>
      <div>
        <Section t={t} title="Auth plugin" />
        {data.exec ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Copyable text={data.exec.command}>
              <Mono>{data.exec.command}</Mono>
            </Copyable>
            {data.exec.args.length > 0 && (
              <Copyable text={data.exec.args.join(" ")}>
                <Mono style={{ color: t.textDim, fontSize: FS_SM }}>
                  {data.exec.args.join(" ")}
                </Mono>
              </Copyable>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Chip t={t} tone={data.exec.found ? "accent" : "warn"}>
                {data.exec.found ? "found on PATH" : "NOT found on PATH"}
              </Chip>
              {data.exec.resolved_path ? (
                <Copyable text={data.exec.resolved_path}>
                  <Mono style={{ fontSize: FS_SM }}>
                    {data.exec.resolved_path}
                  </Mono>
                </Copyable>
              ) : (
                <Mute t={t}>
                  the app can&apos;t see this binary — it may resolve in your
                  terminal but not when launched from the Dock/.desktop
                </Mute>
              )}
            </div>
          </div>
        ) : (
          <Mute t={t}>
            This context authenticates without an exec credential plugin.
          </Mute>
        )}
      </div>

      <div>
        <Section
          t={t}
          title="PATH"
          right={<Mute t={t}>{`${data.resolved_path.length} entries`}</Mute>}
        />
        <Copyable text={data.resolved_path.join(":")}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {data.resolved_path.map((p, i) => (
              <Mono key={`${p}-${i}`} style={{ fontSize: FS_SM }}>
                {p}
              </Mono>
            ))}
          </div>
        </Copyable>
      </div>

      <div>
        <Section
          t={t}
          title="Environment"
          right={<Mute t={t}>presence only — values never read</Mute>}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {data.env_presence.map((e) => (
            <Chip key={e.key} t={t} mono tone={e.present ? "accent" : "neutral"}>
              {e.present ? "✓ " : "· "}
              {e.key}
            </Chip>
          ))}
        </div>
      </div>
    </>
  );
}
