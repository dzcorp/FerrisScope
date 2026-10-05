// Settings → AI provider list at page level: backend order, the enable switch
// end to end, refusals surfacing where the operator is looking, and the model
// list staying correct while fetches overlap.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AiSection } from "./AiSection";
import { useAppStore } from "../../store";
import type {
  AiSettingsWire,
  ModelInfo,
  ProviderKind,
  ProviderStatusWire,
} from "../../types";

const api = vi.hoisted(() => ({
  aiGetSettings: vi.fn(),
  aiSetSettings: vi.fn(),
  aiSetCredential: vi.fn(),
  aiDeleteCredential: vi.fn(),
  aiListModels: vi.fn(),
  aiTestProvider: vi.fn(),
  aiOauthLogin: vi.fn(),
  aiOauthCancel: vi.fn(),
}));
vi.mock("../../api", () => ({ api }));
vi.mock("../../lib/dialog", () => ({ confirm: vi.fn(), toast: { bad: vi.fn(), warn: vi.fn() } }));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.aiListModels.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ modals: [] });
});

function status(kind: ProviderKind, name: string, o: Partial<ProviderStatusWire> = {}): ProviderStatusWire {
  return {
    kind,
    id: kind,
    display_name: name,
    default_base_url: `https://${kind}.example/v1`,
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
    key_hint: "API key",
    oauth_label: null,
    signup_url: null,
    description: null,
    reasoning: {},
    reasoning_spec: { efforts: [], budget: null, toggle: false, from_catalogue: true },
    ...o,
  };
}

function settings(o: Partial<AiSettingsWire> = {}): AiSettingsWire {
  const providers = {
    openai: status("openai", "OpenAI"),
    anthropic: status("anthropic", "Anthropic", { configured: true, auth_mode: "api_key" }),
    opencode_zen: status("opencode_zen", "OpenCode Zen", {
      enabled: false,
      enable_notice: {
        headline: "Enable OpenCode Zen free tier?",
        points: ["Prompts leave your machine."],
        learn_more_url: "https://opencode.ai/docs/zen#privacy",
      },
    }),
  } as Record<string, ProviderStatusWire>;
  return {
    active_provider: "anthropic",
    providers,
    provider_order: ["openai", "anthropic", "opencode_zen"],
    default_model: null,
    default_approval_mode: "approve_per_write",
    system_prompt_override: null,
    allow_plaintext_api_key: false,
    keychain_available: true,
    mcp_servers: [],
    mcp_binary_path: null,
    reasoning: {},
    ...o,
  } as unknown as AiSettingsWire;
}

async function renderPage(s: AiSettingsWire = settings()) {
  api.aiGetSettings.mockResolvedValue(s);
  render(<AiSection mode="dark" />);
  await screen.findByText("Providers");
}

const model = (id: string): ModelInfo => ({ id, name: null, context_length: null });

