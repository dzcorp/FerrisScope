// Provider row: the enable switch (Zen ships off, switching it on goes through
// the disclosure), and the key / base URL / custom model / disconnect fields.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProviderRow } from "./ProviderRow";
import { tokens } from "../../theme";
import { useAppStore } from "../../store";
import type { ProviderStatusWire } from "../../types";

const mocks = vi.hoisted(() => ({
  aiTestProvider: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("../../api", () => ({ api: { aiTestProvider: mocks.aiTestProvider } }));
vi.mock("../../lib/dialog", () => ({ confirm: mocks.confirm }));

const t = tokens("dark");

// The Select popover scrolls the active option into view; jsdom lacks it.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  mocks.aiTestProvider.mockReset();
  mocks.confirm.mockReset();
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ modals: [] });
});

const NOTICE = {
  headline: "Enable OpenCode Zen free tier?",
  points: ["Free: no account or API key.", "Prompts leave your machine."],
  learn_more_url: "https://opencode.ai/docs/zen#privacy",
};

function provider(overrides: Partial<ProviderStatusWire> = {}): ProviderStatusWire {
  return {
    kind: "anthropic",
    id: "anthropic",
    display_name: "Anthropic",
    default_base_url: "https://api.anthropic.com/v1",
    base_url_override: null,
    auth_modes: ["api_key"],
    auth_mode: null,
    configured: false,
    account_label: null,
    custom_models: [],
    enabled: true,
    enable_notice: null,
    free_tier: false,
    allows_blank_key: false,
    key_hint: "sk-ant-…",
    oauth_label: null,
    signup_url: null,
    description: null,
    reasoning: {},
    reasoning_spec: { efforts: [], budget: null, toggle: false, from_catalogue: true },
    ...overrides,
  };
}

function zen(overrides: Partial<ProviderStatusWire> = {}): ProviderStatusWire {
  return provider({
    kind: "opencode_zen",
    id: "opencode_zen",
    display_name: "OpenCode Zen",
    default_base_url: "https://opencode.ai/zen/v1",
    enabled: false,
    enable_notice: NOTICE,
    key_hint: "(blank = free tier)",
    ...overrides,
  });
}

type Handlers = {
  onSetKey: Mock<(key: string) => Promise<boolean>>;
  onDelete: Mock<() => Promise<void>>;
  onOauthLogin: Mock<() => Promise<void>>;
  onOauthCancel: Mock<() => Promise<void>>;
  onSetBaseUrl: Mock<(url: string) => Promise<string | null>>;
  onSetCustomModels: Mock<(models: string[]) => Promise<boolean>>;
  onSetEnabled: Mock<(enabled: boolean) => Promise<boolean>>;
  onSetReasoning: Mock<(effort: string | null, budget: number | null) => Promise<boolean>>;
};

function handlers(): Handlers {
  return {
    onSetKey: vi.fn<(key: string) => Promise<boolean>>().mockResolvedValue(true),
    onDelete: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onOauthLogin: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onOauthCancel: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    onSetBaseUrl: vi.fn<(url: string) => Promise<string | null>>().mockResolvedValue(null),
    onSetCustomModels: vi
      .fn<(models: string[]) => Promise<boolean>>()
      .mockResolvedValue(true),
    onSetEnabled: vi.fn<(enabled: boolean) => Promise<boolean>>().mockResolvedValue(true),
    onSetReasoning: vi
      .fn<(effort: string | null, budget: number | null) => Promise<boolean>>()
      .mockResolvedValue(true),
  };
}

function renderRow(p: ProviderStatusWire, h: Handlers = handlers(), busy = false) {
  const ui = (next: ProviderStatusWire) => (
    <ProviderRow t={t} provider={next} busy={busy} {...h} />
  );
  const utils = render(ui(p));
  return { ...h, rerenderWith: (next: ProviderStatusWire) => utils.rerender(ui(next)) };
}

/// Expand the row (Connect when unconnected, Manage when connected).
function expand() {
  fireEvent.click(screen.getByRole("button", { name: /^(Connect|Manage)$/ }));
}

