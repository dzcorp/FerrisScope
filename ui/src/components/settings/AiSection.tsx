import { useEffect, useMemo, useRef, useState } from "react";
import { useResolvedTheme } from "../../store";
import { api } from "../../api";
import type {
  AiSettingsWire,
  ApprovalMode,
  McpServerConfig,
  McpTransport,
  McpTestResult,
  ModelInfo,
  ProviderKind,
} from "../../types";
import {
  FF_MONO,
  type ThemeMode,
  type Tokens,
  R_MD,
  FS_MD,
  FS_SM,
  FS_XS,
  hexWithAlpha,
} from "../../theme";
import { Btn, ErrorBlock, Field, SectionHeader, Select, Toggle } from "../ui";
import { isProviderUsable, orderedProviders } from "../../lib/providers";
import { ProviderRow } from "./ProviderRow";
import {
  KvEditor,
  kvBufferFromPairs,
  kvBufferToMap,
  kvBufferDirty,
  type KvBuffer,
} from "../detail/edit";

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
  const [listed, setListed] = useState<{
    provider: ProviderKind;
    models: ModelInfo[];
  } | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  // Orders overlapping model fetches: a slow answer for a provider the
  // operator has since left must not overwrite the current list.
  const modelsReq = useRef(0);

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
    const req = ++modelsReq.current;
    const active = settings.providers[settings.active_provider];
    if (!active || !isProviderUsable(active)) {
      setListed(null);
      setModelsError(null);
      setModelsBusy(false);
      return;
    }
    setModelsBusy(true);
    setModelsError(null);
    try {
      const m = await api.aiListModels(settings.active_provider);
      if (req === modelsReq.current)
        setListed({ provider: settings.active_provider, models: m });
    } catch (e) {
      if (req === modelsReq.current) {
        setListed(null);
        setModelsError(String(e));
      }
    } finally {
      if (req === modelsReq.current) setModelsBusy(false);
    }
  };

  // Only the active provider's own list is shown: right after a switch the
  // previous provider's models must not sit beside the new default.
  const models =
    listed && listed.provider === settings?.active_provider
      ? listed.models
      : [];

  // Re-list whenever something that changes the list does: which provider is
  // active, whether it is usable, its endpoint, or its custom model ids.
  const activeProvider = settings?.providers[settings.active_provider];
  const modelsKey = activeProvider
    ? [
        activeProvider.kind,
        isProviderUsable(activeProvider),
        activeProvider.base_url_override ?? "",
        activeProvider.custom_models.join("\n"),
      ].join("|")
    : "";
  useEffect(() => {
    refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsKey]);

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

  /// Persists `patch`; resolves to why it was refused, or `null` once saved.
  const trySave = async (
    patch: Parameters<typeof api.aiSetSettings>[0],
  ): Promise<string | null> => {
    setBusy(true);
    try {
      const next = await api.aiSetSettings(patch);
      setSettings(next);
      setSystemDraft(next.system_prompt_override ?? "");
      return null;
    } catch (e) {
      return String(e);
    } finally {
      setBusy(false);
    }
  };

  /// `trySave` that reports a refusal in the page-level error block.
  /// Resolves to whether the patch was persisted.
  const save = async (
    patch: Parameters<typeof api.aiSetSettings>[0],
  ): Promise<boolean> => {
    setError(null);
    const refused = await trySave(patch);
    if (refused !== null) setError(refused);
    return refused === null;
  };

  const onSetCredential = async (
    provider: ProviderKind,
    key: string,
  ): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.aiSetCredential(provider, {
        type: "api_key",
        key,
      });
      setSettings(next);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
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

  // Backend order — the chat-header switcher uses the same list.
  const visibleProviders = orderedProviders(settings);

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
                trySave({
                  provider_base_url: { provider: p.kind, base_url: url },
                })
              }
              onSetCustomModels={(models) =>
                save({
                  provider_custom_models: { provider: p.kind, models },
                })
              }
              onSetEnabled={(enabled) =>
                save({ provider_enabled: { provider: p.kind, enabled } })
              }
              onSetReasoning={(effort, budget) =>
                save({
                  provider_reasoning: {
                    provider: p.kind,
                    effort,
                    budget_tokens: budget,
                  },
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
        hint="Which enabled provider new chats use by default. Switching here doesn't affect already-open chats — they keep the provider they were created with."
      >
        <Select<ProviderKind>
          t={t}
          value={settings.active_provider}
          onChange={(v) => save({ active_provider: v })}
          options={visibleProviders
            .filter((p) => p.enabled)
            .map((p) => ({
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
              !isProviderUsable(
                settings.providers[settings.active_provider] ?? {
                  enabled: false,
                  configured: false,
                },
              )
            }
          >
            {modelsBusy ? "Loading…" : "Refresh"}
          </Btn>
        </div>
        {modelsError && (
          <div style={{ marginTop: 6 }} data-testid="models-error">
            <ErrorBlock t={t} message={modelsError} kindLabel="model list" inline />
          </div>
        )}
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
          data-testid="page-error"
          style={{
            marginTop: 12,
            padding: "8px 10px",
            background: hexWithAlpha(t.bad, 0.12),
            border: `1px solid ${hexWithAlpha(t.bad, 0.4)}`,
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
  ) => Promise<boolean>;
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
        transport: "stdio",
        command: "",
        url: null,
        args: [],
        env: {},
        headers: {},
        trust_as_read: false,
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
        transport: "stdio",
        command: legacyPath,
        url: null,
        args: [],
        env: {},
        headers: {},
        trust_as_read: false,
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

// Exported for the interaction test (`AiSection.mcpEnv.test.tsx`); the
// settings page renders it via `McpServersField`.
export function McpServerRow({
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
  const [url, setUrl] = useState(value.url ?? "");
  useEffect(() => setName(value.name), [value.name]);
  useEffect(() => setCommand(value.command), [value.command]);
  useEffect(() => setUrl(value.url ?? ""), [value.url]);

  const isRemote = value.transport === "sse" || value.transport === "http";

  const argsText = useMemo(() => value.args.join("\n"), [value.args]);

  // Env is edited through the shared KvEditor (KEY / VALUE fields + Add),
  // not a `KEY=VALUE` textarea. The buffer is the in-progress draft; we
  // commit it to the backend on blur (see the wrapping div below) so typing
  // doesn't roundtrip per keystroke. A stable signature of the upstream env
  // re-seeds the buffer when the canonical value changes (our own commit, a
  // migrate, or an external edit) without clobbering edits mid-typing.
  const envSig = useMemo(
    () =>
      Object.entries(value.env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    [value.env],
  );
  const [envBuffer, setEnvBuffer] = useState<KvBuffer>(() =>
    kvBufferFromPairs(Object.entries(value.env)),
  );
  const seededEnvRef = useRef(envSig);
  useEffect(() => {
    if (seededEnvRef.current === envSig) return;
    seededEnvRef.current = envSig;
    setEnvBuffer(kvBufferFromPairs(Object.entries(value.env)));
  }, [envSig, value.env]);

  // Push the buffer to the backend only when something actually changed —
  // kvBufferDirty is 0 right after a (re)seed, so re-renders don't trigger
  // redundant saves.
  const commitEnv = () => {
    if (kvBufferDirty(envBuffer) > 0) {
      onChange({ env: kvBufferToMap(envBuffer) });
    }
  };

  // Headers (sse / http auth etc.) reuse the same KvEditor + blur-commit
  // pattern as env — see the env buffer above for the mechanics.
  const headersSig = useMemo(
    () =>
      Object.entries(value.headers)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    [value.headers],
  );
  const [headersBuffer, setHeadersBuffer] = useState<KvBuffer>(() =>
    kvBufferFromPairs(Object.entries(value.headers)),
  );
  const seededHeadersRef = useRef(headersSig);
  useEffect(() => {
    if (seededHeadersRef.current === headersSig) return;
    seededHeadersRef.current = headersSig;
    setHeadersBuffer(kvBufferFromPairs(Object.entries(value.headers)));
  }, [headersSig, value.headers]);
  const commitHeaders = () => {
    if (kvBufferDirty(headersBuffer) > 0) {
      onChange({ headers: kvBufferToMap(headersBuffer) });
    }
  };

  // Test state — `running` is the in-flight request, `result` is the most
  // recent outcome. Cleared whenever the underlying value mutates so the
  // operator never sees a stale ✓ next to a new command.
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  useEffect(() => {
    setTestResult(null);
  }, [
    value.transport,
    value.command,
    value.url,
    value.args,
    value.env,
    value.headers,
    value.name,
  ]);

  const runTest = async () => {
    if (isRemote ? !url.trim() : !command.trim()) {
      setTestResult({
        ok: false,
        tool_count: 0,
        tool_names: [],
        error: isRemote ? "url is empty" : "command is empty",
      });
      return;
    }
    setTestRunning(true);
    setTestResult(null);
    try {
      // Use the in-buffer values so the operator can validate edits that
      // haven't been blur-committed yet — the test is meant to be quick
      // feedback, not "save first then test". Env / headers come from the
      // live KvEditor buffers for the same reason.
      const res = await api.mcpTestServer({
        ...value,
        name,
        command,
        url: url.trim() ? url.trim() : null,
        env: kvBufferToMap(envBuffer),
        headers: kvBufferToMap(headersBuffer),
      });
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
            width: 110,
            background: t.surface,
            border: `1px solid ${t.borderSoft}`,
            color: t.text,
            borderRadius: R_MD,
            padding: "4px 6px",
            fontFamily: FF_MONO,
            fontSize: FS_SM,
          }}
        />
        <Select<McpTransport>
          t={t}
          value={value.transport}
          onChange={(transport) => onChange({ transport })}
          options={[
            { value: "stdio", label: "stdio" },
            { value: "http", label: "http" },
            { value: "sse", label: "sse" },
          ]}
          fullWidth={false}
          style={{ width: 84 }}
        />
        {isRemote ? (
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => {
              const next = url.trim() ? url.trim() : null;
              if (next !== value.url) onChange({ url: next });
            }}
            placeholder="https://mcp.example.com/rpc"
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
        ) : (
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
        )}
        <Btn
          t={t}
          variant="ghost"
          size="sm"
          onClick={runTest}
          disabled={testRunning || (isRemote ? !url.trim() : !command.trim())}
          title={
            isRemote
              ? "Connect to the URL, run MCP initialize + tools/list. Confirms the endpoint is reachable and speaks MCP."
              : "Spawn the server, run MCP initialize + tools/list, kill it. Confirms the binary is reachable and speaks MCP."
          }
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
          {/* Trust toggle — applies to every transport. */}
          <label
            style={{ fontSize: FS_SM, color: t.textMuted, alignSelf: "center" }}
            title="Treat every tool from this server as a read: auto-run with no approval prompt. Only enable for servers you fully trust — it bypasses the per-write approval gate."
          >
            Trust
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Toggle
              t={t}
              checked={value.trust_as_read}
              onChange={(v) => onChange({ trust_as_read: v })}
              label="Auto-approve all tools"
            />
            {value.trust_as_read && (
              <span style={{ fontSize: FS_XS, color: t.warn }}>
                Tools run without approval
              </span>
            )}
          </div>

          {!isRemote && (
            <>
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
                title="Extra environment variables passed to the server process. One KEY / VALUE pair per row — no quotes or = needed."
              >
                Env
              </label>
              <div
                // Commit on blur of the whole editor, not when tabbing between
                // a row's KEY and VALUE inputs. relatedTarget inside the div
                // means focus stayed within the editor → keep the draft local.
                onBlur={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    return;
                  }
                  commitEnv();
                }}
              >
                <KvEditor
                  t={t}
                  buffer={envBuffer}
                  onChange={setEnvBuffer}
                  keyPlaceholder="KEY"
                  valuePlaceholder="VALUE"
                  // Reject keys with '=' or whitespace — invalid env names and
                  // the exact mistake the old `KEY=VALUE` textarea invited.
                  validateKey={(k) => !/[\s=]/.test(k)}
                />
              </div>
            </>
          )}

          {isRemote && (
            <>
              <label
                style={{
                  fontSize: FS_SM,
                  color: t.textMuted,
                  alignSelf: "start",
                  paddingTop: 4,
                }}
                title="Extra HTTP headers sent on every request — typically Authorization for a remote server's token. One NAME / VALUE pair per row."
              >
                Headers
              </label>
              <div
                onBlur={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    return;
                  }
                  commitHeaders();
                }}
              >
                <KvEditor
                  t={t}
                  buffer={headersBuffer}
                  onChange={setHeadersBuffer}
                  keyPlaceholder="Header"
                  valuePlaceholder="value"
                  // HTTP header names can't contain whitespace or a colon.
                  validateKey={(k) => !/[\s:]/.test(k)}
                />
              </div>
            </>
          )}
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
          background: hexWithAlpha(t.good, 0.12),
          border: `1px solid ${hexWithAlpha(t.good, 0.4)}`,
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
        background: hexWithAlpha(t.bad, 0.12),
        border: `1px solid ${hexWithAlpha(t.bad, 0.4)}`,
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

