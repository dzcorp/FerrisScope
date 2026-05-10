import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, onPrometheusChanged } from "../api";
import type { ReleaseInfo, SettingsSectionId, UpdaterInfo } from "../types";
import { useAppStore, selectUpdateAvailable, semverGt } from "../store";
import {
  tokens,
  FONT_MONO,
  UI_SCALE_DEFAULT,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  type ThemeMode,
  type Tokens,
} from "../theme";
import { toast } from "../lib/dialog";
import type {
  KubeconfigSettings,
  KubeconfigSource,
  PromCacheEntry,
  PromTarget,
  SshAuthInput,
  SshSourceInput,
} from "../types";
import {
  BrandMark,
  Btn,
  ErrorBlock,
  Field,
  IconBtn,
  Icons,
  SectionHeader,
  Select,
  Toggle,
  Kbd,
  Tooltip,
} from "./ui";
import { MOD_KEY, SHIFT_KEY, ALT_KEY } from "../lib/keyboard";
import { AiSection } from "./settings/AiSection";
import { ToolsSection } from "./settings/ToolsSection";

// Re-export from `types.ts` so the rest of the app uses one canonical
// `SettingsSectionId` (the store typed `openSettings(target)` against
// the same alias).
type SectionId = SettingsSectionId;

/// Tab the panel lands on when the operator opens it without a deep-link
/// (title-bar Settings icon, ⌘, , command palette). Stays on this tab
/// across opens — the panel doesn't persist last-active because the
/// title-bar button has the same affordance regardless of how the
/// previous open ended, which is what most operators expect from a
/// global settings entry-point.
const DEFAULT_SECTION: SectionId = "general";

type Props = {
  mode: ThemeMode;
  onClose: () => void;
};

