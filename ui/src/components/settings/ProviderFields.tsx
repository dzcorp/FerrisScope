import { useEffect, useState, type CSSProperties } from "react";
import { api } from "../../api";
import { FF_MONO, FS_MD, FS_SM, FS_XS, R_MD, type Tokens } from "../../theme";
import { Btn, Select } from "../ui";
import {
  AUTO,
  budgetOptions,
  effortOptions,
  specIsEmpty,
} from "../../lib/reasoning";
import type { ProviderStatusWire } from "../../types";

// The three editable fields of a provider row. Each is dumb about
// persistence: the row (and the backend behind it) decides what's valid and
// what a failed save means.

export function providerInputStyle(t: Tokens): CSSProperties {
  return {
    background: t.surface,
    border: `1px solid ${t.borderSoft}`,
    color: t.text,
    borderRadius: R_MD,
    padding: "6px 8px",
    fontFamily: FF_MONO,
    fontSize: FS_MD,
  };
}

function Label({ t, children }: { t: Tokens; children: React.ReactNode }) {
  return (
    <div style={{ fontSize: FS_XS, color: t.textMuted, fontFamily: FF_MONO }}>
      {children}
    </div>
  );
}

type TestOutcome = { ok: boolean; text: string };

export function ApiKeyField({
  t,
  provider,
  busy,
  baseUrl,
  onSetKey,
}: {
  t: Tokens;
  provider: ProviderStatusWire;
  busy: boolean;
  /// The row's current (possibly uncommitted) base URL, so Test can probe an
  /// override before it is saved.
  baseUrl: string;
  /// Resolves to whether the key was persisted.
  onSetKey: (key: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const typed = draft.trim();
  const canSave = !busy && (typed !== "" || provider.allows_blank_key);
  const canTest =
    !testing && !busy && (typed !== "" || provider.configured || provider.allows_blank_key);

  // A result describes the key + URL it was run with; once either changes
  // it would be a stale "OK" for something never tested.
  useEffect(() => setOutcome(null), [typed, baseUrl]);

  const test = async () => {
    setTesting(true);
    setOutcome(null);
    try {
      // Empty key = validate the already-saved credential backend-side.
      const res = await api.aiTestProvider({
        provider: provider.kind,
        base_url: baseUrl.trim() || null,
        api_key: typed,
      });
      setOutcome(
        res.ok
          ? { ok: true, text: `OK · ${res.model_count} models reachable` }
          : { ok: false, text: `Failed: ${res.error ?? "unknown"}` },
      );
    } catch (e) {
      setOutcome({ ok: false, text: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!canSave) return;
    // Keep what was typed if the save failed, so it isn't lost.
    if (await onSetKey(typed)) setDraft("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Label t={t}>
        {provider.auth_mode === "api_key"
          ? "API key — type a new one to replace it, or Disconnect to remove it."
          : "API key"}
        {provider.signup_url && (
          <>
            {" · "}
            <a
              href={provider.signup_url}
              target="_blank"
              rel="noreferrer"
              style={{ color: "inherit", textDecoration: "underline" }}
            >
              get a key
            </a>
          </>
        )}
      </Label>
      <div
        style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
      >
        <input
          type="password"
          aria-label={`${provider.display_name} API key`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder={
            provider.auth_mode === "api_key"
              ? "•••••••• (replace)"
              : provider.key_hint
          }
          style={{ ...providerInputStyle(t), flex: "1 1 220px", minWidth: 0 }}
        />
        <Btn
          t={t}
          variant="secondary"
          size="sm"
          onClick={test}
          disabled={!canTest}
          title={
            typed
              ? "Probe GET /models with the key in the field"
              : "Probe GET /models with the saved credential"
          }
        >
          {testing ? "Testing…" : "Test"}
        </Btn>
        <Btn t={t} variant="primary" size="sm" onClick={save} disabled={!canSave}>
          Save
        </Btn>
      </div>
      {outcome && (
        <div
          role="status"
          style={{
            fontSize: FS_SM,
            fontFamily: FF_MONO,
            color: outcome.ok ? t.good : t.bad,
          }}
        >
          {outcome.text}
        </div>
      )}
    </div>
  );
}

export function BaseUrlField({
  t,
  provider,
  value,
  error,
  onChange,
  onCommit,
}: {
  t: Tokens;
  provider: ProviderStatusWire;
  value: string;
  /// Why the last commit was refused, if it was.
  error: string | null;
  onChange: (next: string) => void;
  onCommit: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Label t={t}>
        Base URL (override) — leave empty for{" "}
        <span style={{ color: t.text }}>{provider.default_base_url}</span>
      </Label>
      <input
        type="text"
        aria-label={`${provider.display_name} base URL`}
        aria-invalid={error ? true : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
        }}
        placeholder={provider.default_base_url}
        style={{
          ...providerInputStyle(t),
          width: "100%",
          borderColor: error ? t.bad : t.borderSoft,
        }}
      />
      {error && (
        <div role="alert" style={{ fontSize: FS_SM, color: t.bad, fontFamily: FF_MONO }}>
          {error}
        </div>
      )}
    </div>
  );
}

export function CustomModelsField({
  t,
  provider,
  busy,
  onSetCustomModels,
}: {
  t: Tokens;
  provider: ProviderStatusWire;
  busy: boolean;
  /// Resolves to whether the list was persisted.
  onSetCustomModels: (models: string[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const models = provider.custom_models;

  const add = async () => {
    const id = draft.trim();
    if (!id) return;
    if (models.includes(id) || (await onSetCustomModels([...models, id]))) {
      setDraft("");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Label t={t}>
        Custom models — appended to whatever the provider enumerates. Required
        for endpoints with no <span style={{ color: t.text }}>GET /models</span>.
      </Label>
      {models.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {models.map((id) => (
            <span
              key={id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontFamily: FF_MONO,
                fontSize: FS_SM,
                color: t.text,
                background: t.surface,
                border: `1px solid ${t.borderSoft}`,
                borderRadius: R_MD,
                padding: "2px 6px",
              }}
            >
              {id}
              <button
                type="button"
                aria-label={`Remove ${id}`}
                title="Remove custom model"
                disabled={busy}
                onClick={() => onSetCustomModels(models.filter((m) => m !== id))}
                style={{
                  background: "transparent",
                  border: "none",
                  color: t.bad,
                  cursor: "pointer",
                  fontFamily: FF_MONO,
                  fontSize: FS_MD,
                  padding: 0,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="text"
          aria-label={`${provider.display_name} custom model id`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          placeholder="model id, e.g. kimi-k2.5"
          style={{ ...providerInputStyle(t), flex: 1, minWidth: 0 }}
        />
        <Btn
          t={t}
          variant="secondary"
          size="sm"
          disabled={busy || !draft.trim()}
          onClick={add}
        >
          Add
        </Btn>
      </div>
    </div>
  );
}

/// Reasoning for one provider, in that provider's own terms: the effort names
/// it (or its default model) accepts, and a token budget only where one is
/// used — nothing is shown that the provider can't act on.
export function ReasoningField({
  t,
  provider,
  busy,
  onSetReasoning,
}: {
  t: Tokens;
  provider: ProviderStatusWire;
  /// A settings save is in flight: ignore changes until it lands, so two
  /// quick picks can't race their writes.
  busy: boolean;
  /// Persist the choice: an effort name or `null` (auto), and a budget or
  /// `null` (default). Resolves to whether it was saved.
  onSetReasoning: (
    effort: string | null,
    budget: number | null,
  ) => Promise<boolean>;
}) {
  const spec = provider.reasoning_spec;
  const saved = provider.reasoning;
  const effort = saved.effort ?? null;
  const budget = saved.budget_tokens ?? null;
  const hasEfforts = spec.efforts.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Label t={t}>Reasoning</Label>
      {specIsEmpty(spec) && (
        <div style={{ fontSize: FS_SM, color: t.textMuted }}>
          No reasoning controls for {provider.display_name}.
        </div>
      )}
      {hasEfforts && (
        <>
          <Select<string>
            t={t}
            value={effort ?? AUTO}
            options={effortOptions(spec, effort)}
            onChange={(v) => {
              if (!busy) void onSetReasoning(v === AUTO ? null : v, budget);
            }}
          />
          <div style={{ fontSize: FS_XS, color: t.textMuted, lineHeight: 1.4 }}>
            {spec.from_catalogue
              ? "Levels this provider's models accept. A model without the chosen level uses the nearest one."
              : "Typical levels. A model without the chosen level uses the nearest one."}
          </div>
        </>
      )}
      {spec.budget && (
        <>
          <Select<string>
            t={t}
            value={budget === null ? "default" : String(budget)}
            options={budgetOptions(spec.budget, budget)}
            onChange={(v) => {
              if (!busy)
                void onSetReasoning(effort, v === "default" ? null : Number(v));
            }}
          />
          <div style={{ fontSize: FS_XS, color: t.textMuted, lineHeight: 1.4 }}>
            {hasEfforts
              ? "Token budget for models that take one (e.g. an older Claude); models with effort levels follow the effort above."
              : "Cap on thinking tokens for this provider's models."}
          </div>
        </>
      )}
      {!hasEfforts && !spec.budget && spec.toggle && (
        <div style={{ fontSize: FS_SM, color: t.textMuted }}>
          These models only switch thinking on or off; there is no level to
          choose.
        </div>
      )}
    </div>
  );
}