describe("ProviderRow enable switch", () => {
  it("a disabled provider is inert: marked disabled, no Connect/Manage", () => {
    renderRow(zen());
    expect(screen.getByText("disabled")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
  });

  it("switching Zen on shows the disclosure and does not enable yet", () => {
    const { onSetEnabled } = renderRow(zen());
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("dialog", { name: NOTICE.headline })).toBeInTheDocument();
    expect(screen.getByText(NOTICE.points[1]!)).toBeInTheDocument();
    expect(onSetEnabled).not.toHaveBeenCalled();
  });

  it("cancelling the disclosure leaves the provider off", () => {
    const { onSetEnabled } = renderRow(zen());
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSetEnabled).not.toHaveBeenCalled();
  });

  it("confirming the disclosure enables the provider and closes the dialog", async () => {
    const { onSetEnabled } = renderRow(zen());
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onSetEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("keeps the dialog open when the save fails, so the operator can retry", async () => {
    const h = handlers();
    h.onSetEnabled.mockResolvedValue(false);
    renderRow(zen(), h);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(h.onSetEnabled).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Enable" })).not.toBeDisabled(),
    );
  });

  it("a provider without a disclosure switches on immediately", () => {
    const { onSetEnabled } = renderRow(provider({ enabled: false }));
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSetEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("switching an enabled provider off needs no confirmation", () => {
    const { onSetEnabled } = renderRow(zen({ enabled: true, configured: true, free_tier: true }));
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSetEnabled).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("locks the switch while a settings save is in flight", () => {
    renderRow(zen(), handlers(), true);
    expect(screen.getByRole("switch")).toBeDisabled();
  });
});

describe("ProviderRow status chip", () => {
  it("says free tier — not api key — when running on the public key", () => {
    renderRow(zen({ enabled: true, configured: true, auth_mode: "api_key", free_tier: true }));
    expect(screen.getByText("free tier")).toBeInTheDocument();
    expect(screen.queryByText(/api key/)).toBeNull();
  });

  it("shows the credential kind and OAuth account label", () => {
    renderRow(
      provider({
        kind: "openai",
        auth_modes: ["oauth", "api_key"],
        auth_mode: "oauth",
        configured: true,
        account_label: "acct-1",
      }),
    );
    expect(screen.getByText("oauth · acct-1")).toBeInTheDocument();
  });

  it("says not connected before a credential exists", () => {
    renderRow(provider());
    expect(screen.getByText("not connected")).toBeInTheDocument();
  });
});

describe("ProviderRow backend-supplied copy", () => {
  it("renders the description, key hint and a get-a-key link from the wire", () => {
    renderRow(
      provider({
        description: "Gateway for Claude.",
        signup_url: "https://console.anthropic.com/settings/keys",
      }),
    );
    expand();
    expect(screen.getByText("Gateway for Claude.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("sk-ant-…")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "get a key" })).toHaveAttribute(
      "href",
      "https://console.anthropic.com/settings/keys",
    );
  });

  it("omits the link when the provider has no signup page", () => {
    renderRow(provider());
    expand();
    expect(screen.queryByRole("link", { name: "get a key" })).toBeNull();
  });

  it("labels the OAuth button from the wire and offers Re-authorize once signed in", () => {
    const { rerenderWith } = renderRow(
      provider({ kind: "openai", auth_modes: ["oauth", "api_key"], oauth_label: "ChatGPT" }),
    );
    expand();
    expect(screen.getByRole("button", { name: "Sign in with ChatGPT" })).toBeInTheDocument();
    rerenderWith(
      provider({
        kind: "openai",
        auth_modes: ["oauth", "api_key"],
        oauth_label: "ChatGPT",
        auth_mode: "oauth",
        configured: true,
      }),
    );
    expect(screen.getByRole("button", { name: "Re-authorize" })).toBeInTheDocument();
  });

  it("hides the key field for an OAuth-only provider", () => {
    renderRow(provider({ auth_modes: ["oauth"], oauth_label: "X" }));
    expand();
    expect(screen.queryByLabelText(/API key/)).toBeNull();
  });
});

describe("ProviderRow API key", () => {
  const keyInput = () => screen.getByLabelText("Anthropic API key");

  it("saves the trimmed key, clears the field, and Enter does the same", async () => {
    const { onSetKey } = renderRow(provider());
    expand();
    fireEvent.change(keyInput(), { target: { value: "  sk-ant-1  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSetKey).toHaveBeenCalledWith("sk-ant-1"));
    await waitFor(() => expect(keyInput()).toHaveValue(""));

    fireEvent.change(keyInput(), { target: { value: "sk-ant-2" } });
    fireEvent.keyDown(keyInput(), { key: "Enter" });
    await waitFor(() => expect(onSetKey).toHaveBeenLastCalledWith("sk-ant-2"));
  });

  it("keeps what was typed when the save fails", async () => {
    const h = handlers();
    h.onSetKey.mockResolvedValue(false);
    renderRow(provider(), h);
    expand();
    fireEvent.change(keyInput(), { target: { value: "sk-ant-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(h.onSetKey).toHaveBeenCalled());
    expect(keyInput()).toHaveValue("sk-ant-1");
  });

  it("won't save a blank key unless the endpoint may be open", async () => {
    const strict = renderRow(provider());
    expand();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.keyDown(keyInput(), { key: "Enter" });
    expect(strict.onSetKey).not.toHaveBeenCalled();
    cleanup();

    const open = renderRow(
      provider({ kind: "ollama", display_name: "Ollama", allows_blank_key: true }),
    );
    expand();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(open.onSetKey).toHaveBeenCalledWith(""));
  });

  it("Test probes with the typed key and the uncommitted base URL, and shows the result", async () => {
    mocks.aiTestProvider.mockResolvedValue({ ok: true, model_count: 7, error: null });
    renderRow(provider());
    expand();
    fireEvent.change(keyInput(), { target: { value: "sk-ant-1" } });
    fireEvent.change(screen.getByLabelText("Anthropic base URL"), {
      target: { value: "https://gw.example.com/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("OK · 7 models reachable")).toBeInTheDocument();
    expect(mocks.aiTestProvider).toHaveBeenCalledWith({
      provider: "anthropic",
      base_url: "https://gw.example.com/v1",
      api_key: "sk-ant-1",
    });
  });

  it("shows a failed probe in the error colour and drops it once the key changes", async () => {
    mocks.aiTestProvider.mockResolvedValue({ ok: false, model_count: 0, error: "HTTP 401: nope" });
    renderRow(provider());
    expand();
    fireEvent.change(keyInput(), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    const result = await screen.findByText("Failed: HTTP 401: nope");
    expect(result).toHaveAttribute("role", "status");
    fireEvent.change(keyInput(), { target: { value: "bad2" } });
    expect(screen.queryByText("Failed: HTTP 401: nope")).toBeNull();
  });

  it("surfaces a rejected probe call instead of hanging on Testing…", async () => {
    mocks.aiTestProvider.mockRejectedValue(new Error("ipc down"));
    renderRow(provider());
    expand();
    fireEvent.change(keyInput(), { target: { value: "k" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText(/ipc down/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test" })).not.toBeDisabled();
  });

  it("Test needs something to test: a typed key, a saved credential, or an open endpoint", () => {
    renderRow(provider());
    expand();
    expect(screen.getByRole("button", { name: "Test" })).toBeDisabled();
    fireEvent.change(keyInput(), { target: { value: "k" } });
    expect(screen.getByRole("button", { name: "Test" })).not.toBeDisabled();
  });
});

describe("ProviderRow base URL", () => {
  const urlInput = () => screen.getByLabelText("Anthropic base URL");

  it("commits a changed, trimmed URL on blur", async () => {
    const { onSetBaseUrl } = renderRow(provider());
    expand();
    fireEvent.change(urlInput(), { target: { value: "  https://gw.example.com/v1  " } });
    fireEvent.blur(urlInput());
    await waitFor(() => expect(onSetBaseUrl).toHaveBeenCalledWith("https://gw.example.com/v1"));
  });

  it("does not write when nothing changed", () => {
    const { onSetBaseUrl } = renderRow(provider({ base_url_override: "https://gw.example.com/v1" }));
    expand();
    fireEvent.blur(urlInput());
    expect(onSetBaseUrl).not.toHaveBeenCalled();
  });

  it("clearing an override commits an empty string", async () => {
    const { onSetBaseUrl } = renderRow(provider({ base_url_override: "https://gw.example.com/v1" }));
    expand();
    fireEvent.change(urlInput(), { target: { value: "" } });
    fireEvent.blur(urlInput());
    await waitFor(() => expect(onSetBaseUrl).toHaveBeenCalledWith(""));
  });

  it("shows the backend's reason inline and marks the field invalid", async () => {
    const h = handlers();
    h.onSetBaseUrl.mockResolvedValue("base URL must start with http:// or https://");
    renderRow(provider(), h);
    expand();
    fireEvent.change(urlInput(), { target: { value: "gw.example.com" } });
    fireEvent.blur(urlInput());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "base URL must start with http:// or https://",
    );
    expect(urlInput()).toHaveAttribute("aria-invalid", "true");
  });

  it("follows the persisted value, e.g. after the backend trims a trailing slash", () => {
    const { rerenderWith } = renderRow(provider());
    expand();
    fireEvent.change(urlInput(), { target: { value: "https://gw.example.com/v1/" } });
    rerenderWith(provider({ base_url_override: "https://gw.example.com/v1" }));
    expect(urlInput()).toHaveValue("https://gw.example.com/v1");
  });
});

describe("ProviderRow custom models", () => {
  const modelInput = () => screen.getByLabelText("Anthropic custom model id");

  it("adds a model via the button and via Enter, trimmed", async () => {
    const { onSetCustomModels } = renderRow(provider({ custom_models: ["a"] }));
    expand();
    fireEvent.change(modelInput(), { target: { value: " b " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onSetCustomModels).toHaveBeenCalledWith(["a", "b"]));
    await waitFor(() => expect(modelInput()).toHaveValue(""));

    fireEvent.change(modelInput(), { target: { value: "c" } });
    fireEvent.keyDown(modelInput(), { key: "Enter" });
    await waitFor(() => expect(onSetCustomModels).toHaveBeenLastCalledWith(["a", "c"]));
  });

  it("ignores a duplicate without writing, and clears the field", async () => {
    const { onSetCustomModels } = renderRow(provider({ custom_models: ["a"] }));
    expand();
    fireEvent.change(modelInput(), { target: { value: "a" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(modelInput()).toHaveValue(""));
    expect(onSetCustomModels).not.toHaveBeenCalled();
  });

  it("keeps the draft when the save fails", async () => {
    const h = handlers();
    h.onSetCustomModels.mockResolvedValue(false);
    renderRow(provider(), h);
    expand();
    fireEvent.change(modelInput(), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(h.onSetCustomModels).toHaveBeenCalled());
    expect(modelInput()).toHaveValue("x");
  });

  it("Add stays disabled for a blank draft; × removes just that model", () => {
    const { onSetCustomModels } = renderRow(provider({ custom_models: ["a", "b"] }));
    expand();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove a" }));
    expect(onSetCustomModels).toHaveBeenCalledWith(["b"]);
  });
});

describe("ProviderRow disconnect", () => {
  const connected = () => provider({ configured: true, auth_mode: "api_key" });

  it("asks first and only deletes on confirm", async () => {
    mocks.confirm.mockResolvedValue(true);
    const { onDelete } = renderRow(connected());
    expand();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Disconnect Anthropic?", tone: "danger" }),
    );
  });

  it("keeps the credential when the operator declines", async () => {
    mocks.confirm.mockResolvedValue(false);
    const { onDelete } = renderRow(connected());
    expand();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("offers nothing to disconnect on the keyless free tier or an unconnected row", () => {
    renderRow(zen({ enabled: true, configured: true, auth_mode: "api_key", free_tier: true }));
    expand();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    cleanup();
    renderRow(provider());
    expand();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });
});

describe("ProviderRow reasoning", () => {
  const withSpec = (
    spec: Partial<ProviderStatusWire["reasoning_spec"]>,
    reasoning: ProviderStatusWire["reasoning"] = {},
    over: Partial<ProviderStatusWire> = {},
  ) =>
    provider({
      reasoning,
      reasoning_spec: {
        efforts: [],
        budget: null,
        toggle: false,
        from_catalogue: true,
        ...spec,
      },
      ...over,
    });
  // Each option carries a (possibly invisible) check glyph; drop it.
  const optionNames = () =>
    screen
      .getAllByRole("option")
      .map((o) => (o.textContent ?? "").replace(/^✓/, ""));

  it("lists the provider's own effort names, Auto first", () => {
    renderRow(withSpec({ efforts: ["none", "low", "high", "xhigh", "max"] }));
    expand();
    fireEvent.click(screen.getByRole("combobox"));
    expect(optionNames()).toEqual([
      "Auto — let the API decide",
      "Off",
      "Low",
      "High",
      "Extra high",
      "Max",
    ]);
  });

  it("two providers with different vocabularies show different lists", () => {
    renderRow(withSpec({ efforts: ["high", "max"] }));
    expand();
    fireEvent.click(screen.getByRole("combobox"));
    expect(optionNames()).toEqual(["Auto — let the API decide", "High", "Max"]);
  });

  it("shows no budget control for a provider that doesn't use one", () => {
    renderRow(withSpec({ efforts: ["low", "high"], budget: null }));
    expand();
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(screen.queryByText(/Token budget/)).toBeNull();
  });

  it("shows the budget control, with presets, where one is used", () => {
    renderRow(
      withSpec({
        efforts: ["low", "high"],
        budget: { min: 1024, max: null, presets: [1024, 4096, 16384] },
      }),
    );
    expand();
    const boxes = screen.getAllByRole("combobox");
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[1]!);
    expect(optionNames()).toEqual([
      "Default",
      "1k tokens",
      "4k tokens",
      "16k tokens",
    ]);
    expect(screen.getByText(/Token budget for models that take one/)).toBeInTheDocument();
  });

  it("a budget-only provider shows just the budget", () => {
    renderRow(
      withSpec({ budget: { min: 1024, max: null, presets: [1024, 8192] } }),
    );
    expand();
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
    expect(screen.getByText(/Cap on thinking tokens/)).toBeInTheDocument();
  });

  it("picking an effort saves it together with the current budget", () => {
    const { onSetReasoning } = renderRow(
      withSpec(
        { efforts: ["low", "high"], budget: { min: 1024, max: null, presets: [1024, 4096] } },
        { effort: null, budget_tokens: 4096 },
      ),
    );
    expand();
    fireEvent.click(screen.getAllByRole("combobox")[0]!);
    fireEvent.click(screen.getByRole("option", { name: "High" }));
    expect(onSetReasoning).toHaveBeenCalledExactlyOnceWith("high", 4096);
  });

  it("picking Auto clears the effort and keeps the budget", () => {
    const { onSetReasoning } = renderRow(
      withSpec(
        { efforts: ["low", "high"], budget: { min: 1024, max: null, presets: [1024, 4096] } },
        { effort: "high", budget_tokens: 1024 },
      ),
    );
    expand();
    fireEvent.click(screen.getAllByRole("combobox")[0]!);
    fireEvent.click(screen.getByRole("option", { name: /^Auto/ }));
    expect(onSetReasoning).toHaveBeenCalledExactlyOnceWith(null, 1024);
  });

  it("picking a budget saves it with the current effort; Default clears it", () => {
    const { onSetReasoning } = renderRow(
      withSpec(
        { efforts: ["low", "high"], budget: { min: 1024, max: null, presets: [1024, 4096] } },
        { effort: "low", budget_tokens: 1024 },
      ),
    );
    expand();
    fireEvent.click(screen.getAllByRole("combobox")[1]!);
    fireEvent.click(screen.getByRole("option", { name: "4k tokens" }));
    expect(onSetReasoning).toHaveBeenLastCalledWith("low", 4096);
    fireEvent.click(screen.getAllByRole("combobox")[1]!);
    fireEvent.click(screen.getByRole("option", { name: "Default" }));
    expect(onSetReasoning).toHaveBeenLastCalledWith("low", null);
  });

  it("keeps a saved level the model doesn't offer visible instead of rewriting it", () => {
    renderRow(withSpec({ efforts: ["low", "high"] }, { effort: "xhigh" }));
    expand();
    expect(screen.getByRole("combobox")).toHaveTextContent("Extra high (not offered here)");
  });

  it("explains an empty and a toggle-only spec instead of showing dead controls", () => {
    const { rerenderWith } = renderRow(withSpec({}));
    expand();
    expect(screen.getByText("No reasoning controls for Anthropic.")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    rerenderWith(withSpec({ toggle: true }));
    expect(screen.getByText(/only switch thinking on or off/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("ignores changes while a save is in flight", () => {
    const { onSetReasoning } = renderRow(
      withSpec({ efforts: ["low", "high"] }),
      handlers(),
      true,
    );
    expand();
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "High" }));
    expect(onSetReasoning).not.toHaveBeenCalled();
  });
});
