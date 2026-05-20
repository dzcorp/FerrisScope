// The MCP server row gained a transport selector (stdio / sse / http) and a
// per-server "trust" switch (auto-approve every tool). These tests pin the
// conditional fields per transport, the trust toggle wiring, and the
// transport-specific commits (URL, headers).

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { McpServerRow } from "./AiSection";
import { tokens } from "../../theme";
import type { McpServerConfig } from "../../types";

const t = tokens("dark");

// The Select popover calls scrollIntoView on open; jsdom doesn't implement it.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const STDIO_PLACEHOLDER = "/usr/local/bin/my-mcp-server";
const URL_PLACEHOLDER = "https://mcp.example.com/rpc";

function server(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "s1",
    name: "github",
    transport: "stdio",
    command: "/usr/local/bin/srv",
    url: null,
    args: [],
    env: {},
    headers: {},
    trust_as_read: false,
    enabled: true,
    ...overrides,
  };
}

function renderRow(overrides: Partial<McpServerConfig> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <McpServerRow
      t={t}
      value={server(overrides)}
      open
      onToggleOpen={() => {}}
      onChange={onChange}
      onRemove={() => {}}
    />,
  );
  return { ...utils, onChange };
}

describe("McpServerRow trust switch", () => {
  it("enabling the trust toggle calls onChange({ trust_as_read: true })", () => {
    const { getByText, onChange } = renderRow();
    fireEvent.click(getByText("Auto-approve all tools"));
    expect(onChange).toHaveBeenCalledWith({ trust_as_read: true });
  });

  it("shows a no-approval warning while trust is on", () => {
    const { getByText } = renderRow({ trust_as_read: true });
    expect(getByText("Tools run without approval")).toBeInTheDocument();
  });
});

describe("McpServerRow transport fields", () => {
  it("stdio shows command + Args + Env, not URL/Headers", () => {
    const { getByPlaceholderText, getByText, queryByText, queryByPlaceholderText } =
      renderRow({ transport: "stdio" });
    expect(getByPlaceholderText(STDIO_PLACEHOLDER)).toBeInTheDocument();
    expect(getByText("Args")).toBeInTheDocument();
    expect(getByText("Env")).toBeInTheDocument();
    expect(queryByText("Headers")).toBeNull();
    expect(queryByPlaceholderText(URL_PLACEHOLDER)).toBeNull();
  });

  it("http shows URL + Headers, not command/Args/Env", () => {
    const { getByPlaceholderText, getByText, queryByText, queryByPlaceholderText } =
      renderRow({ transport: "http", command: "", url: "https://x" });
    expect(getByPlaceholderText(URL_PLACEHOLDER)).toBeInTheDocument();
    expect(getByText("Headers")).toBeInTheDocument();
    expect(queryByText("Args")).toBeNull();
    expect(queryByText("Env")).toBeNull();
    expect(queryByPlaceholderText(STDIO_PLACEHOLDER)).toBeNull();
  });

  it("selecting the http transport calls onChange({ transport: 'http' })", () => {
    const { getByRole, onChange } = renderRow({ transport: "stdio" });
    fireEvent.click(getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "http" }));
    expect(onChange).toHaveBeenCalledWith({ transport: "http" });
  });

  it("editing the URL and blurring commits onChange({ url })", () => {
    const { getByPlaceholderText, onChange } = renderRow({
      transport: "http",
      command: "",
      url: null,
    });
    const input = getByPlaceholderText(URL_PLACEHOLDER);
    fireEvent.change(input, { target: { value: URL_PLACEHOLDER } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ url: URL_PLACEHOLDER });
  });

  it("clearing the URL commits onChange({ url: null })", () => {
    const { getByPlaceholderText, onChange } = renderRow({
      transport: "http",
      command: "",
      url: "https://old.example.com",
    });
    const input = getByPlaceholderText(URL_PLACEHOLDER);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ url: null });
  });

  it("adding a header and blurring out commits onChange({ headers })", () => {
    const { getByText, getByPlaceholderText, onChange } = renderRow({
      transport: "http",
      command: "",
      url: "https://x",
    });
    fireEvent.click(getByText("Add"));
    fireEvent.change(getByPlaceholderText("Header"), {
      target: { value: "Authorization" },
    });
    const valueInput = getByPlaceholderText("value");
    fireEvent.change(valueInput, { target: { value: "Bearer t" } });
    fireEvent.blur(valueInput, { relatedTarget: document.body });
    expect(onChange).toHaveBeenCalledWith({
      headers: { Authorization: "Bearer t" },
    });
  });
});
