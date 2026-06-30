// Component test for the YAML manifest tab. The merge-patch math is unit
// tested in lib/yamlEdit.test.ts; this file pins the rendered behaviour the
// operator actually touches: the editor is always editable, Save ships the
// computed merge patch + resourceVersion, a stale 409 surfaces the banner,
// and "apply anyway" re-sends without the version guard.
//
// Monaco is mocked to a plain <textarea> — we only care about value/onChange
// and the readOnly flag, not the real editor.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { tokens } from "../../theme";
import { parseYaml } from "../../lib/yamlEdit";
import { YamlTab, type YamlStale } from "./YamlTab";

const { mergePatchResourceMock } = vi.hoisted(() => ({
  mergePatchResourceMock: vi.fn(),
}));

vi.mock("../../api", () => ({
  api: { mergePatchResource: mergePatchResourceMock },
}));

// Monaco stand-in: a controlled textarea that forwards edits and honours
// the readOnly option so we can assert the always-editable contract.
vi.mock("@monaco-editor/react", () => ({
  default: (props: {
    value?: string;
    onChange?: (v: string | undefined) => void;
    options?: { readOnly?: boolean };
  }) => (
    <textarea
      data-testid="editor"
      readOnly={props.options?.readOnly}
      value={props.value ?? ""}
      onChange={(e) => props.onChange?.(e.target.value)}
    />
  ),
}));

const t = tokens("dark");

const BASE_YAML = "metadata:\n  name: cm\ndata:\n  KEY: A\n";
const EDITED_YAML = "metadata:\n  name: cm\ndata:\n  KEY: B\n";

// `serverYaml` / `serverRv` model the live object the detail panel feeds in.
// Rerendering Host with new values simulates a watcher refetch while the
// internally-held draft (buffer) persists across the rerender.
function Host({
  onResync = vi.fn(),
  serverYaml = BASE_YAML,
  serverRv = "42",
  refreshedAt = 1000,
  readOnly = false,
}: {
  onResync?: () => void;
  serverYaml?: string;
  serverRv?: string;
  refreshedAt?: number;
  readOnly?: boolean;
}) {
  const [buffer, setBuffer] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState<YamlStale | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <YamlTab
      mode="dark"
      t={t}
      yaml={serverYaml}
      yamlRaw={`${serverYaml}  uid: abc\n`}
      original={parseYaml(serverYaml)}
      resourceVersion={serverRv}
      refreshedAt={refreshedAt}
      clusterId="c1"
      kindId="configmaps"
      kindLabel="configmap"
      namespace="ns"
      name="cm"
      buffer={buffer}
      setBuffer={setBuffer}
      saving={saving}
      setSaving={setSaving}
      stale={stale}
      setStale={setStale}
      error={error}
      setError={setError}
      onResync={() => {
        setBuffer(null);
        onResync();
      }}
      readOnly={readOnly}
    />
  );
}

beforeEach(() => {
  mergePatchResourceMock.mockReset();
});

describe("YamlTab", () => {
  it("is editable straight away — no pencil gate", () => {
    render(<Host />);
    const editor = screen.getByTestId("editor") as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(false);
    // Save is present but inert until something changes.
    const save = screen.getByRole("button", { name: /^save$/i });
    expect(save).toBeDisabled();
  });

  it("readOnly (degraded cluster) forces the editor read-only and disables Save", () => {
    render(<Host readOnly />);
    const editor = screen.getByTestId("editor") as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);

    // The draft is still kept if the operator already typed, but Save never
    // enables and the status line explains why.
    fireEvent.change(editor, { target: { value: EDITED_YAML } });
    expect(
      screen.getByText(/read-only · cluster unavailable/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
  });

  it("Save ships the merge patch + resourceVersion once the doc diverges", async () => {
    mergePatchResourceMock.mockResolvedValue({
      kind: "applied",
      resource_version: "43",
    });
    const onResync = vi.fn();
    render(<Host onResync={onResync} />);

    fireEvent.change(screen.getByTestId("editor"), {
      target: { value: EDITED_YAML },
    });

    // The dirty Save chip shows the change count.
    const save = await screen.findByRole("button", { name: /save \(1\)/i });
    fireEvent.click(save);

    await waitFor(() => expect(mergePatchResourceMock).toHaveBeenCalledTimes(1));
    expect(mergePatchResourceMock).toHaveBeenCalledWith(
      "c1",
      "configmaps",
      "ns",
      "cm",
      { data: { KEY: "B" } },
      "42",
    );
    await waitFor(() => expect(onResync).toHaveBeenCalled());
  });

  it("freezes the baseline at edit time — a watcher refetch can't rebase or refresh the version", async () => {
    mergePatchResourceMock.mockResolvedValue({
      kind: "applied",
      resource_version: "100",
    });
    const { rerender } = render(<Host serverRv="42" />);

    // Operator starts editing.
    fireEvent.change(screen.getByTestId("editor"), {
      target: { value: EDITED_YAML },
    });

    // A watcher refetch lands a newer server copy mid-edit: a higher
    // resourceVersion and an externally-added key.
    rerender(
      <Host
        serverRv="99"
        serverYaml={"metadata:\n  name: cm\ndata:\n  KEY: A\n  OTHER: x\n"}
        refreshedAt={2000}
      />,
    );

    // Still one change against the FROZEN baseline (not two — OTHER is not
    // reverted), and Save sends the FROZEN resourceVersion 42, so the
    // optimistic lock will correctly detect the concurrent change.
    fireEvent.click(await screen.findByRole("button", { name: /save \(1\)/i }));
    await waitFor(() => expect(mergePatchResourceMock).toHaveBeenCalledTimes(1));
    expect(mergePatchResourceMock).toHaveBeenCalledWith(
      "c1",
      "configmaps",
      "ns",
      "cm",
      { data: { KEY: "B" } },
      "42",
    );
  });

  it("a stale 409 surfaces the banner; Apply anyway drops the version guard", async () => {
    mergePatchResourceMock
      .mockResolvedValueOnce({ kind: "stale", message: "object was modified" })
      .mockResolvedValueOnce({ kind: "applied", resource_version: "99" });
    render(<Host />);

    fireEvent.change(screen.getByTestId("editor"), {
      target: { value: EDITED_YAML },
    });
    fireEvent.click(await screen.findByRole("button", { name: /save \(1\)/i }));

    // Banner appears with the server message.
    expect(await screen.findByText(/object changed/i)).toBeInTheDocument();
    expect(screen.getByText(/object was modified/i)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /apply my changes anyway/i }),
    );

    await waitFor(() => expect(mergePatchResourceMock).toHaveBeenCalledTimes(2));
    // Second call overwrites: resourceVersion is null.
    expect(mergePatchResourceMock.mock.calls[1]).toEqual([
      "c1",
      "configmaps",
      "ns",
      "cm",
      { data: { KEY: "B" } },
      null,
    ]);
  });

  it("Discard reverts the draft to the server copy", async () => {
    render(<Host />);
    const editor = screen.getByTestId("editor") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: EDITED_YAML } });
    expect(editor.value).toContain("KEY: B");

    fireEvent.click(await screen.findByRole("button", { name: /discard/i }));

    expect((screen.getByTestId("editor") as HTMLTextAreaElement).value).toBe(
      BASE_YAML,
    );
    // Back to clean → Save inert again.
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
  });

  it("the Server fields toggle shows raw YAML read-only", () => {
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: /server fields/i }));
    const editor = screen.getByTestId("editor") as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);
    expect(editor.value).toContain("uid: abc");
  });
});
