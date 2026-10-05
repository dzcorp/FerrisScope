import { useEffect, useState } from "react";
import { confirm } from "../../lib/dialog";
import {
  FF_MONO,
  FS_MD,
  FS_SM,
  FS_XS,
  R_LG,
  R_MD,
  hexWithAlpha,
  type Tokens,
} from "../../theme";
import { Btn, Toggle } from "../ui";
import type { ProviderStatusWire } from "../../types";
import {
  ApiKeyField,
  BaseUrlField,
  CustomModelsField,
  ReasoningField,
} from "./ProviderFields";
import { ProviderEnableDialog } from "./ProviderEnableDialog";

type Props = {
  t: Tokens;
  provider: ProviderStatusWire;
  /// A settings save is in flight somewhere on the page.
  busy: boolean;
  /// Resolves to whether the key was persisted.
  onSetKey: (key: string) => Promise<boolean>;
  onDelete: () => Promise<void>;
  onOauthLogin: () => Promise<void>;
  onOauthCancel: () => Promise<void>;
  /// Resolves to why the URL was refused, or `null` once persisted.
  onSetBaseUrl: (url: string) => Promise<string | null>;
  /// Resolves to whether the list was persisted.
  onSetCustomModels: (models: string[]) => Promise<boolean>;
  /// Resolves to whether the switch was persisted.
  onSetEnabled: (enabled: boolean) => Promise<boolean>;
  /// Save this provider's reasoning choice; resolves to whether it was saved.
  onSetReasoning: (effort: string | null, budget: number | null) => Promise<boolean>;
};

