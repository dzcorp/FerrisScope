import { useEffect, useState } from "react";
import { useResolvedTheme } from "../../store";
import { api } from "../../api";
import type { HelmDetection, KubectlDetection } from "../../types";
import {
  FF_MONO,
  type ThemeMode,
  type Tokens,
  R_MD,
  FS_SM,
} from "../../theme";
import { Btn, Field, SectionHeader } from "../ui";

// ToolsSection — manage third-party CLI binaries the operator's machine
// needs but FerrisScope can't ship in-process. Today: kubectl and helm. The
// managed install lives under <config>/bin/, which the embedded terminal
// prepends to $PATH for child processes. On macOS we additionally prepend
// <config>/bin/ to the FerrisScope process's own $PATH at startup
// (`augment_macos_path`), so even non-terminal call sites (e.g. the agent's
// `helm install`/`helm uninstall` tools) resolve the managed binary.
export function ToolsSection({}: { mode: ThemeMode }) {
  const t = useResolvedTheme().tokens;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <SectionHeader
        t={t}
        title="Tools"
        sub="Manage third-party CLIs FerrisScope spawns from the embedded terminal and the agent."
      />

      <ToolRow
        t={t}
        label="kubectl"
        hint="Downloaded from dl.k8s.io and SHA-256 verified. Stored under FerrisScope's config directory; preferred over $PATH for in-app terminal sessions."
        getStatus={() => api.kubectlGetStatus()}
        install={() => api.kubectlInstallManaged()}
        uninstall={() => api.kubectlUninstallManaged()}
        toolDisplayName="kubectl"
      />

      <ToolRow
        t={t}
        label="helm"
        hint="Downloaded from get.helm.sh and SHA-256 verified. macOS GUI apps don't inherit the shell's $PATH, so Homebrew-installed helm is invisible to FerrisScope by default — a managed install fixes that."
        getStatus={() => api.helmGetStatus()}
        install={() => api.helmInstallManaged()}
        uninstall={() => api.helmUninstallManaged()}
        toolDisplayName="helm"
      />
    </div>
  );
}

// Generic row for one managed CLI. The detection / install / uninstall
// surface is identical between kubectl and helm — only the wire calls and
// display name differ.
function ToolRow({
  t,
  label,
  hint,
  getStatus,
  install,
  uninstall,
  toolDisplayName,
}: {
  t: Tokens;
  label: string;
  hint: string;
  getStatus: () => Promise<KubectlDetection | HelmDetection>;
  install: () => Promise<{ version: string; path: string }>;
  uninstall: () => Promise<void>;
  toolDisplayName: string;
}) {
  const [status, setStatus] = useState<
    KubectlDetection | HelmDetection | null
  >(null);
  const [busy, setBusy] = useState<"install" | "uninstall" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setStatus(await getStatus());
    } catch (e) {
      setMsg(String(e));
    }
  };
  useEffect(() => {
    refresh();
    // refresh is a fresh closure each render; we deliberately run once on
    // mount and re-trigger via the Recheck button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onInstall = async () => {
    setBusy("install");
    setMsg(null);
    try {
      const r = await install();
      setMsg(`Installed ${toolDisplayName} ${r.version} → ${r.path}`);
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
      await uninstall();
      setMsg(`Removed managed ${toolDisplayName}.`);
      await refresh();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Field t={t} label={label} hint={hint}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div
          style={{
            fontFamily: FF_MONO,
            fontSize: FS_SM,
            color: t.text,
            padding: "6px 8px",
            background: t.surfaceAlt,
            border: `1px solid ${t.borderSoft}`,
            borderRadius: R_MD,
          }}
        >
          {statusLine(status)}
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
              : status?.kind === "managed"
                ? "Reinstall latest"
                : "Install latest"}
          </Btn>
          {status?.kind === "managed" && (
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
              fontSize: FS_SM,
              fontFamily: FF_MONO,
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
  );
}

function statusLine(d: KubectlDetection | HelmDetection | null): string {
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
