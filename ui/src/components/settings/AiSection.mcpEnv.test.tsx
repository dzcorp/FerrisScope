// The MCP server "Env" editor used to be a free-text `KEY=VALUE` textarea —
// operators had to hand-type `=` (and sometimes empty-string quotes). It now
// reuses the shared KvEditor (separate KEY / VALUE inputs + an Add button),
// committing to the backend on blur of the whole editor (not per keystroke).
// These tests pin that behaviour at the McpServerRow boundary.

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, within } from "@testing-library/react";
import { McpServerRow } from "./AiSection";
import { tokens } from "../../theme";
import type { McpServerConfig } from "../../types";

const t = tokens("dark");
// KvEditor paints invalid inputs with the theme's `bad` token; in the dark
// palette that resolves to this rgb (mirrors edit.component.test.tsx).
const BAD_RGB = "rgb(244, 63, 94)";

function server(env: Record<string, string>): McpServerConfig {
  return {
    id: "s1",
    name: "github",
    transport: "stdio",
    command: "/usr/local/bin/srv",
    url: null,
    args: [],
    env,
    headers: {},
    trust_as_read: false,
    enabled: true,
  };
}

function renderRow(env: Record<string, string>) {
  const onChange = vi.fn();
  const utils = render(
    <McpServerRow
      t={t}
      value={server(env)}
      open
      onToggleOpen={() => {}}
      onChange={onChange}
      onRemove={() => {}}
    />,
  );
  return { ...utils, onChange };
}

describe("McpServerRow env editor", () => {
  it("renders existing env as separate KEY / VALUE fields with an Add button", () => {
    const { getByDisplayValue, getByText, queryByDisplayValue } = renderRow({
      GITHUB_TOKEN: "abc",
    });
    expect(getByDisplayValue("GITHUB_TOKEN")).toBeInTheDocument();
    expect(getByDisplayValue("abc")).toBeInTheDocument();
    // Add affordance is present…
    expect(getByText("Add")).toBeInTheDocument();
    // …and the old combined `KEY=VALUE` string is gone.
    expect(queryByDisplayValue("GITHUB_TOKEN=abc")).toBeNull();
  });

  it("editing a value does not commit per keystroke, only on blur-out", () => {
    const { getByDisplayValue, onChange } = renderRow({ A: "1" });
    const valueInput = getByDisplayValue("1");
    fireEvent.change(valueInput, { target: { value: "2" } });
    // No backend roundtrip yet — the draft lives in the local buffer.
    expect(onChange).not.toHaveBeenCalled();
    // Focus leaving the whole editor (relatedTarget outside) commits.
    fireEvent.blur(valueInput, { relatedTarget: document.body });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ env: { A: "2" } });
  });

  it("tabbing between a row's KEY and VALUE does not commit", () => {
    const { getByDisplayValue, onChange } = renderRow({ A: "1" });
    const keyInput = getByDisplayValue("A");
    const valueInput = getByDisplayValue("1");
    fireEvent.change(keyInput, { target: { value: "B" } });
    // Focus moves from KEY to VALUE — still inside the editor → no commit.
    fireEvent.blur(keyInput, { relatedTarget: valueInput });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Add + fill a new pair commits it on blur-out (no '=' typed)", () => {
    const { getByText, getByPlaceholderText, onChange } = renderRow({});
    fireEvent.click(getByText("Add"));
    const keyInput = getByPlaceholderText("KEY");
    const valueInput = getByPlaceholderText("VALUE");
    fireEvent.change(keyInput, { target: { value: "API_KEY" } });
    fireEvent.change(valueInput, { target: { value: "s3cr3t" } });
    fireEvent.blur(valueInput, { relatedTarget: document.body });
    expect(onChange).toHaveBeenCalledWith({ env: { API_KEY: "s3cr3t" } });
  });

  it("an empty value commits as an empty string (no quotes needed)", () => {
    const { getByText, getByPlaceholderText, onChange } = renderRow({});
    fireEvent.click(getByText("Add"));
    const keyInput = getByPlaceholderText("KEY");
    fireEvent.change(keyInput, { target: { value: "EMPTY" } });
    // Value left blank.
    fireEvent.blur(keyInput, { relatedTarget: document.body });
    expect(onChange).toHaveBeenCalledWith({ env: { EMPTY: "" } });
  });

  it("flags a key containing '=' as invalid (red outline)", () => {
    const { getByDisplayValue } = renderRow({ "FOO=BAR": "x" });
    const keyInput = getByDisplayValue("FOO=BAR");
    expect(keyInput.getAttribute("style")).toContain(BAD_RGB);
  });

  it("removing a row commits the env without that key", () => {
    const { container, onChange } = renderRow({ KEEP: "1", DROP: "2" });
    // The row × buttons carry the "Remove" title (vs the bottom +Add).
    const removeButtons = within(container).getAllByTitle("Remove");
    // Rows render in insertion order: KEEP first, DROP second.
    fireEvent.click(removeButtons[1]!);
    // Soft-delete lives in the buffer; commit on a subsequent blur-out.
    const keepInput = within(container).getByDisplayValue("1");
    fireEvent.blur(keepInput, { relatedTarget: document.body });
    expect(onChange).toHaveBeenCalledWith({ env: { KEEP: "1" } });
  });
});