// One provider in Settings → AI: status + on/off switch in the header, and —
// when enabled and expanded — sign-in / key, base URL, custom models and
// Disconnect. Everything provider-specific (placeholders, blurbs, links,
// whether a blank key is valid) arrives on `provider`, not from here.
export function ProviderRow({
  t,
  provider,
  busy,
  onSetKey,
  onDelete,
  onOauthLogin,
  onOauthCancel,
  onSetBaseUrl,
  onSetCustomModels,
  onSetEnabled,
  onSetReasoning,
}: Props) {
  const [open, setOpen] = useState(false);
  const [confirmingEnable, setConfirmingEnable] = useState(false);
  const [enableBusy, setEnableBusy] = useState(false);
  const [oauthInFlight, setOauthInFlight] = useState(false);
  const [baseUrlDraft, setBaseUrlDraft] = useState(provider.base_url_override ?? "");
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const supportsOauth = provider.auth_modes.includes("oauth");
  const supportsKey = provider.auth_modes.includes("api_key");

  // Follow the persisted value: the backend normalises what was typed
  // (trailing slashes), and another save can change it under us.
  useEffect(() => {
    setBaseUrlDraft(provider.base_url_override ?? "");
    setBaseUrlError(null);
  }, [provider.base_url_override]);

  const commitBaseUrl = async () => {
    const next = baseUrlDraft.trim();
    if (next === (provider.base_url_override ?? "")) {
      setBaseUrlError(null);
      return;
    }
    setBaseUrlError(await onSetBaseUrl(next));
  };

  const onOauth = async () => {
    setOauthInFlight(true);
    try {
      await onOauthLogin();
    } finally {
      setOauthInFlight(false);
    }
  };

  const onDisconnect = async () => {
    const ok = await confirm({
      title: `Disconnect ${provider.display_name}?`,
      body: "Removes the saved credential from this device. You can reconnect any time.",
      confirmLabel: "Disconnect",
      tone: "danger",
    });
    if (ok) await onDelete();
  };

  // Switching on a provider that carries a disclosure (Zen's free tier)
  // goes through the confirm dialog; everything else flips immediately.
  const onToggleEnabled = async (next: boolean) => {
    if (next && provider.enable_notice) {
      setConfirmingEnable(true);
      return;
    }
    if (!next) setOpen(false);
    await onSetEnabled(next);
  };

  const onConfirmEnable = async () => {
    setEnableBusy(true);
    try {
      // A failed save keeps the dialog open so the operator can retry.
      if (await onSetEnabled(true)) setConfirmingEnable(false);
    } finally {
      setEnableBusy(false);
    }
  };

  const chip = !provider.enabled ? (
    <span style={{ fontSize: FS_XS, fontFamily: FF_MONO, color: t.textMuted }}>
      disabled
    </span>
  ) : provider.configured ? (
    <span
      style={{
        fontSize: FS_XS,
        fontFamily: FF_MONO,
        color: provider.free_tier ? t.info : t.good,
        background: hexWithAlpha(provider.free_tier ? t.info : t.good, 0.1),
        padding: "1px 6px",
        borderRadius: R_LG,
      }}
    >
      {provider.free_tier
        ? "free tier"
        : `${provider.auth_mode === "oauth" ? "oauth" : "api key"}${
            provider.account_label ? ` · ${provider.account_label}` : ""
          }`}
    </span>
  ) : (
    <span style={{ fontSize: FS_XS, fontFamily: FF_MONO, color: t.textMuted }}>
      not connected
    </span>
  );

  return (
    <div
      style={{
        background: t.surfaceAlt,
        border: `1px solid ${t.borderSoft}`,
        borderRadius: R_MD,
        padding: "8px 10px",
        opacity: provider.enabled ? 1 : 0.75,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ fontFamily: FF_MONO, fontSize: FS_MD, color: t.text }}>
            {provider.display_name}
          </span>
          {chip}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Toggle
            t={t}
            size="sm"
            checked={provider.enabled}
            disabled={busy}
            onChange={onToggleEnabled}
            title={
              provider.enabled
                ? `Disable ${provider.display_name}`
                : `Enable ${provider.display_name}`
            }
          />
          {provider.enabled && (
            <Btn t={t} variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
              {open ? "Hide" : provider.configured ? "Manage" : "Connect"}
            </Btn>
          )}
        </div>
      </div>

      {confirmingEnable && provider.enable_notice && (
        <ProviderEnableDialog
          t={t}
          providerName={provider.display_name}
          notice={provider.enable_notice}
          busy={enableBusy}
          onCancel={() => setConfirmingEnable(false)}
          onConfirm={onConfirmEnable}
        />
      )}

      {open && provider.enabled && (
        <div
          style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}
        >
          {provider.description && (
            <div style={{ fontSize: FS_SM, color: t.textMuted, lineHeight: 1.45 }}>
              {provider.description}
            </div>
          )}
          {supportsOauth && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Btn
                t={t}
                variant={provider.auth_mode === "oauth" ? "ghost" : "primary"}
                size="sm"
                disabled={busy || oauthInFlight}
                onClick={onOauth}
              >
                {oauthInFlight
                  ? "Waiting for browser…"
                  : provider.auth_mode === "oauth"
                    ? "Re-authorize"
                    : `Sign in with ${provider.oauth_label ?? "OAuth"}`}
              </Btn>
              {oauthInFlight && (
                <Btn t={t} variant="ghost" size="sm" onClick={onOauthCancel}>
                  Cancel
                </Btn>
              )}
            </div>
          )}
          {supportsKey && (
            <ApiKeyField
              t={t}
              provider={provider}
              busy={busy}
              baseUrl={baseUrlDraft}
              onSetKey={onSetKey}
            />
          )}
          <ReasoningField
            t={t}
            provider={provider}
            busy={busy}
            onSetReasoning={onSetReasoning}
          />
          <BaseUrlField
            t={t}
            provider={provider}
            value={baseUrlDraft}
            error={baseUrlError}
            onChange={setBaseUrlDraft}
            onCommit={commitBaseUrl}
          />
          <CustomModelsField
            t={t}
            provider={provider}
            busy={busy}
            onSetCustomModels={onSetCustomModels}
          />
          {provider.configured && !provider.free_tier && (
            <div>
              <Btn t={t} variant="ghost" size="sm" onClick={onDisconnect} disabled={busy}>
                Disconnect
              </Btn>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
