import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProviderPickerPopover } from "./ProviderPickerPopover";
import type {
  AiSettingsWire,
  ProviderKind,
  ProviderStatusWire,
} from "../../types";

afterEach(cleanup);

function status(
  kind: ProviderKind,
  display_name: string,
  overrides: Partial<ProviderStatusWire> = {},
): ProviderStatusWire {
  return {
    kind,
    id: kind,
    display_name,
    default_base_url: "",
    base_url_override: null,
    auth_modes: ["api_key"],
    auth_mode: "api_key",
    configured: true,
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
    ...overrides,
  };
}

function renderPicker(providers: ProviderStatusWire[]) {
  const settings = {
    active_provider: "openai",
    providers: Object.fromEntries(providers.map((p) => [p.kind, p])),
    provider_order: providers.map((p) => p.kind),
  } as unknown as AiSettingsWire;
  const onPick = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <ProviderPickerPopover
      mode="dark"
      settings={settings}
      currentProviderKind="openai"
      onPick={onPick}
      onOpenSettings={onOpenSettings}
      onClose={vi.fn()}
    />,
  );
  return { onPick, onOpenSettings };
}

describe("ProviderPickerPopover", () => {
  it("lists only enabled providers and counts the hidden ones", () => {
    renderPicker([
      status("openai", "OpenAI"),
      status("opencode_zen", "OpenCode Zen", {
        enabled: false,
        account_label: "free tier",
      }),
    ]);
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.queryByText("OpenCode Zen")).toBeNull();
    expect(screen.getByText("1 disabled — manage in Settings")).toBeInTheDocument();
  });

  it("keeps the backend's order", () => {
    renderPicker([
      status("anthropic", "Anthropic"),
      status("openai", "OpenAI"),
      status("opencode_zen", "OpenCode Zen"),
    ]);
    const text = document.body.textContent ?? "";
    const at = (name: string) => text.indexOf(name);
    expect(at("Anthropic")).toBeGreaterThan(-1);
    expect(at("Anthropic")).toBeLessThan(at("OpenAI"));
    expect(at("OpenAI")).toBeLessThan(at("OpenCode Zen"));
  });

  it("labels the keyless tier as free tier", () => {
    renderPicker([
      status("openai", "OpenAI"),
      status("opencode_zen", "OpenCode Zen", {
        free_tier: true,
        account_label: "free tier",
        auth_mode: "api_key",
      }),
    ]);
    expect(screen.getByText("free tier")).toBeInTheDocument();
  });

  it("omits the footer when nothing is disabled", () => {
    renderPicker([status("openai", "OpenAI"), status("anthropic", "Anthropic")]);
    expect(screen.queryByText(/disabled — manage/)).toBeNull();
  });

  it("the footer opens Settings on the providers block", () => {
    const { onOpenSettings } = renderPicker([
      status("openai", "OpenAI"),
      status("opencode_zen", "OpenCode Zen", { enabled: false }),
    ]);
    fireEvent.click(screen.getByText("1 disabled — manage in Settings"));
    expect(onOpenSettings).toHaveBeenCalledWith("providers");
  });

  it("an enabled but unconnected provider routes to Settings instead of picking", () => {
    const { onPick, onOpenSettings } = renderPicker([
      status("openai", "OpenAI"),
      status("anthropic", "Anthropic", { configured: false, auth_mode: null }),
    ]);
    fireEvent.click(screen.getByText("Anthropic"));
    expect(onPick).not.toHaveBeenCalled();
    expect(onOpenSettings).toHaveBeenCalledWith("providers");
  });

  it("picks an enabled, connected provider", () => {
    const { onPick } = renderPicker([
      status("openai", "OpenAI"),
      status("anthropic", "Anthropic"),
    ]);
    fireEvent.click(screen.getByText("Anthropic"));
    expect(onPick).toHaveBeenCalledWith("anthropic");
  });
});