// HV2Settings — slide-in side panel with categorized side-tabs. Settings
// changes are persisted to the store immediately; the panel closes via the
// title-bar X or Esc.
export function SettingsPanel({ mode, onClose }: Props) {
  const t = tokens(mode);
  const [active, setActive] = useState<SectionId>(DEFAULT_SECTION);
  // Background-checker says a newer release is out and the user hasn't
  // skipped this exact version yet → light up the dot on the About entry.
  const updateAvailable = useAppStore(selectUpdateAvailable);
  // Pending anchor → applied once the target tab has rendered. Cleared
  // after one application so re-renders don't re-scroll the operator.
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // On every open of the panel, consume any deep-link target the caller
  // pushed through `openSettings({ section, anchor })`. The pointer is
  // cleared inside the consume call so a follow-up bare `openSettings()`
  // (e.g. ⌘,) doesn't re-jump to the same anchor.
  const consumeSettingsTarget = useAppStore((s) => s.consumeSettingsTarget);
  useEffect(() => {
    const target = consumeSettingsTarget();
    if (!target) return;
    setActive(target.section);
    setPendingAnchor(target.anchor ?? null);
    // We deliberately run only once per panel mount — `settingsOpen`
    // toggling false → true unmounts and remounts this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After the active tab renders, scroll the matching anchor into view
  // and pulse it. Two-frame delay so the section's own mount effects
  // (which often kick off `useEffect` data fetches) settle before we
  // measure layout.
  useEffect(() => {
    if (!pendingAnchor) return;
    const body = bodyRef.current;
    if (!body) return;
    let cancelled = false;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      if (cancelled) return;
      raf2 = requestAnimationFrame(() => {
        if (cancelled) return;
        const el = body.querySelector<HTMLElement>(
          `[data-fs-anchor="${pendingAnchor}"]`,
        );
        if (el) {
          el.scrollIntoView({ block: "start", behavior: "smooth" });
          // Visual nudge so the operator notices the landing target
          // instead of just looking at "yet another row". The CSS
          // animation is defined in `index.css` (`fs-anchor-pulse`).
          el.classList.add("fs-anchor-pulse");
          window.setTimeout(() => {
            el.classList.remove("fs-anchor-pulse");
          }, 1200);
        }
        setPendingAnchor(null);
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [pendingAnchor, active]);

  const sections: { id: SectionId; label: string }[] = [
    { id: "general", label: "General" },
    { id: "appearance", label: "Appearance" },
    { id: "kubeconfig", label: "Kubeconfig" },
    { id: "observability", label: "Observability" },
    { id: "ai", label: "AI" },
    { id: "tools", label: "Tools" },
    { id: "shortcuts", label: "Shortcuts" },
    { id: "about", label: "About" },
  ];

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          left: 0,
          background: t.scrim,
          zIndex: 36,
          animation: "fs-fade-in .15s ease",
        }}
      />
      <div
        style={{
          position: "fixed",
          top: "var(--fs-titlebar-h, 0px)",
          right: 0,
          bottom: 0,
          width: 760,
          maxWidth: "95vw",
          background: t.surface,
          borderLeft: `1px solid ${t.border}`,
          boxShadow:
            mode === "dark"
              ? "-12px 0 32px rgba(0,0,0,0.4)"
              : "-12px 0 32px rgba(15,20,30,0.12)",
          display: "flex",
          flexDirection: "column",
          zIndex: 37,
          animation: "fs-slide-from-right .22s cubic-bezier(.2,.7,.2,1)",
        }}
      >
        <div
          style={{
            padding: "16px 22px",
            borderBottom: `1px solid ${t.borderSoft}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              letterSpacing: -0.2,
              color: t.text,
            }}
          >
            Settings
          </div>
          <IconBtn t={t} title="Close (Esc)" onClick={onClose}>
            {Icons.close}
          </IconBtn>
        </div>

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div
            style={{
              width: 180,
              borderRight: `1px solid ${t.borderSoft}`,
              padding: "14px 10px",
              display: "flex",
              flexDirection: "column",
              gap: 1,
              background: t.surfaceAlt,
            }}
          >
            {sections.map((s) => {
              const isActive = active === s.id;
              const showDot = s.id === "about" && updateAvailable;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setActive(s.id)}
                  title={
                    showDot
                      ? "A newer FerrisScope release is available"
                      : undefined
                  }
                  style={{
                    padding: "7px 12px",
                    borderRadius: 6,
                    border: "none",
                    background: isActive ? t.surface : "transparent",
                    color: isActive ? t.text : t.textDim,
                    fontFamily: "inherit",
                    fontSize: 12.5,
                    fontWeight: isActive ? 600 : 500,
                    textAlign: "left",
                    cursor: "pointer",
                    boxShadow: isActive ? `0 0 0 1px ${t.borderSoft}` : "none",
                    transition: "background .12s",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span>{s.label}</span>
                  {showDot && (
                    <span
                      aria-label="Update available"
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        background: t.accent,
                        flexShrink: 0,
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>

          <div
            ref={bodyRef}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "22px 28px 28px",
              // Provide a positioning context so absolutely-positioned
              // children inside sections don't escape the scroll
              // container — and so smooth-scrolling lands cleanly when
              // we use `scrollIntoView`.
              position: "relative",
              scrollBehavior: "smooth",
            }}
          >
            {active === "general" && <GeneralSection mode={mode} />}
            {active === "appearance" && <AppearanceSection mode={mode} />}
            {active === "kubeconfig" && <KubeconfigSection mode={mode} />}
            {active === "observability" && <ObservabilitySection mode={mode} />}
            {active === "ai" && <AiSection mode={mode} />}
            {active === "tools" && <ToolsSection mode={mode} />}
            {active === "shortcuts" && <ShortcutsSection mode={mode} />}
            {active === "about" && <AboutSection mode={mode} />}
          </div>
        </div>
      </div>
    </>
  );
}

function GeneralSection({ mode }: { mode: ThemeMode }) {
  const t = tokens(mode);
  const settings = useAppStore((s) => s.settings);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const autoCheckEnabled = useAppStore(
    (s) => s.updateState.autoCheckEnabled,
  );
  const patchUpdateState = useAppStore((s) => s.patchUpdateState);

  return (
    <div>
      <SectionHeader
        t={t}
        title="General"
        sub="Default behaviour across clusters and resources."
      />
      <Field
        t={t}
        label="Refresh interval"
        hint="How often resource lists refetch from the API server. Watches stay live regardless."
      >
        <Select<number>
          t={t}
          value={settings.refreshSec}
          onChange={(v) => patchSettings({ refreshSec: v })}
          options={[
            { value: 0, label: "Manual only" },
            { value: 5, label: "Every 5 seconds" },
            { value: 15, label: "Every 15 seconds" },
            { value: 30, label: "Every 30 seconds" },
            { value: 60, label: "Every minute" },
          ]}
        />
      </Field>
      <Field
        t={t}
        label="Confirm destructive actions"
        hint="Require typed confirmation before deleting, draining, or applying to production. P4."
      >
        <Toggle
          t={t}
          checked={settings.confirmDestructive}
          onChange={(v) => patchSettings({ confirmDestructive: v })}
          label={settings.confirmDestructive ? "Enabled" : "Disabled"}
        />
      </Field>
      <Field
        t={t}
        label="Show system namespaces"
        hint="Include kube-system, kube-public, and similar in the namespace picker."
      >
        <Toggle
          t={t}
          checked={settings.showSystemNs}
          onChange={(v) => patchSettings({ showSystemNs: v })}
          label={settings.showSystemNs ? "Visible" : "Hidden"}
        />
      </Field>
      <Field
        t={t}
        label="Check for updates automatically"
        hint="Marks the About entry when a newer release is out."
      >
        <Toggle
          t={t}
          checked={autoCheckEnabled}
          onChange={(v) => patchUpdateState({ autoCheckEnabled: v })}
          label={autoCheckEnabled ? "Enabled" : "Disabled"}
        />
      </Field>
    </div>
  );
}

function AppearanceSection({ mode }: { mode: ThemeMode }) {
  const t = tokens(mode);
  const settings = useAppStore((s) => s.settings);
  const patchSettings = useAppStore((s) => s.patchSettings);
  const themeMode = useAppStore((s) => s.themeMode);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const railMode = useAppStore((s) => s.railMode);
  const setRailMode = useAppStore((s) => s.setRailMode);
  const bumpUiScale = useAppStore((s) => s.bumpUiScale);
  const resetUiScale = useAppStore((s) => s.resetUiScale);
  const uiScalePct = Math.round(settings.uiScale * 100);
  const atMin = settings.uiScale <= UI_SCALE_MIN + 1e-6;
  const atMax = settings.uiScale >= UI_SCALE_MAX - 1e-6;
  const atDefault = Math.abs(settings.uiScale - UI_SCALE_DEFAULT) < 1e-6;

  return (
    <div>
      <SectionHeader
        t={t}
        title="Appearance"
        sub="Density and theme. Identifiers always render in mono per design rule R-07."
      />
      <Field
        t={t}
        label="Theme"
        hint="Light is calmer for daytime; dark is easier on the eyes during incidents."
      >
        <div style={{ display: "flex", gap: 6 }}>
          {(["light", "dark"] as const).map((v) => {
            const isActive = themeMode === v;
            return (
              <button
                key={v}
                type="button"
                onClick={() => {
                  if (themeMode !== v) toggleTheme();
                }}
                style={{
                  flex: 1,
                  padding: "7px 0",
                  height: 32,
                  borderRadius: 6,
                  border: `1px solid ${isActive ? t.accent : t.border}`,
                  background: isActive ? t.accentSoft : t.surface,
                  color: isActive ? t.accent : t.text,
                  fontFamily: "inherit",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                  textTransform: "capitalize",
                }}
              >
                {v}
              </button>
            );
          })}
        </div>
      </Field>
      <Field
        t={t}
        label="Sidebar"
        hint="Auto-hide expands on hover. Pinned stays open. Collapsed never expands on hover — except over Custom Resources, where every CRD shares a fallback icon."
      >
        <div style={{ display: "flex", gap: 6 }}>
          {(
            [
              { v: "auto", label: "Auto-hide" },
              { v: "pinned", label: "Pinned" },
              { v: "collapsed", label: "Collapsed" },
            ] as const
          ).map(({ v, label }) => {
            const isActive = railMode === v;
            return (
              <button
                key={v}
                type="button"
                onClick={() => setRailMode(v)}
                style={{
                  flex: 1,
                  padding: "7px 0",
                  height: 32,
                  borderRadius: 6,
                  border: `1px solid ${isActive ? t.accent : t.border}`,
                  background: isActive ? t.accentSoft : t.surface,
                  color: isActive ? t.accent : t.text,
                  fontFamily: "inherit",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </Field>
      <Field
        t={t}
        label="Density"
        hint="Compact fits more rows on screen; comfortable adds breathing room."
      >
        <Select<"compact" | "comfortable" | "spacious">
          t={t}
          value={settings.density}
          onChange={(v) => patchSettings({ density: v })}
          options={[
            { value: "compact", label: "Compact" },
            { value: "comfortable", label: "Comfortable" },
            { value: "spacious", label: "Spacious" },
          ]}
        />
      </Field>
      <Field
        t={t}
        label="Mono font in tables"
        hint="Use a monospace font for resource names and IDs to align columns."
      >
        <Toggle
          t={t}
          checked={settings.monoTables}
          onChange={(v) => patchSettings({ monoTables: v })}
          label={settings.monoTables ? "On" : "Off"}
        />
      </Field>
      <Field
        t={t}
        label="Interface scale"
        hint={`Zoom the whole UI. ${MOD_KEY}+− / ${MOD_KEY}+= to nudge, ${MOD_KEY}+0 to reset.`}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <ScaleStepBtn
            t={t}
            disabled={atMin}
            onClick={() => bumpUiScale(-1)}
            label="−"
            ariaLabel="Decrease interface scale"
          />
          <div
            style={{
              minWidth: 56,
              padding: "0 10px",
              height: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 6,
              border: `1px solid ${t.border}`,
              background: t.surface,
              color: t.text,
              fontFamily: FONT_MONO,
              fontSize: 12.5,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {uiScalePct}%
          </div>
          <ScaleStepBtn
            t={t}
            disabled={atMax}
            onClick={() => bumpUiScale(1)}
            label="+"
            ariaLabel="Increase interface scale"
          />
          <button
            type="button"
            onClick={resetUiScale}
            disabled={atDefault}
            style={{
              marginLeft: 6,
              height: 32,
              padding: "0 12px",
              borderRadius: 6,
              border: `1px solid ${t.border}`,
              background: t.surface,
              color: atDefault ? t.textMuted : t.text,
              fontFamily: "inherit",
              fontSize: 12.5,
              fontWeight: 500,
              cursor: atDefault ? "default" : "pointer",
              opacity: atDefault ? 0.6 : 1,
            }}
          >
            Reset
          </button>
        </div>
      </Field>
    </div>
  );
}

function ScaleStepBtn({
  t,
  disabled,
  onClick,
  label,
  ariaLabel,
}: {
  t: Tokens;
  disabled: boolean;
  onClick: () => void;
  label: string;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      style={{
        width: 32,
        height: 32,
        borderRadius: 6,
        border: `1px solid ${t.border}`,
        background: t.surface,
        color: disabled ? t.textMuted : t.text,
        fontFamily: "inherit",
        fontSize: 14,
        fontWeight: 600,
        lineHeight: 1,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

function KubeconfigSection({ mode }: { mode: ThemeMode }) {
  const t = tokens(mode);
  const [settings, setSettings] = useState<KubeconfigSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  // null = closed; KubeconfigSource = edit modal open for that source.
  const [sshEdit, setSshEdit] = useState<KubeconfigSource | null>(null);

  const reload = () =>
    api.listKubeconfigSources().then(setSettings).catch((e: unknown) => {
      toast.bad(`Could not load kubeconfig sources: ${String(e)}`);
    });

  useEffect(() => {
    reload();
  }, []);

  const pickAndAdd = async (kind: "file" | "folder") => {
    setBusy(true);
    try {
      const defaultPath = settings?.last_picked_dir ?? undefined;
      const picked = await openDialog({
        directory: kind === "folder",
        multiple: false,
        title:
          kind === "folder"
            ? "Add kubeconfig folder"
            : "Add kubeconfig file",
        defaultPath,
      });
      if (!picked || typeof picked !== "string") return;
      const added = await api.addKubeconfigSource(picked);
      toast.ok(
        `Added ${added.kind === "folder" ? "folder" : "file"} · ${added.path}`,
      );
      await reload();
    } catch (e: unknown) {
      toast.bad(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!settings) {
    return (
      <div>
        <SectionHeader
          t={t}
          title="Kubeconfig"
          sub="Default kubeconfig + extra files and folders to scan."
        />
        <div style={{ marginTop: 16, fontSize: 13, color: t.textMuted }}>
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div>
      <SectionHeader
        t={t}
        title="Kubeconfig"
        sub="Default kubeconfig + extra files and folders to scan. Files in folders are scanned non-recursively. Changes on disk auto-refresh the fleet."
      />

      <Field
        t={t}
        label="Default kubeconfig"
        hint="$KUBECONFIG / ~/.kube/config. Disable to ignore the system default and only show your registered sources."
      >
        <Toggle
          t={t}
          checked={!settings.default_disabled}
          onChange={async (v) => {
            try {
              await api.setDefaultKubeconfigDisabled(!v);
              setSettings({ ...settings, default_disabled: !v });
            } catch (e: unknown) {
              toast.bad(String(e));
            }
          }}
          label={settings.default_disabled ? "Disabled" : "Enabled"}
        />
      </Field>

      <div
        style={{
          marginTop: 16,
          padding: "12px 14px",
          border: `1px solid ${t.borderSoft}`,
          borderRadius: 8,
          background: t.surfaceAlt,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <div
            style={{
              flex: 1,
              fontSize: 13,
              fontWeight: 600,
              color: t.text,
            }}
          >
            Sources
          </div>
          <Btn
            t={t}
            variant="ghost"
            size="sm"
            onClick={() => pickAndAdd("file")}
            disabled={busy}
          >
            Add file…
          </Btn>
          <Btn
            t={t}
            variant="ghost"
            size="sm"
            onClick={() => setSshOpen(true)}
            disabled={busy}
          >
            Add SSH host…
          </Btn>
          <Btn
            t={t}
            variant="primary"
            size="sm"
            onClick={() => pickAndAdd("folder")}
            disabled={busy}
          >
            Add folder…
          </Btn>
        </div>

        {settings.sources.length === 0 ? (
          <div
            style={{
              fontSize: 12,
              color: t.textMuted,
              padding: "12px 4px",
            }}
          >
            No extra sources yet. Add a file, folder, or SSH host to scan
            additional kubeconfigs.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {settings.sources.map((src) => (
              <SourceRow
                key={src.id}
                t={t}
                src={src}
                onEdit={
                  src.kind === "ssh" ? () => setSshEdit(src) : undefined
                }
                onChange={async (patch) => {
                  try {
                    const updated = await api.updateKubeconfigSource(
                      src.id,
                      patch,
                    );
                    setSettings({
                      ...settings,
                      sources: settings.sources.map((s) =>
                        s.id === src.id ? updated : s,
                      ),
                    });
                  } catch (e: unknown) {
                    toast.bad(String(e));
                  }
                }}
                onRemove={async () => {
                  try {
                    await api.removeKubeconfigSource(src.id);
                    setSettings({
                      ...settings,
                      sources: settings.sources.filter(
                        (s) => s.id !== src.id,
                      ),
                    });
                    toast.ok("Source removed");
                  } catch (e: unknown) {
                    toast.bad(String(e));
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>
      {sshOpen && (
        <AddSshSourceModal
          t={t}
          onClose={() => setSshOpen(false)}
          onAdded={async (added) => {
            setSshOpen(false);
            toast.ok(`Added SSH source · ${added.path}`);
            await reload();
          }}
        />
      )}
      {sshEdit && (
        <AddSshSourceModal
          t={t}
          initial={sshEdit}
          onClose={() => setSshEdit(null)}
          onAdded={async (saved) => {
            setSshEdit(null);
            toast.ok(`Updated SSH source · ${saved.path}`);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function SourceRow({
  t,
  src,
  onChange,
  onRemove,
  onEdit,
}: {
  t: Tokens;
  src: KubeconfigSource;
  onChange: (patch: {
    groupOverride?: string | null;
    enabled?: boolean;
  }) => void | Promise<void>;
  onRemove: () => void | Promise<void>;
  /// Optional — only set for kinds where editing the row's *body* (host /
  /// auth / remote path) makes sense (currently SSH).
  onEdit?: () => void;
}) {
  // Local draft so the user can type without firing a save on every keystroke.
  // Commit on blur or Enter.
  const [draftGroup, setDraftGroup] = useState<string>(
    src.group_override ?? "",
  );

  // Resync local draft when the source changes externally (e.g. file watcher
  // refresh or another patch landed).
  useEffect(() => {
    setDraftGroup(src.group_override ?? "");
  }, [src.id, src.group_override]);

  const placeholder =
    src.kind === "folder"
      ? src.path.split(/[/\\]/).filter(Boolean).pop() ?? "Folder"
      : src.kind === "ssh"
      ? src.ssh?.host ?? "SSH"
      : "Custom";

  const commitGroup = () => {
    const next = draftGroup.trim();
    const current = src.group_override ?? "";
    if (next === current) return;
    onChange({ groupOverride: next === "" ? null : next });
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        background: t.surface,
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 6,
        opacity: src.enabled ? 1 : 0.55,
      }}
    >
      <span
        style={{
          fontFamily: FONT_MONO,
          fontSize: 9.5,
          padding: "2px 6px",
          borderRadius: 3,
          background: t.chip,
          color: t.textDim,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        {src.kind}
      </span>
      <input
        type="text"
        value={draftGroup}
        placeholder={placeholder}
        onChange={(e) => setDraftGroup(e.target.value)}
        onBlur={commitGroup}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraftGroup(src.group_override ?? "");
        }}
        title="Group name (empty = default for this source kind)"
        style={{
          width: 130,
          padding: "4px 8px",
          fontSize: 12,
          fontFamily: "inherit",
          background: t.bg,
          color: t.text,
          border: `1px solid ${t.border}`,
          borderRadius: 4,
          outline: "none",
        }}
      />
      <Tooltip label={src.path}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: FONT_MONO,
            fontSize: 11.5,
            color: t.textDim,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {src.path}
        </div>
      </Tooltip>
      <Toggle
        t={t}
        checked={src.enabled}
        onChange={(v) => onChange({ enabled: v })}
        label={src.enabled ? "On" : "Off"}
      />
      {onEdit && (
        <IconBtn t={t} title="Edit source" onClick={onEdit}>
          {Icons.pencil}
        </IconBtn>
      )}
      <IconBtn
        t={t}
        title="Remove source"
        onClick={() => {
          void onRemove();
        }}
      >
        {Icons.trash}
      </IconBtn>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Add SSH source modal.
//
// Three-stage flow:
//   1. Operator fills host / port / user / auth (+ optional remote path).
//   2. "Test" exercises the SSH handshake against a temp keychain entry —
//      surfaces detected kubeconfig path + contexts + captured fingerprint.
//   3. "Add" runs the same handshake under the *real* source id, persists
//      the source, pins the fingerprint.
// The user can skip Test and click Add directly; Add does the same checks.

type AddSshAuthDraft =
  | { kind: "password"; password: string }
  | { kind: "privatekey"; path: string; passphrase: string }
  | { kind: "agent" }
  | { kind: "defaultkeys" };

function AddSshSourceModal({
  t,
  onClose,
  onAdded,
  initial,
}: {
  t: Tokens;
  onClose: () => void;
  onAdded: (added: KubeconfigSource) => void | Promise<void>;
  /// When set, the modal is in edit mode — fields prefill from `initial.ssh`,
  /// and Save calls `update_kubeconfig_ssh_source` instead of add. Passwords
  /// and key passphrases are *not* prefilled (they live in the OS keychain
  /// and aren't fetched back); the operator re-enters them when changing
  /// auth mode or as needed.
  initial?: KubeconfigSource;
}) {
  const editing = !!initial;
  const initSsh = initial?.ssh ?? null;
  const [host, setHost] = useState(initSsh?.host ?? "");
  const [port, setPort] = useState(String(initSsh?.port ?? 22));
  const [user, setUser] = useState(initSsh?.user ?? "");
  const initialAuth: AddSshAuthDraft = (() => {
    if (!initSsh) return { kind: "defaultkeys" };
    const a = initSsh.auth;
    if (a.kind === "password") return { kind: "password", password: "" };
    if (a.kind === "privatekey")
      return { kind: "privatekey", path: a.path, passphrase: "" };
    if (a.kind === "agent") return { kind: "agent" };
    return { kind: "defaultkeys" };
  })();
  const [auth, setAuth] = useState<AddSshAuthDraft>(initialAuth);
  const [remotePath, setRemotePath] = useState(
    initSsh?.remote_kubeconfig ?? "",
  );
  const [groupOverride, setGroupOverride] = useState(
    initial?.group_override ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{
    detected: string;
    contexts: string[];
    fingerprint: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buildInput = (): SshSourceInput | string => {
    const portNum = Number(port);
    if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) {
      return "Port must be a number between 1 and 65535.";
    }
    if (!host.trim()) return "Host is required.";
    if (!user.trim()) return "User is required.";
    let authIn: SshAuthInput;
    if (auth.kind === "password") {
      if (!auth.password) return "Password is required.";
      authIn = { kind: "password", password: auth.password };
    } else if (auth.kind === "privatekey") {
      if (!auth.path.trim()) return "Private key path is required.";
      authIn = {
        kind: "privatekey",
        path: auth.path.trim(),
        passphrase: auth.passphrase ? auth.passphrase : null,
      };
    } else if (auth.kind === "agent") {
      authIn = { kind: "agent" };
    } else {
      authIn = { kind: "defaultkeys" };
    }
    return {
      host: host.trim(),
      port: portNum,
      user: user.trim(),
      auth: authIn,
      remote_kubeconfig: remotePath.trim() ? remotePath.trim() : null,
      group_override: groupOverride.trim() ? groupOverride.trim() : null,
    };
  };

  const pickKey = async () => {
    const picked = await openDialog({
      directory: false,
      multiple: false,
      title: "Pick SSH private key",
    });
    if (typeof picked === "string" && picked) {
      setAuth({
        kind: "privatekey",
        path: picked,
        passphrase: auth.kind === "privatekey" ? auth.passphrase : "",
      });
    }
  };

  const onTest = async () => {
    setError(null);
    setTestResult(null);
    const input = buildInput();
    if (typeof input === "string") {
      setError(input);
      return;
    }
    setBusy(true);
    try {
      const r = await api.testSshKubeconfigSource(input);
      setTestResult({
        detected: r.detected_path,
        contexts: r.contexts,
        fingerprint: r.fingerprint,
      });
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async () => {
    setError(null);
    const input = buildInput();
    if (typeof input === "string") {
      setError(input);
      return;
    }
    setBusy(true);
    try {
      const saved = editing && initial
        ? await api.updateKubeconfigSshSource(initial.id, input)
        : await api.addKubeconfigSshSource(input);
      await onAdded(saved);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    padding: "5px 8px",
    fontSize: 12.5,
    fontFamily: "inherit",
    background: t.bg,
    color: t.text,
    border: `1px solid ${t.border}`,
    borderRadius: 4,
    outline: "none",
    width: "100%",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 11.5,
    color: t.textDim,
    marginBottom: 3,
    display: "block",
  };

  return (
    <div
      style={{
        position: "fixed",
        top: "var(--fs-titlebar-h, 0px)",
        right: 0,
        bottom: 0,
        left: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        style={{
          width: 520,
          maxHeight: "90vh",
          overflowY: "auto",
          background: t.surface,
          color: t.text,
          border: `1px solid ${t.border}`,
          borderRadius: 8,
          padding: 18,
          boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            marginBottom: 4,
          }}
        >
          {editing ? "Edit SSH host" : "Add SSH host"}
        </div>
        <div
          style={{
            fontSize: 12,
            color: t.textMuted,
            marginBottom: 14,
          }}
        >
          {editing
            ? "Update host / auth / kubeconfig path. Leave password and passphrase blank to keep what's currently in the OS keychain."
            : "Connect to a Linux host via SSH and tunnel its kubeconfig to your machine. Passwords / passphrases are stored in your OS keychain."}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 8 }}>
          <div>
            <label style={labelStyle}>Host</label>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="bastion.example.com or 10.0.0.5"
              style={inputStyle}
              autoFocus
            />
          </div>
          <div>
            <label style={labelStyle}>Port</label>
            <input
              type="text"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              style={inputStyle}
            />
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <label style={labelStyle}>User</label>
          <input
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="root"
            style={inputStyle}
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <label style={labelStyle}>Authentication</label>
          <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
            {(["defaultkeys", "privatekey", "password", "agent"] as const).map(
              (k) => (
                <button
                  key={k}
                  onClick={() => {
                    if (k === "defaultkeys") setAuth({ kind: "defaultkeys" });
                    else if (k === "privatekey")
                      setAuth({ kind: "privatekey", path: "", passphrase: "" });
                    else if (k === "password")
                      setAuth({ kind: "password", password: "" });
                    else setAuth({ kind: "agent" });
                  }}
                  style={{
                    padding: "4px 10px",
                    fontSize: 12,
                    background: auth.kind === k ? t.accentSoft : t.chip,
                    color: auth.kind === k ? t.text : t.textDim,
                    border: `1px solid ${auth.kind === k ? t.accent : t.border}`,
                    borderRadius: 4,
                    cursor: "pointer",
                  }}
                >
                  {k === "defaultkeys"
                    ? "Default keys"
                    : k === "privatekey"
                    ? "Private key"
                    : k === "password"
                    ? "Password"
                    : "ssh-agent"}
                </button>
              ),
            )}
          </div>
          {auth.kind === "password" && (
            <input
              type="password"
              value={auth.password}
              onChange={(e) => setAuth({ kind: "password", password: e.target.value })}
              placeholder={editing ? "Leave blank to keep current password" : "Password"}
              style={inputStyle}
            />
          )}
          {auth.kind === "privatekey" && (
            <>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="text"
                  value={auth.path}
                  onChange={(e) =>
                    setAuth({ ...auth, path: e.target.value })
                  }
                  placeholder="~/.ssh/id_ed25519"
                  style={inputStyle}
                />
                <Btn t={t} variant="ghost" size="sm" onClick={pickKey}>
                  Browse…
                </Btn>
              </div>
              <input
                type="password"
                value={auth.passphrase}
                onChange={(e) =>
                  setAuth({ ...auth, passphrase: e.target.value })
                }
                placeholder={
                  editing
                    ? "Leave blank to keep current passphrase (or if key is unencrypted)"
                    : "Passphrase (leave blank if key is unencrypted)"
                }
                style={{ ...inputStyle, marginTop: 6 }}
              />
            </>
          )}
          {auth.kind === "agent" && (
            <div style={{ fontSize: 11.5, color: t.textMuted }}>
              Uses identities offered by the running ssh-agent
              ($SSH_AUTH_SOCK).
            </div>
          )}
          {auth.kind === "defaultkeys" && (
            <div style={{ fontSize: 11.5, color: t.textMuted }}>
              Tries ~/.ssh/id_ed25519, id_ecdsa, id_rsa in that order.
              Encrypted keys without a known passphrase are skipped — use
              ssh-agent or pick the key explicitly.
            </div>
          )}
        </div>

        <div style={{ marginTop: 12 }}>
          <label style={labelStyle}>
            Remote kubeconfig path <span style={{ color: t.textMuted }}>(optional)</span>
          </label>
          <input
            type="text"
            value={remotePath}
            onChange={(e) => setRemotePath(e.target.value)}
            placeholder="Auto-detect: $KUBECONFIG / ~/.kube/config"
            style={inputStyle}
          />
        </div>

        <div style={{ marginTop: 10 }}>
          <label style={labelStyle}>
            Group name <span style={{ color: t.textMuted }}>(optional)</span>
          </label>
          <input
            type="text"
            value={groupOverride}
            onChange={(e) => setGroupOverride(e.target.value)}
            placeholder={host || "Group label in the fleet view"}
            style={inputStyle}
          />
        </div>

        {error && (
          <div
            style={{
              marginTop: 12,
              padding: "8px 10px",
              background: "rgba(244, 63, 94, 0.12)",
              border: `1px solid ${t.bad}`,
              borderRadius: 6,
            }}
          >
            <ErrorBlock
              t={t}
              message={error}
              kindLabel="kubeconfig source"
              inline
            />
          </div>
        )}

        {testResult && (
          <div
            style={{
              marginTop: 12,
              padding: "10px 12px",
              fontSize: 12,
              background: t.surfaceAlt,
              border: `1px solid ${t.borderSoft}`,
              borderRadius: 6,
            }}
          >
            <div style={{ marginBottom: 4, color: t.textDim }}>
              Detected kubeconfig:
            </div>
            <div style={{ fontFamily: FONT_MONO, marginBottom: 8 }}>
              {testResult.detected}
            </div>
            <div style={{ marginBottom: 4, color: t.textDim }}>
              Contexts ({testResult.contexts.length}):
            </div>
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: 11.5,
                marginBottom: 8,
              }}
            >
              {testResult.contexts.length > 0
                ? testResult.contexts.join(", ")
                : "—"}
            </div>
            {testResult.fingerprint && (
              <>
                <div style={{ marginBottom: 4, color: t.textDim }}>
                  Host fingerprint (will be pinned):
                </div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 11.5 }}>
                  {testResult.fingerprint}
                </div>
              </>
            )}
          </div>
        )}

        <div
          style={{
            marginTop: 16,
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <Btn t={t} variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn t={t} variant="ghost" size="sm" onClick={onTest} disabled={busy}>
            Test
          </Btn>
          <Btn
            t={t}
            variant="primary"
            size="sm"
            onClick={onSubmit}
            disabled={busy}
          >
            {editing ? "Save" : "Add"}
          </Btn>
        </div>
      </div>
    </div>
  );
}

function ShortcutsSection({ mode }: { mode: ThemeMode }) {
  const t = tokens(mode);
  // Each entry's chord is an array of label segments — each gets its own
  // <Kbd>. `MOD_KEY` resolves to ⌘ on macOS and "Ctrl" elsewhere; same shape
  // for ⇧/Shift and ⌥/Alt. The handlers themselves accept either modifier
  // (`e.metaKey || e.ctrlKey`) so this is purely a display swap.
  const rows: [string, string[]][] = [
    ["Open command palette", [MOD_KEY, "K"]],
    ["Filter visible rows", [MOD_KEY, "F"]],
    ["Filter visible rows (vim)", ["/"]],
    ["New terminal in dock", [MOD_KEY, "`"]],
    ["New YAML scratchpad", [SHIFT_KEY, MOD_KEY, "Y"]],
    ["Open settings", [MOD_KEY, ","]],
    ["Filter by namespace", [MOD_KEY, "I"]],
    ["Toggle theme", [MOD_KEY, SHIFT_KEY, "L"]],
    ["Select all rows", [MOD_KEY, "A"]],
    ["Zoom UI in", [MOD_KEY, "+"]],
    ["Zoom UI out", [MOD_KEY, "−"]],
    ["Reset UI zoom", [MOD_KEY, "0"]],
    ["Detail panel · back", [ALT_KEY, "←"]],
    ["Detail panel · forward", [ALT_KEY, "→"]],
    ["Close panel / cancel", ["Esc"]],
  ];
  return (
    <div>
      <SectionHeader
        t={t}
        title="Shortcuts"
        sub="Keyboard routes for the most common actions. P3."
      />
      <div
        style={{
          marginTop: 14,
          display: "flex",
          flexDirection: "column",
          gap: 0,
        }}
      >
        {rows.map(([label, kbd], i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 0",
              borderBottom:
                i < rows.length - 1 ? `1px solid ${t.borderSoft}` : "none",
            }}
          >
            <span style={{ fontSize: 13, color: t.text }}>{label}</span>
            <span style={{ display: "flex", gap: 4 }}>
              {kbd.map((k, j) => (
                <Kbd
                  key={j}
                  t={t}
                  style={{
                    padding: "2px 7px",
                    border: `1px solid ${t.borderSoft}`,
                    fontWeight: 500,
                  }}
                >
                  {k}
                </Kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Per-cluster Prometheus picker. Detection runs automatically on cluster
// connect — this panel surfaces the cached entry, lets the operator
// override it manually, and exposes a "Re-detect" action for the case
// where Prometheus was redeployed under a new Service.
function ObservabilitySection({ mode }: { mode: ThemeMode }) {
  const t = tokens(mode);
  const clusterId = useAppStore((s) => s.selectedContext);
  const [entry, setEntry] = useState<PromCacheEntry | null>(null);
  const [candidates, setCandidates] = useState<PromTarget[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [redetecting, setRedetecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (!clusterId) return;
    setEntry(null);
    setCandidates(null);
    setError(null);
    setTestResult(null);
    api
      .getPrometheusTarget(clusterId)
      .then((e) => setEntry(e))
      .catch((e: unknown) => setError(String(e)));
    // Live-refresh when the on-connect detect task lands or a redetect
    // completes — keeps Settings in sync without re-opening it.
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    onPrometheusChanged((evt) => {
      if (evt.cluster_id !== clusterId) return;
      setEntry(evt.entry);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [clusterId]);

  if (!clusterId) {
    return (
      <div>
        <SectionHeader
          t={t}
          title="Observability"
          sub="Connect a Prometheus instance for richer metrics."
        />
        <div
          style={{
            marginTop: 22,
            padding: "14px 16px",
            background: t.surfaceAlt,
            border: `1px solid ${t.borderSoft}`,
            borderRadius: 6,
            fontSize: 12.5,
            color: t.textDim,
          }}
        >
          Connect to a cluster first to configure Prometheus for it.
        </div>
      </div>
    );
  }

  const onDiscover = async () => {
    setDiscovering(true);
    setError(null);
    try {
      const found = await api.discoverPrometheusTargets(clusterId);
      setCandidates(found);
      if (found.length === 0) {
        setError(
          "No Prometheus services found by label. If you know the address, this picker doesn't yet support manual entry — open an issue.",
        );
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setDiscovering(false);
    }
  };

  const onPick = async (next: PromTarget | null) => {
    setSaving(true);
    setError(null);
    setTestResult(null);
    try {
      await api.setPrometheusTarget(clusterId, next);
      // Re-fetch so we see the freshly saved entry's source/timestamp
      // rather than reconstructing it locally.
      const e = await api.getPrometheusTarget(clusterId);
      setEntry(e);
      toast.ok(next ? "Prometheus target saved" : "Prometheus target cleared");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const onRedetect = async () => {
    setRedetecting(true);
    setError(null);
    try {
      await api.prometheusRedetect(clusterId);
      // Result lands via `prometheus://changed` listener — no need to
      // poll. UX cue: the spinner clears in ~5s when validation completes.
      window.setTimeout(() => setRedetecting(false), 6000);
    } catch (e) {
      setRedetecting(false);
      setError(String(e));
    }
  };

  const onTest = async () => {
    if (!entry) return;
    setTestResult("…");
    try {
      const data = await api.prometheusQueryInstant(clusterId, "up");
      const json = data as { resultType?: string; result?: unknown[] };
      const count = Array.isArray(json.result) ? json.result.length : 0;
      setTestResult(`OK · ${count} series for "up"`);
    } catch (e) {
      setTestResult(`error: ${String(e)}`);
    }
  };

  return (
    <div>
      <SectionHeader
        t={t}
        title="Observability"
        sub={`Prometheus target for ${clusterId}`}
      />
      <div style={{ marginTop: 16, fontSize: 12.5, color: t.textDim }}>
        FerrisScope reads from an existing Prometheus you point it at — it
        never deploys one. Queries are proxied through the apiserver, so
        the user's RBAC must allow <code>services/proxy</code> in the
        Prometheus namespace.
      </div>

      <div style={{ marginTop: 18 }}>
        <Field
          t={t}
          label="Active target"
          hint={
            entry ? (
              <ActiveTargetHint t={t} entry={entry} />
            ) : (
              "Auto-detection runs on connect. None found yet — Prometheus-backed panels stay hidden until detection succeeds or you pick one below."
            )
          }
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn t={t} onClick={onRedetect} disabled={redetecting || saving}>
              {redetecting ? "Detecting…" : "Re-detect"}
            </Btn>
            <Btn t={t} variant="ghost" onClick={onDiscover} disabled={discovering}>
              {discovering ? "Searching…" : "Browse candidates"}
            </Btn>
            {entry && (
              <>
                <Btn t={t} variant="ghost" onClick={onTest} disabled={saving}>
                  Test
                </Btn>
                <Btn
                  t={t}
                  variant="ghost"
                  onClick={() => onPick(null)}
                  disabled={saving}
                >
                  Clear
                </Btn>
              </>
            )}
          </div>
          {testResult && (
            <div
              style={{
                fontSize: 12,
                fontFamily: FONT_MONO,
                color: testResult.startsWith("error") ? t.bad : t.good,
              }}
            >
              {testResult}
            </div>
          )}
        </Field>
      </div>

      {error && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 12px",
            background: "rgba(244,63,94,0.08)",
            border: `1px solid rgba(244,63,94,0.4)`,
            borderRadius: 4,
          }}
        >
          <ErrorBlock
            t={t}
            message={error}
            kindLabel="observability target"
            inline
          />
        </div>
      )}

      {candidates !== null && candidates.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: t.text,
              marginBottom: 8,
            }}
          >
            Detected
          </div>
          <div
            style={{
              border: `1px solid ${t.borderSoft}`,
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            {candidates.map((c) => {
              const id = `${c.namespace}/${c.service}:${c.port}`;
              const active =
                entry?.target.namespace === c.namespace &&
                entry?.target.service === c.service &&
                entry?.target.port === c.port;
              return (
                <div
                  key={id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 14px",
                    borderBottom: `1px solid ${t.borderSoft}`,
                    background: active ? t.accentSoft : "transparent",
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontFamily: FONT_MONO,
                        color: t.text,
                      }}
                    >
                      {id}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: t.textDim,
                        marginTop: 2,
                      }}
                    >
                      scheme {c.scheme}
                    </div>
                  </div>
                  <Btn
                    t={t}
                    variant={active ? "ghost" : "primary"}
                    onClick={() => onPick(c)}
                    disabled={saving}
                  >
                    {active ? "Selected" : "Use"}
                  </Btn>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ActiveTargetHint({
  t,
  entry,
}: {
  t: Tokens;
  entry: PromCacheEntry;
}) {
  const id = `${entry.target.namespace}/${entry.target.service}:${entry.target.port}`;
  const sourceLabel = entry.source === "user" ? "User-set" : "Auto-detected";
  const validatedAgo = freshnessLabel(entry.last_validated_at_unix_ms);
  return (
    <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontFamily: FONT_MONO, color: t.text }}>{id}</span>
      <span style={{ color: t.textDim }}>·</span>
      <span style={{ color: t.textDim }}>{sourceLabel}</span>
      <span style={{ color: t.textDim }}>·</span>
      <span style={{ color: t.textDim }}>validated {validatedAgo}</span>
    </span>
  );
}

function freshnessLabel(unixMs: number): string {
  if (unixMs === 0) return "never";
  const sec = Math.max(0, Math.floor((Date.now() - unixMs) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up_to_date"; latest: string }
  | { kind: "available"; release: ReleaseInfo }
  | { kind: "applying"; release: ReleaseInfo }
  | { kind: "error"; message: string };

function AboutSection({ mode }: { mode: ThemeMode }) {
  const t = tokens(mode);
  const [info, setInfo] = useState<UpdaterInfo | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ kind: "idle" });
  const lastKnownVersion = useAppStore(
    (s) => s.updateState.lastKnownVersion,
  );
  const patchUpdateState = useAppStore((s) => s.patchUpdateState);

  useEffect(() => {
    api
      .updaterInfo()
      .then(setInfo)
      .catch((e) => toast.bad(`Failed to read app info: ${String(e)}`));
  }, []);

  // If the background checker already saw a newer release, refetch the full
  // ReleaseInfo on mount so the banner + Update button appear without making
  // the operator click "Check for updates" first. We don't cache the full
  // ReleaseInfo in prefs (asset name / download URL / html_url are derivable
  // from a fresh check); one extra GitHub call when opening Settings is fine.
  useEffect(() => {
    if (!info) return;
    if (update.kind !== "idle") return;
    if (!lastKnownVersion) return;
    if (!semverGt(lastKnownVersion, info.current_version)) return;
    void check();
    // Deliberately don't depend on `update.kind` — we only want to fire once
    // when `info` lands. `check` reads `lastKnownVersion` via the closure but
    // the comparison above is what gates the call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, lastKnownVersion]);

  async function check() {
    setUpdate({ kind: "checking" });
    try {
      const out = await api.checkForUpdate();
      const now = Date.now();
      if (out.kind === "up_to_date") {
        setUpdate({ kind: "up_to_date", latest: out.latest_version });
        patchUpdateState({ lastCheckAt: now });
      } else {
        setUpdate({ kind: "available", release: out.release });
        patchUpdateState({
          lastKnownVersion: out.release.version,
          lastCheckAt: now,
        });
      }
    } catch (e) {
      setUpdate({ kind: "error", message: String(e) });
    }
  }

  async function apply(release: ReleaseInfo) {
    setUpdate({ kind: "applying", release });
    try {
      await api.applyUpdate(release);
      // The helper has been spawned; the app should be exiting shortly.
      toast.ok("Update downloaded — relaunching…");
    } catch (e) {
      setUpdate({ kind: "error", message: String(e) });
    }
  }

  function skipThisVersion(version: string) {
    patchUpdateState({ lastSeenVersion: version });
    // Fold the panel state back to idle so the banner doesn't keep nagging
    // in the same session. Re-checking manually will resurface it.
    setUpdate({ kind: "idle" });
    toast.ok(`Skipped v${version} — we'll let you know about newer releases.`);
  }

  return (
    <div>
      <SectionHeader t={t} title="About" />
      <div
        style={{
          marginTop: 18,
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginBottom: 18,
        }}
      >
        <div
          style={{
            width: 44,
            height: 44,
            borderRadius: 11,
            background: t.accent,
            color: "white",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <BrandMark size={28} />
        </div>
        <div>
          <div
            style={{
              fontSize: 17,
              fontWeight: 700,
              letterSpacing: -0.3,
              color: t.text,
            }}
          >
            FerrisScope
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: t.textDim,
              fontFamily: FONT_MONO,
            }}
          >
            v{info?.current_version ?? "…"} · Rust-native Kubernetes desktop ·
            Tauri 2 · kube-rs
          </div>
        </div>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "120px 1fr",
          gap: "10px 16px",
          fontSize: 12.5,
          color: t.textDim,
          marginBottom: 18,
        }}
      >
        <div style={{ color: t.textMuted }}>License</div>
        <div>Apache-2.0</div>
        <div style={{ color: t.textMuted }}>Status</div>
        <div>beta</div>
        <div style={{ color: t.textMuted }}>Version</div>
        <div style={{ fontFamily: FONT_MONO }}>
          {info?.current_version ?? "…"}
          {info?.target ? ` · ${info.target}` : null}
        </div>
        <div style={{ color: t.textMuted }}>Repository</div>
        <div style={{ fontFamily: FONT_MONO }}>
          {info?.releases_url ? (
            <button
              onClick={() => {
                if (info?.releases_url) void openUrl(info.releases_url);
              }}
              style={{
                background: "transparent",
                border: 0,
                padding: 0,
                color: t.accent,
                cursor: "pointer",
                font: "inherit",
              }}
            >
              {info.releases_url}
            </button>
          ) : (
            "(local)"
          )}
        </div>
      </div>

      <div
        style={{
          borderTop: `1px solid ${t.border}`,
          paddingTop: 14,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Btn
            t={t}
            variant="secondary"
            onClick={check}
            // Check is enabled even for system-package installs — the
            // operator still wants to know whether a new version is out;
            // we just route them to the package manager when one is.
            disabled={
              update.kind === "checking" || update.kind === "applying"
            }
          >
            {update.kind === "checking"
              ? "Checking…"
              : update.kind === "applying"
                ? "Applying…"
                : "Check for updates"}
          </Btn>
          {update.kind === "available" && info?.supported && (
            <Btn
              t={t}
              variant="primary"
              onClick={() => void apply(update.release)}
            >
              Update to v{update.release.version}
            </Btn>
          )}
          {update.kind === "available" && (
            <Btn
              t={t}
              variant="secondary"
              onClick={() => skipThisVersion(update.release.version)}
              title="Hide the update mark until a newer release ships"
            >
              Skip this version
            </Btn>
          )}
        </div>

        {/* System-managed installs: show the install method + the upgrade command
            (whether or not a new version is currently available — operators want
            to copy the command before they even check). */}
        {info && !info.supported && info.update_hint && (
          <SystemInstallHint
            t={t}
            method={info.install_method}
            command={info.update_hint}
          />
        )}

        {/* Truly unknown placement (operator-dropped binary): point at the
            releases page rather than guessing a command. */}
        {info &&
          !info.supported &&
          !info.update_hint &&
          info.unsupported_reason && (
            <div style={{ fontSize: 12, color: t.textMuted }}>
              {info.unsupported_reason}
            </div>
          )}

        {update.kind === "up_to_date" && (
          <div style={{ fontSize: 12.5, color: t.textDim }}>
            You're on the latest version (v{update.latest}).
          </div>
        )}
        {update.kind === "available" && (
          <div style={{ fontSize: 12.5, color: t.textDim }}>
            v{update.release.version} is available.{" "}
            <button
              onClick={() => void openUrl(update.release.html_url)}
              style={{
                background: "transparent",
                border: 0,
                padding: 0,
                color: t.accent,
                cursor: "pointer",
                font: "inherit",
              }}
            >
              View release notes
            </button>
          </div>
        )}
        {update.kind === "applying" && (
          <div style={{ fontSize: 12.5, color: t.textDim }}>
            Downloading and staging v{update.release.version}. The app will
            relaunch when finished.
          </div>
        )}
        {update.kind === "error" && (
          <ErrorBlock
            t={t}
            message={update.message}
            kindLabel="app update"
            verb="save"
            inline
          />
        )}
      </div>
    </div>
  );
}

// Renders the "this was installed by your system package manager — run this
// command to update" affordance. Lives next to AboutSection so all the
// updater-flow rendering is in one place.
function SystemInstallHint({
  t,
  method,
  command,
}: {
  t: ReturnType<typeof tokens>;
  method: import("../types").InstallMethod;
  command: string;
}) {
  const label = installMethodLabel(method);
  const onCopy = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(command).catch(() => {});
      toast.ok("Command copied");
    }
  };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px",
        background: t.surfaceAlt,
        border: `1px solid ${t.borderSoft}`,
        borderRadius: 6,
      }}
    >
      <div style={{ fontSize: 11.5, color: t.textMuted, fontWeight: 600 }}>
        Installed via {label} — update through it:
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: FONT_MONO,
          fontSize: 12,
          color: t.text,
          background: t.bg,
          border: `1px solid ${t.borderSoft}`,
          borderRadius: 4,
          padding: "6px 8px",
          wordBreak: "break-all",
        }}
      >
        <span style={{ flex: 1 }}>{command}</span>
        <button
          onClick={onCopy}
          title="Copy to clipboard"
          style={{
            background: "transparent",
            border: `1px solid ${t.borderSoft}`,
            borderRadius: 3,
            color: t.textDim,
            cursor: "pointer",
            font: "inherit",
            fontSize: 11,
            padding: "2px 8px",
          }}
        >
          Copy
        </button>
      </div>
    </div>
  );
}

function installMethodLabel(m: import("../types").InstallMethod): string {
  switch (m) {
    case "aur_bin":
      return "AUR (ferrisscope-bin)";
    case "apt_deb":
      return "apt / dpkg";
    case "rpm_dnf":
      return "dnf / rpm";
    case "homebrew":
      return "Homebrew";
    case "app_image":
      return "AppImage";
    case "mac_os_app_bundle":
      return ".app bundle";
    case "windows_nsis":
      return "Windows installer";
    case "unknown":
      return "an unrecognised path";
  }
}
