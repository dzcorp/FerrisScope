import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useResolvedTheme } from "../../store";
import { api } from "../../api";
import type {
  AiSettingsWire,
  ApprovalMode,
  AuthMode,
  McpServerConfig,
  McpTestResult,
  ModelInfo,
  ProviderKind,
  ProviderStatusWire,
  ReasoningEffort,
} from "../../types";
import { tokens, FF_MONO, type ThemeMode, type Tokens, R_LG, R_MD, FS_MD, FS_SM, FS_XS } from "../../theme";
import { Btn, ErrorBlock, Field, SectionHeader, Select, Toggle } from "../ui";

// AiSection — settings page tab for the cluster-aware AI agent. The
// settings shape is provider-list + per-provider credential state. Each
// provider row offers Connect (API key form and/or "Sign in with
// ChatGPT" OAuth button) and, once configured, exposes a small panel
// for base-URL override + Disconnect. The "active provider" select at
// the top drives chat-creation defaults.
export function AiSection({}: { mode: ThemeMode }) {
  const t = useResolvedTheme().tokens;
  const [settings, setSettings] = useState<AiSettingsWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [systemDraft, setSystemDraft] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);

  const refresh = async () => {
    try {
      const s = await api.aiGetSettings();
      setSettings(s);
      setSystemDraft(s.system_prompt_override ?? "");
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const refreshModels = async () => {
    if (!settings) return;
    const active = settings.providers[settings.active_provider];
    if (!active?.configured) {
      setModels([]);
      return;
    }
    setModelsBusy(true);
    try {
      const m = await api.aiListModels(settings.active_provider);
      setModels(m);
    } catch (e) {
      setError(String(e));
    } finally {
      setModelsBusy(false);
    }
  };

  useEffect(() => {
    refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settings?.active_provider,
    settings?.providers[settings?.active_provider as ProviderKind]?.configured,
  ]);

  if (!settings) {
    return (
      <div>
        <SectionHeader
          t={t}
          title="AI"
          sub="Cluster-aware assistant — configure provider and defaults."
        />
        {error ? (
          <ErrorBlock
            t={t}
            message={error}
            kindLabel="AI settings"
            inline
          />
        ) : (
          <div style={{ color: t.textMuted, fontSize: FS_MD }}>Loading…</div>
        )}
      </div>
    );
  }

  const save = async (patch: Parameters<typeof api.aiSetSettings>[0]) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.aiSetSettings(patch);
      setSettings(next);
      setSystemDraft(next.system_prompt_override ?? "");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSetCredential = async (provider: ProviderKind, key: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.aiSetCredential(provider, {
        type: "api_key",
        key,
      });
      setSettings(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onDeleteCredential = async (provider: ProviderKind) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.aiDeleteCredential(provider);
      setSettings(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onOauthLogin = async (provider: ProviderKind) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.aiOauthLogin(provider);
      setSettings(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onOauthCancel = async () => {
    try {
      await api.aiOauthCancel();
    } catch (e) {
      setError(String(e));
    }
  };

  // Render rows in the order Rust's ProviderKind::all() returns. We mirror
  // that order on the wire so the UI doesn't have to know it. OpenCode
  // Zen leads — it's the default for fresh installs and works without
  // a key (free tier) so a brand-new user can chat immediately.
  const providerOrder: ProviderKind[] = [
    "opencode_zen",
    "openai",
    "anthropic",
    "open_router",
    "zai",
    "minimax",
    "groq",
    "deepseek",
    "mistral",
    "together",
    "ollama",
  ];
  const visibleProviders = providerOrder
    .map((kind) => settings.providers[kind])
    .filter((p): p is ProviderStatusWire => Boolean(p));

  return (
    <div>
      <SectionHeader
        t={t}
        title="AI"
        sub="Cluster-aware assistant — configure providers and defaults."
      />

      <div style={{ marginTop: 12 }} data-fs-anchor="providers">
        <div
          style={{
            fontSize: FS_SM,
            color: t.textMuted,
            fontFamily: FF_MONO,
            marginBottom: 6,
          }}
        >
          Providers
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {visibleProviders.map((p) => (
            <ProviderRow
              key={p.kind}
              t={t}
              provider={p}
              busy={busy}
              onSetKey={(key) => onSetCredential(p.kind, key)}
              onDelete={() => onDeleteCredential(p.kind)}
              onOauthLogin={() => onOauthLogin(p.kind)}
              onOauthCancel={onOauthCancel}
              onSetBaseUrl={(url) =>
                save({
                  provider_base_url: { provider: p.kind, base_url: url },
                })
              }
            />
          ))}
        </div>
      </div>

      <Field
        t={t}
        anchor="active-provider"
        label="Active provider"
        hint="Which provider new chats use by default. Switching here doesn't affect already-open chats — they keep the provider they were created with."
      >
        <Select<ProviderKind>
          t={t}
          value={settings.active_provider}
          onChange={(v) => save({ active_provider: v })}
          options={visibleProviders.map((p) => ({
            value: p.kind,
            label: p.configured
              ? `${p.display_name} · connected`
              : p.display_name,
          }))}
        />
      </Field>

      {!settings.keychain_available && (
        <Field
          t={t}
          label="Allow plaintext credentials"
          hint="Use only on hosts without a session bus / keychain. Credentials are stored as JSON in agent_settings.json."
        >
          <Toggle
            t={t}
            checked={settings.allow_plaintext_api_key}
            onChange={(v) => save({ allow_plaintext_api_key: v })}
            label={settings.allow_plaintext_api_key ? "Allowed" : "Off"}
          />
        </Field>
      )}

      <Field
        t={t}
        stack
        anchor="default-model"
        label="Default model"
        hint={
          models.length > 0
            ? `From ${settings.providers[settings.active_provider]?.display_name ?? "the provider"}'s catalogue (${models.length} available).`
            : "Picked from the active provider's catalogue. New chats start with this model."
        }
      >
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Select<string>
              t={t}
              searchable
              searchPlaceholder="Search models…"
              popoverMinWidth={560}
              value={settings.default_model ?? ""}
              onChange={(v) => save({ default_model: v })}
              options={
                models.length > 0
                  ? models.map((m) => ({
                      value: m.id,
                      label: m.name ? `${m.id} — ${m.name}` : m.id,
                    }))
                  : settings.default_model
                    ? [
                        {
                          value: settings.default_model,
                          label: settings.default_model,
                        },
                      ]
                    : [{ value: "", label: "—" }]
              }
            />
          </div>
          <Btn
            t={t}
            variant="ghost"
            size="sm"
            onClick={refreshModels}
            disabled={
              modelsBusy ||
              !settings.providers[settings.active_provider]?.configured
            }
          >
            {modelsBusy ? "Loading…" : "Refresh"}
          </Btn>
        </div>
      </Field>

      <Field
        t={t}
        label="Default approval mode"
        hint="What new chats start with. 'Approve per write' is recommended; the per-chat toggle can override either way."
      >
        <Select<ApprovalMode>
          t={t}
          value={settings.default_approval_mode}
          onChange={(v) => save({ default_approval_mode: v })}
          options={[
            { value: "approve_per_write", label: "Approve per write" },
            { value: "allow_all_writes", label: "Allow all writes" },
          ]}
        />
      </Field>

      <Field
        t={t}
        label="Reasoning effort"
        hint="Universal knob — mapped to each provider's native field (Anthropic thinking, OpenAI reasoning_effort, OpenRouter reasoning). Higher effort = more thinking time + tokens. Models without reasoning support ignore it."
      >
        <Select<string>
          t={t}
          value={settings.reasoning.effort ?? "auto"}
          onChange={(v) =>
            save({
              reasoning: {
                effort: v === "auto" ? null : (v as ReasoningEffort),
                budget_tokens: settings.reasoning.budget_tokens ?? null,
              },
            })
          }
          options={[
            { value: "auto", label: "Auto (let API decide)" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ]}
        />
      </Field>

      <Field
        t={t}
        label="Reasoning token budget"
        hint="Cap on thinking tokens. Used directly by Anthropic & OpenRouter; OpenAI / Codex use only the effort knob above. Off disables thinking on Anthropic."
      >
        <Select<string>
          t={t}
          value={
            settings.reasoning.budget_tokens == null
              ? "off"
              : String(settings.reasoning.budget_tokens)
          }
          onChange={(v) =>
            save({
              reasoning: {
                effort: settings.reasoning.effort ?? null,
                budget_tokens: v === "off" ? 0 : Number(v),
              },
            })
          }
          options={[
            { value: "off", label: "Off" },
            { value: "4096", label: "4k (light)" },
            { value: "8192", label: "8k" },
            { value: "16384", label: "16k (recommended)" },
            { value: "32768", label: "32k (deep)" },
          ]}
        />
      </Field>

      <Field
        t={t}
        label="System prompt override"
        hint="Appended to the built-in baseline. Optional."
      >
        <textarea
          value={systemDraft}
          onChange={(e) => setSystemDraft(e.target.value)}
          onBlur={() => save({ system_prompt_override: systemDraft })}
          rows={4}
          placeholder="Extra instructions, persona, conventions…"
          style={{
            width: "100%",
            background: t.surfaceAlt,
            border: `1px solid ${t.borderSoft}`,
            color: t.text,
            borderRadius: R_MD,
            padding: "6px 8px",
            fontFamily: FF_MONO,
            fontSize: FS_MD,
            resize: "vertical",
            minHeight: 80,
          }}
        />
      </Field>

      <McpServersField
        t={t}
        settings={settings}
        save={save}
        setSettings={setSettings}
      />

      {error && (
        <div
          style={{
            marginTop: 12,
            padding: "8px 10px",
            background: t.bad + "1f",
            border: `1px solid ${t.bad}66`,
            borderRadius: R_MD,
          }}
        >
          <ErrorBlock
            t={t}
            message={error}
            kindLabel="AI settings"
            verb="save"
            inline
          />
        </div>
      )}
    </div>
  );
}

function ProviderRow({
  t,
  provider,
  busy,
  onSetKey,
  onDelete,
  onOauthLogin,
  onOauthCancel,
  onSetBaseUrl,
}: {
  t: ReturnType<typeof tokens>;
  provider: ProviderStatusWire;
  busy: boolean;
  onSetKey: (key: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onOauthLogin: () => Promise<void>;
  onOauthCancel: () => Promise<void>;
  onSetBaseUrl: (url: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [baseUrlDraft, setBaseUrlDraft] = useState(
    provider.base_url_override ?? "",
  );
  const [oauthInFlight, setOauthInFlight] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const supportsOauth = provider.auth_modes.includes("oauth" as AuthMode);
  const supportsKey = provider.auth_modes.includes("api_key" as AuthMode);

  const onTest = async () => {
    setTestResult(null);
    try {
      const res = await api.aiTestProvider({
        provider: provider.kind,
        base_url: provider.base_url_override,
        api_key: keyDraft.trim(),
      });
      setTestResult(
        res.ok
          ? `OK · ${res.model_count} models reachable`
          : `Failed: ${res.error ?? "unknown"}`,
      );
    } catch (e) {
      setTestResult(String(e));
    }
  };

  const onOauth = async () => {
    setOauthInFlight(true);
    try {
      await onOauthLogin();
    } finally {
      setOauthInFlight(false);
    }
  };

  const statusChip = provider.configured ? (
    <span
      style={{
        fontSize: FS_XS,
        fontFamily: FF_MONO,
        color: t.good,
        background: t.good + "1a",
        padding: "1px 6px",
        borderRadius: R_LG,
      }}
    >
      {provider.auth_mode === "oauth" ? "oauth" : "api key"}
      {provider.account_label ? ` · ${provider.account_label}` : ""}
    </span>
  ) : (
    <span
      style={{
        fontSize: FS_XS,
        fontFamily: FF_MONO,
        color: t.textMuted,
      }}
    >
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
          <span
            style={{
              fontFamily: FF_MONO,
              fontSize: FS_MD,
              color: t.text,
            }}
          >
            {provider.display_name}
          </span>
          {statusChip}
        </div>
        <Btn
          t={t}
          variant="ghost"
          size="sm"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : provider.configured ? "Manage" : "Connect"}
        </Btn>
      </div>

      {open && (
        <div
          style={{
            marginTop: 8,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {providerBlurb(provider.kind) && (
            <div
              style={{
                fontSize: FS_SM,
                color: t.textMuted,
                lineHeight: 1.45,
              }}
            >
              {providerBlurb(provider.kind)}
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
                    : `Sign in with ${oauthLabel(provider.kind)}`}
              </Btn>
              {oauthInFlight && (
                <Btn
                  t={t}
                  variant="ghost"
                  size="sm"
                  onClick={onOauthCancel}
                >
                  Cancel
                </Btn>
              )}
            </div>
          )}
          {supportsKey && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              <div
                style={{
                  fontSize: FS_XS,
                  color: t.textMuted,
                  fontFamily: FF_MONO,
                }}
              >
                {provider.auth_mode === "api_key"
                  ? "API key — replace below or clear to disconnect."
                  : "API key"}
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <input
                  type="password"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder={
                    provider.auth_mode === "api_key"
                      ? "•••••••• (replace)"
                      : keyPlaceholder(provider.kind)
                  }
                  style={{
                    flex: "1 1 220px",
                    minWidth: 0,
                    background: t.surface,
                    border: `1px solid ${t.borderSoft}`,
                    color: t.text,
                    borderRadius: R_MD,
                    padding: "6px 8px",
                    fontFamily: FF_MONO,
                    fontSize: FS_MD,
                  }}
                />
                <Btn
                  t={t}
                  variant="secondary"
                  size="sm"
                  onClick={onTest}
                  disabled={busy || !keyDraft.trim()}
                >
                  Test
                </Btn>
                <Btn
                  t={t}
                  variant="primary"
                  size="sm"
                  onClick={async () => {
                    if (!keyDraft.trim()) return;
                    await onSetKey(keyDraft.trim());
                    setKeyDraft("");
                  }}
                  disabled={busy || !keyDraft.trim()}
                >
                  Save
                </Btn>
              </div>
              {testResult && (
                <div
                  style={{
                    fontSize: FS_SM,
                    fontFamily: FF_MONO,
                    color: testResult.startsWith("OK") ? t.good : t.bad,
                  }}
                >
                  {testResult}
                </div>
              )}
            </div>
          )}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div
              style={{
                fontSize: FS_XS,
                color: t.textMuted,
                fontFamily: FF_MONO,
              }}
            >
              Base URL (override) — leave empty for{" "}
              <span style={{ color: t.text }}>
                {provider.default_base_url}
              </span>
            </div>
            <input
              type="text"
              value={baseUrlDraft}
              onChange={(e) => setBaseUrlDraft(e.target.value)}
              onBlur={(e) => onSetBaseUrl(e.target.value)}
              placeholder={provider.default_base_url}
              style={{
                width: "100%",
                background: t.surface,
                border: `1px solid ${t.borderSoft}`,
                color: t.text,
                borderRadius: R_MD,
                padding: "6px 8px",
                fontFamily: FF_MONO,
                fontSize: FS_MD,
              }}
            />
          </div>
          {provider.configured && (
            <div>
              <Btn
                t={t}
                variant="ghost"
                size="sm"
                onClick={onDelete}
                disabled={busy}
              >
                Disconnect
              </Btn>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function oauthLabel(kind: ProviderKind): string {
  switch (kind) {
    case "openai":
      return "ChatGPT";
    default:
      return "OAuth";
  }
}

// Per-provider descriptive blurb shown above the key field. `null` = no
// row-level description (most providers — the global hint is enough).
function providerBlurb(kind: ProviderKind): ReactNode | null {
  switch (kind) {
    case "opencode_zen":
      return (
        <>
          OpenCode Zen exposes a curated catalogue of coding models behind a
          single OpenAI-compatible endpoint. Leave the key blank to use the{" "}
          <strong>free tier</strong> (zero-cost models only) — or sign up at{" "}
          <a
            href="https://opencode.ai/zen"
            target="_blank"
            rel="noreferrer"
            style={{ color: "inherit", textDecoration: "underline" }}
          >
            opencode.ai/zen
          </a>{" "}
          to unlock the full catalogue.
        </>
      );
    default:
      return null;
  }
}

function keyPlaceholder(kind: ProviderKind): string {
  switch (kind) {
    case "anthropic":
      return "sk-ant-…";
    case "openai":
      return "sk-…";
    case "open_router":
      return "sk-or-v1-…";
    case "groq":
      return "gsk_…";
    case "opencode_zen":
      return "(blank = free tier)";
    case "ollama":
      return "(blank for local)";
    default:
      return "API key";
  }
}

// ─── External MCP servers editor ────────────────────────────────────────────

// Generates a stable id for new entries. The backend persists this verbatim;
// we only need uniqueness within the local list. `crypto.randomUUID` is
// available in every browser context Tauri exposes (WebKit / WebView2 /
// WKWebView all ship it). The fallback handles legacy embedded contexts.
function makeServerId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Parse an args textarea into the array form the backend wants.
//
// Two input shapes supported, picked automatically:
// - **Multi-line** (≥2 non-empty lines): one arg per line. Preserves args
//   that contain spaces (paths, JSON blobs) without forcing the operator
//   to quote them.
// - **Single line**: shell-style split with `'…'` / `"…"` quote handling
//   and `\<x>` escapes. Lets the operator paste a command line verbatim
//   (e.g. `-y @scope/pkg /some/path`) without thinking about delimiters.
//
// Empty input returns `[]`.
export function parseMcpArgs(text: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  if (lines.length > 1) return lines;
  return shellSplit(lines[0]!);
}

// Minimal POSIX-shell argument splitter. Handles single quotes (literal),
// double quotes (with `\` escapes for `"`, `\`, `$`, backtick), and
// backslash escapes outside quotes. Doesn't expand variables, globs, or
// command substitution — operators paste literal command lines, not
// shell scripts. Unterminated quotes silently fall through (last token
// is what we have so far) so the operator at least sees something to fix.
function shellSplit(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        cur += ch;
      }
    } else if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === "\\" && i + 1 < s.length) {
        const next = s[i + 1]!;
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          cur += next;
          i++;
        } else {
          cur += ch;
        }
      } else {
        cur += ch;
      }
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += s[i + 1]!;
      i++;
    } else if (ch === " " || ch === "\t") {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
    i++;
  }
  if (cur.length > 0 || inSingle || inDouble) {
    out.push(cur);
  }
  return out;
}

function McpServersField({
  t,
  settings,
  save,
  setSettings,
}: {
  t: Tokens;
  settings: AiSettingsWire;
  save: (
    patch: Parameters<typeof api.aiSetSettings>[0],
  ) => Promise<void>;
  setSettings: (next: AiSettingsWire) => void;
}) {
  const servers = settings.mcp_servers;
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  // Persist a fresh list. Local state is updated optimistically so the
  // editor stays responsive while the backend round-trips.
  const persist = (next: McpServerConfig[]) => {
    setSettings({ ...settings, mcp_servers: next });
    save({ mcp_servers: next });
  };

  const updateAt = (idx: number, patch: Partial<McpServerConfig>) => {
    const next = servers.slice();
    next[idx] = { ...next[idx]!, ...patch };
    persist(next);
  };

  const removeAt = (idx: number) => {
    const next = servers.slice();
    next.splice(idx, 1);
    persist(next);
  };

  const addServer = () => {
    const next: McpServerConfig[] = [
      ...servers,
      {
        id: makeServerId(),
        name: `server-${servers.length + 1}`,
        command: "",
        args: [],
        env: {},
        enabled: true,
      },
    ];
    persist(next);
    setOpenIds((prev) => {
      const s = new Set(prev);
      s.add(next[next.length - 1]!.id);
      return s;
    });
  };

  // Surface the legacy single-path setting once, with a one-click migrate
  // button. We don't auto-migrate on load — operators should see what's
  // happening to their config.
  const legacyPath =
    servers.length === 0 && settings.mcp_binary_path
      ? settings.mcp_binary_path
      : null;
  const migrateLegacy = () => {
    if (!legacyPath) return;
    const next: McpServerConfig[] = [
      {
        id: makeServerId(),
        name: "MCP server",
        command: legacyPath,
        args: [],
        env: {},
        enabled: true,
      },
    ];
    setSettings({ ...settings, mcp_servers: next, mcp_binary_path: null });
    save({ mcp_servers: next, mcp_binary_path: "" });
  };

  return (
    <Field
      t={t}
      stack
      anchor="mcp-servers"
      label="External MCP servers (optional)"
      hint="Each entry spawns a subprocess per chat and merges its tools with the native catalogue under the same approval gate. Native tools cover the full Kubernetes management surface — leave the list empty unless you want a non-Kubernetes MCP server (filesystem, github, custom). Changes take effect on the next chat open."
    >
      {legacyPath && (
        <div
          style={{
            marginBottom: 8,
            padding: "6px 10px",
            background: t.surfaceAlt,
            border: `1px solid ${t.borderSoft}`,
            borderRadius: R_MD,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: FS_SM,
            color: t.textMuted,
          }}
        >
          <span style={{ flex: 1 }}>
            Legacy single-binary path:{" "}
            <span style={{ color: t.text, fontFamily: FF_MONO }}>
              {legacyPath}
            </span>
          </span>
          <Btn t={t} variant="secondary" size="sm" onClick={migrateLegacy}>
            Migrate to list
          </Btn>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {servers.map((s, idx) => (
          <McpServerRow
            key={s.id}
            t={t}
            value={s}
            open={openIds.has(s.id)}
            onToggleOpen={() =>
              setOpenIds((prev) => {
                const next = new Set(prev);
                if (next.has(s.id)) {
                  next.delete(s.id);
                } else {
                  next.add(s.id);
                }
                return next;
              })
            }
            onChange={(patch) => updateAt(idx, patch)}
            onRemove={() => removeAt(idx)}
          />
        ))}
        {servers.length === 0 && !legacyPath && (
          <div
            style={{
              fontSize: FS_SM,
              color: t.textDim,
              fontStyle: "italic",
              padding: "4px 0",
            }}
          >
            No external MCP servers configured.
          </div>
        )}
        <div>
          <Btn t={t} variant="secondary" size="sm" onClick={addServer}>
            Add MCP server
          </Btn>
        </div>
      </div>
    </Field>
  );
}

function McpServerRow({
  t,
  value,
  open,
  onToggleOpen,
  onChange,
  onRemove,
}: {
  t: Tokens;
  value: McpServerConfig;
  open: boolean;
  onToggleOpen: () => void;
  onChange: (patch: Partial<McpServerConfig>) => void;
  onRemove: () => void;
}) {
  // Local drafts so typing doesn't roundtrip through the backend on every
  // keystroke. We commit on blur / explicit confirm, matching the rest of
  // the settings page.
  const [name, setName] = useState(value.name);
  const [command, setCommand] = useState(value.command);
  useEffect(() => setName(value.name), [value.name]);
  useEffect(() => setCommand(value.command), [value.command]);

  const argsText = useMemo(() => value.args.join("\n"), [value.args]);
  const envText = useMemo(
    () =>
      Object.entries(value.env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    [value.env],
  );

  // Test state — `running` is the in-flight request, `result` is the most
  // recent outcome. Cleared whenever the underlying value mutates so the
  // operator never sees a stale ✓ next to a new command.
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  useEffect(() => {
    setTestResult(null);
  }, [value.command, value.args, value.env, value.name]);

  const runTest = async () => {
    if (!command.trim()) {
      setTestResult({
        ok: false,
        tool_count: 0,
        tool_names: [],
        error: "command is empty",
      });
      return;
    }
    setTestRunning(true);
    setTestResult(null);
    try {
      // Use the in-buffer values so the operator can validate edits that
      // haven't been blur-committed yet — the test is meant to be quick
      // feedback, not "save first then test".
      const res = await api.mcpTestServer({ ...value, name, command });
      setTestResult(res);
    } catch (e) {
      setTestResult({
        ok: false,
        tool_count: 0,
        tool_names: [],
        error: String(e),
      });
    } finally {
      setTestRunning(false);
    }
  };

  return (
    <div
      style={{
        background: t.surfaceAlt,
        border: `1px solid ${t.borderSoft}`,
        borderRadius: R_MD,
        padding: "6px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          onClick={onToggleOpen}
          title={open ? "Collapse" : "Expand"}
          style={{
            background: "transparent",
            border: "none",
            color: t.textDim,
            cursor: "pointer",
            fontFamily: FF_MONO,
            fontSize: FS_SM,
            width: 16,
          }}
        >
          {open ? "▾" : "▸"}
        </button>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name !== value.name) onChange({ name });
          }}
          placeholder="name"
          style={{
            width: 120,
            background: t.surface,
            border: `1px solid ${t.borderSoft}`,
            color: t.text,
            borderRadius: R_MD,
            padding: "4px 6px",
            fontFamily: FF_MONO,
            fontSize: FS_SM,
          }}
        />
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onBlur={() => {
            if (command !== value.command) onChange({ command });
          }}
          placeholder="/usr/local/bin/my-mcp-server"
          style={{
            flex: 1,
            background: t.surface,
            border: `1px solid ${t.borderSoft}`,
            color: t.text,
            borderRadius: R_MD,
            padding: "4px 6px",
            fontFamily: FF_MONO,
            fontSize: FS_SM,
          }}
        />
        <Btn
          t={t}
          variant="ghost"
          size="sm"
          onClick={runTest}
          disabled={testRunning || !command.trim()}
          title="Spawn the server, run MCP initialize + tools/list, kill it. Confirms the binary is reachable and speaks MCP."
        >
          {testRunning ? "Testing…" : "Test"}
        </Btn>
        <Toggle
          t={t}
          checked={value.enabled}
          onChange={(v) => onChange({ enabled: v })}
          label={value.enabled ? "On" : "Off"}
        />
        <button
          type="button"
          onClick={onRemove}
          title="Remove server"
          style={{
            background: "transparent",
            border: "none",
            color: t.bad,
            cursor: "pointer",
            fontFamily: FF_MONO,
            fontSize: FS_MD,
            padding: "0 4px",
          }}
        >
          ×
        </button>
      </div>
      {testResult && <McpTestResultChip t={t} result={testResult} />}
      {open && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "120px 1fr",
            gap: 6,
            paddingLeft: 24,
          }}
        >
          <label
            style={{
              fontSize: FS_SM,
              color: t.textMuted,
              alignSelf: "start",
              paddingTop: 4,
            }}
            title="Either paste a single shell-style line (`-y @scope/pkg /path`) or put one arg per line (preserves args with spaces)."
          >
            Args
          </label>
          <textarea
            // Uncontrolled — the textarea owns its in-progress text; we
            // re-mount it (via `key`) only when the upstream value changes
            // externally so a parent rerender doesn't blow away typing.
            // After blur, the parsed args are joined back with newlines so
            // the operator immediately sees how their input was tokenized.
            key={`args-${argsText}`}
            defaultValue={argsText}
            onBlur={(e) => {
              const next = parseMcpArgs(e.target.value);
              if (
                next.length !== value.args.length ||
                next.some((a, i) => a !== value.args[i])
              ) {
                onChange({ args: next });
              }
            }}
            rows={2}
            placeholder={
              "Paste shell-style: -y @modelcontextprotocol/server-filesystem /path\nor one per line"
            }
            style={{
              background: t.surface,
              border: `1px solid ${t.borderSoft}`,
              color: t.text,
              borderRadius: R_MD,
              padding: "4px 6px",
              fontFamily: FF_MONO,
              fontSize: FS_SM,
              resize: "vertical",
              minHeight: 36,
            }}
          />
          <label
            style={{
              fontSize: FS_SM,
              color: t.textMuted,
              alignSelf: "start",
              paddingTop: 4,
            }}
          >
            Env
          </label>
          <textarea
            key={`env-${envText}`}
            defaultValue={envText}
            onBlur={(e) => {
              const next: Record<string, string> = {};
              for (const line of e.target.value.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const eq = trimmed.indexOf("=");
                if (eq <= 0) continue;
                const k = trimmed.slice(0, eq).trim();
                const v = trimmed.slice(eq + 1);
                if (k) next[k] = v;
              }
              onChange({ env: next });
            }}
            rows={3}
            placeholder="GITHUB_TOKEN=…"
            style={{
              background: t.surface,
              border: `1px solid ${t.borderSoft}`,
              color: t.text,
              borderRadius: R_MD,
              padding: "4px 6px",
              fontFamily: FF_MONO,
              fontSize: FS_SM,
              resize: "vertical",
              minHeight: 40,
            }}
          />
        </div>
      )}
    </div>
  );
}

// Inline result of `api.mcpTestServer`. Pulses into view under the row
// header; auto-clears when the operator edits any field.
function McpTestResultChip({
  t,
  result,
}: {
  t: Tokens;
  result: McpTestResult;
}) {
  if (result.ok) {
    const preview = result.tool_names.slice(0, 6).join(", ");
    const suffix =
      result.tool_count > result.tool_names.length
        ? `, +${result.tool_count - result.tool_names.length} more`
        : "";
    return (
      <div
        style={{
          marginLeft: 24,
          padding: "4px 8px",
          background: t.good + "1f",
          border: `1px solid ${t.good}66`,
          borderRadius: R_MD,
          color: t.good,
          fontFamily: FF_MONO,
          fontSize: FS_SM,
          display: "flex",
          alignItems: "center",
          gap: 6,
          wordBreak: "break-word",
        }}
        title={result.tool_names.join("\n")}
      >
        <span>✓</span>
        <span style={{ color: t.text }}>
          {result.tool_count} tool{result.tool_count === 1 ? "" : "s"}
        </span>
        {preview && (
          <span style={{ color: t.textMuted }}>
            · {preview}
            {suffix}
          </span>
        )}
      </div>
    );
  }
  return (
    <div
      style={{
        marginLeft: 24,
        padding: "4px 8px",
        background: t.bad + "1f",
        border: `1px solid ${t.bad}66`,
        borderRadius: R_MD,
        color: t.bad,
        fontFamily: FF_MONO,
        fontSize: FS_SM,
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        wordBreak: "break-word",
      }}
    >
      <span>✗</span>
      <span style={{ color: t.text }}>{result.error ?? "test failed"}</span>
    </div>
  );
}

