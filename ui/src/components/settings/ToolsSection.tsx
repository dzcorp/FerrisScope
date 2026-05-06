import { useEffect, useState } from "react";
import { api } from "../../api";
import type { KubectlDetection } from "../../types";
import { tokens, FONT_MONO, type ThemeMode } from "../../theme";
import { Btn, Field, SectionHeader } from "../ui";

// ToolsSection — manage third-party CLI binaries the operator's machine
// needs but FerrisScope can't ship in-process. Today: kubectl. The managed
// install lives under <config>/bin/, which the embedded terminal prepends
// to $PATH for child processes — meaning a managed kubectl is picked up
// transparently by every kubectl / exec / shell tab.
export function ToolsSection({ mode }: { mode: ThemeMode }) {
  const t = tokens(mode);
  const [kubectl, setKubectl] = useState<KubectlDetection | null>(null);
  const [busy, setBusy] = useState<"install" | "uninstall" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setKubectl(await api.kubectlGetStatus());
    } catch (e) {
      setMsg(String(e));
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const onInstall = async () => {
    setBusy("install");
    setMsg(null);
    try {
      const r = await api.kubectlInstallManaged();
      setMsg(`Installed kubectl ${r.version} → ${r.path}`);
      await refresh();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  const onUninstall = async () => {
    setBusy("uninstall");
    setMsg(null);
    try {
      await api.kubectlUninstallManaged();
      setMsg("Removed managed kubectl.");
      await refresh();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <SectionHeader
        t={t}
        title="Tools"
        sub="Manage third-party CLIs FerrisScope spawns from the embedded terminal."
      />

      <Field
        t={t}
        label="kubectl"
        hint="Downloaded from dl.k8s.io and SHA-256 verified. Stored under FerrisScope's config directory; preferred over $PATH for in-app terminal sessions."
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div
            style={{
              fontFamily: FONT_MONO,
              fontSize: 11,
              color: t.text,
              padding: "6px 8px",
              background: t.surfaceAlt,
              border: `1px solid ${t.borderSoft}`,
              borderRadius: 4,
            }}
          >
            {kubectlStatusLine(kubectl)}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Btn
              t={t}
              variant="primary"
              size="sm"
              onClick={onInstall}
              disabled={busy !== null}
            >
              {busy === "install"
                ? "Installing…"
                : kubectl?.kind === "managed"
                  ? "Reinstall latest"
                  : "Install latest"}
            </Btn>
            {kubectl?.kind === "managed" && (
              <Btn
                t={t}
                variant="ghost"
                size="sm"
                onClick={onUninstall}
                disabled={busy !== null}
              >
                {busy === "uninstall" ? "Removing…" : "Remove"}
              </Btn>
            )}
            <Btn
              t={t}
              variant="ghost"
              size="sm"
              onClick={() => {
                setMsg(null);
                refresh();
              }}
              disabled={busy !== null}
            >
              Recheck
            </Btn>
          </div>
          {msg && (
            <div
              style={{
                fontSize: 11,
                fontFamily: FONT_MONO,
                color:
                  msg.startsWith("Installed") || msg.startsWith("Removed")
                    ? t.good
                    : t.bad,
                wordBreak: "break-word",
              }}
            >
              {msg}
            </div>
          )}
        </div>
      </Field>
    </div>
  );
}

function kubectlStatusLine(d: KubectlDetection | null): string {
  if (!d) return "Checking…";
  switch (d.kind) {
    case "configured":
      return d.exists
        ? `Configured: ${d.path}`
        : `Configured (missing on disk): ${d.path}`;
    case "managed":
      return d.version
        ? `Managed install: ${d.path} (${d.version})`
        : `Managed install: ${d.path}`;
    case "on_path":
      return `Found on $PATH: ${d.path}`;
    case "missing":
      return "Not installed — click Install to download the latest stable release.";
  }
}