describe("AiSection providers", () => {
  it("lists providers in the backend's order", async () => {
    await renderPage();
    const titles = screen.getAllByRole("switch").map((sw) => sw.getAttribute("title"));
    expect(titles).toEqual(["Disable OpenAI", "Disable Anthropic", "Enable OpenCode Zen"]);
  });

  it("enabling Zen goes through the disclosure and sends only the switch", async () => {
    await renderPage();
    api.aiSetSettings.mockImplementation(async () => {
      const next = settings();
      next.providers.opencode_zen = {
        ...next.providers.opencode_zen!,
        enabled: true,
        configured: true,
        free_tier: true,
      };
      return next;
    });
    fireEvent.click(screen.getByTitle("Enable OpenCode Zen"));
    expect(api.aiSetSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await screen.findByTitle("Disable OpenCode Zen");
    expect(api.aiSetSettings).toHaveBeenCalledExactlyOnceWith({
      provider_enabled: { provider: "opencode_zen", enabled: true },
    });
  });

  it("shows a refused base URL under the field, once", async () => {
    await renderPage();
    api.aiSetSettings.mockRejectedValue("base URL must start with http:// or https://");
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    const input = screen.getByLabelText("Anthropic base URL");
    fireEvent.change(input, { target: { value: "gw.example.com" } });
    fireEvent.blur(input);
    await screen.findByRole("alert");
    expect(screen.getAllByText(/must start with http/)).toHaveLength(1);
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps the typed key and reports the error when the credential save fails", async () => {
    await renderPage();
    api.aiSetCredential.mockRejectedValue("keychain locked");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const key = screen.getByLabelText("OpenAI API key");
    fireEvent.change(key, { target: { value: "sk-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByTestId("page-error")).toHaveTextContent(/keychain locked|AI settings/i);
    expect(key).toHaveValue("sk-1");
  });
});

describe("AiSection reasoning", () => {
  it("no longer has the global effort / budget selects", async () => {
    await renderPage();
    expect(screen.queryByText("Reasoning effort")).toBeNull();
    expect(screen.queryByText("Reasoning token budget")).toBeNull();
  });

  it("saves the chosen effort for that provider only", async () => {
    const s = settings();
    s.providers.anthropic = {
      ...s.providers.anthropic!,
      reasoning_spec: {
        efforts: ["low", "medium", "high", "xhigh", "max"],
        budget: { min: 1024, max: null, presets: [1024, 4096] },
        toggle: false,
        from_catalogue: true,
      },
    };
    await renderPage(s);
    api.aiSetSettings.mockImplementation(async () => s);
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    // The page also has Select controls of its own (active provider, default
    // model, approvals); the row's effort list is the one with Extra high.
    const boxes = screen.getAllByRole("combobox");
    const effort = boxes.find((b) => /Auto/.test(b.textContent ?? ""))!;
    fireEvent.click(effort);
    fireEvent.click(screen.getByRole("option", { name: "Extra high" }));
    await waitFor(() =>
      expect(api.aiSetSettings).toHaveBeenCalledWith({
        provider_reasoning: { provider: "anthropic", effort: "xhigh", budget_tokens: null },
      }),
    );
  });
});

describe("AiSection active provider", () => {
  const switched = (): AiSettingsWire => {
    const next = settings({ active_provider: "openai", default_model: "gpt-5" });
    next.providers.openai = { ...next.providers.openai!, configured: true, auth_mode: "api_key" };
    return next;
  };

  const switchToOpenAi = () => {
    const select = screen
      .getAllByRole("combobox")
      .find((b) => /Anthropic · connected/.test(b.textContent ?? ""))!;
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("option", { name: "OpenAI" }));
  };

  it("sends only the provider and shows the default model the backend chose", async () => {
    api.aiListModels.mockResolvedValue([model("claude-x")]);
    await renderPage(settings({ default_model: "claude-x" }));
    api.aiSetSettings.mockResolvedValue(switched());
    switchToOpenAi();
    await waitFor(() =>
      expect(api.aiSetSettings).toHaveBeenCalledExactlyOnceWith({ active_provider: "openai" }),
    );
    expect(await screen.findByText("gpt-5")).toBeInTheDocument();
  });

  it("does not list the previous provider's models while the new list loads", async () => {
    api.aiListModels.mockImplementation(async (kind: ProviderKind) =>
      kind === "anthropic" ? [model("claude-x"), model("claude-y")] : new Promise(() => {}),
    );
    await renderPage(settings({ default_model: "claude-x" }));
    expect(await screen.findByText(/\(2 available\)/)).toBeInTheDocument();
    api.aiSetSettings.mockResolvedValue(switched());
    switchToOpenAi();
    await waitFor(() => expect(api.aiListModels).toHaveBeenCalledWith("openai"));
    expect(screen.queryByText(/available\)/)).toBeNull();
    expect(screen.getByText("gpt-5")).toBeInTheDocument();
  });
});

describe("AiSection model list", () => {
  it("lists the active provider's models and says how many", async () => {
    api.aiListModels.mockResolvedValue([model("a"), model("b")]);
    await renderPage();
    expect(await screen.findByText(/\(2 available\)/)).toBeInTheDocument();
    expect(api.aiListModels).toHaveBeenCalledWith("anthropic");
  });

  it("shows a failed listing next to the field instead of as a save error", async () => {
    api.aiListModels.mockRejectedValue("catalogue unreachable");
    await renderPage();
    // Rendered by ErrorBlock under the Default model field, labelled as the
    // model list — not as a settings-save failure.
    expect(await screen.findByTestId("models-error")).toBeInTheDocument();
    expect(screen.queryByTestId("page-error")).toBeNull();
  });

  it("does not list models for a provider that isn't usable", async () => {
    await renderPage(
      settings({ active_provider: "openai" }),
    );
    await waitFor(() => expect(api.aiGetSettings).toHaveBeenCalled());
    expect(api.aiListModels).not.toHaveBeenCalled();
  });

  it("re-lists after a custom model is added", async () => {
    api.aiListModels.mockResolvedValue([model("a")]);
    await renderPage();
    await waitFor(() => expect(api.aiListModels).toHaveBeenCalledTimes(1));
    api.aiSetSettings.mockImplementation(async () => {
      const next = settings();
      next.providers.anthropic = { ...next.providers.anthropic!, custom_models: ["x"] };
      return next;
    });
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.change(screen.getByLabelText("Anthropic custom model id"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(api.aiListModels).toHaveBeenCalledTimes(2));
  });

  it("ignores a slow answer that arrives after a newer one", async () => {
    let resolveStale!: (m: ModelInfo[]) => void;
    api.aiListModels
      .mockImplementationOnce(() => new Promise<ModelInfo[]>((r) => (resolveStale = r)))
      .mockResolvedValueOnce([model("fresh")]);
    await renderPage();
    await waitFor(() => expect(api.aiListModels).toHaveBeenCalledTimes(1));

    api.aiSetSettings.mockImplementation(async () => {
      const next = settings();
      next.providers.anthropic = { ...next.providers.anthropic!, custom_models: ["x"] };
      return next;
    });
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    fireEvent.change(screen.getByLabelText("Anthropic custom model id"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText(/\(1 available\)/)).toBeInTheDocument();

    resolveStale([model("s1"), model("s2"), model("s3")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(/\(1 available\)/)).toBeInTheDocument();
    expect(screen.queryByText(/\(3 available\)/)).toBeNull();
  });
});
