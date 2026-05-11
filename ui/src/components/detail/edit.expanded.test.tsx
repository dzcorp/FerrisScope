// Additional coverage for the edit kit:
//   • listBuffer helpers (env / ports / volumes editors)
//   • EditModeChrome / EditableTextValue / AddRowButton / ConflictBanner render
//   • useApply hook — save / conflict / force / error state machine

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHook } from "@testing-library/react";
import {
  AddRowButton,
  ConflictBanner,
  EditableTextValue,
  EditModeChrome,
  KvEditor,
  RowDeleteButton,
  kvBufferFromPairs,
  listBufferAdd,
  listBufferDirty,
  listBufferFrom,
  listBufferReplace,
  listBufferToArray,
  listBufferToggleDelete,
  useApply,
  type ApplyTarget,
} from "./edit";
import { tokens } from "../../theme";
import { setMockInvoke, resetMockInvoke } from "../../test/tauri-mock";

const t = tokens("dark");
const TARGET: ApplyTarget = {
  clusterId: "ctx",
  kindId: "configmaps",
  namespace: "default",
  name: "hello",
};

beforeEach(() => {
  resetMockInvoke();
});

// ── listBuffer helpers ───────────────────────────────────────────────────

type EnvRow = { name: string; value: string };

describe("listBuffer helpers", () => {
  it("listBufferFrom snapshots each row's original for dirty detection", () => {
    const b = listBufferFrom<EnvRow>([
      { name: "FOO", value: "1" },
      { name: "BAR", value: "2" },
    ]);
    expect(b.rows).toHaveLength(2);
    expect(b.rows[0]!.original).toEqual({ name: "FOO", value: "1" });
    expect(b.rows[0]!.isNew).toBe(false);
    expect(b.nextId).toBe(3);
  });

  it("listBufferAdd appends a blank with isNew + null original", () => {
    const b = listBufferFrom<EnvRow>([{ name: "FOO", value: "1" }]);
    const next = listBufferAdd(b, { name: "", value: "" });
    expect(next.rows).toHaveLength(2);
    expect(next.rows[1]!.isNew).toBe(true);
    expect(next.rows[1]!.original).toBeNull();
  });

  it("listBufferReplace patches just the targeted row", () => {
    const b = listBufferFrom<EnvRow>([{ name: "FOO", value: "1" }]);
    const id = b.rows[0]!.id;
    const next = listBufferReplace(b, id, { value: "2" });
    expect(next.rows[0]!.value).toBe("2");
    expect(next.rows[0]!.name).toBe("FOO");
  });

  it("listBufferDirty counts new rows, deleted rows, and modified existing rows", () => {
    const b = listBufferFrom<EnvRow>([
      { name: "A", value: "1" },
      { name: "B", value: "2" },
    ]);
    const isDirty = (a: EnvRow, b: EnvRow) =>
      a.name !== b.name || a.value !== b.value;
    expect(listBufferDirty(b, isDirty)).toBe(0);

    const b1 = listBufferAdd(b, { name: "", value: "" });
    expect(listBufferDirty(b1, isDirty)).toBe(1); // 1 new row

    const b2 = listBufferReplace(b1, b1.rows[1]!.id, { value: "2.5" });
    expect(listBufferDirty(b2, isDirty)).toBe(2); // 1 new + 1 modified

    const b3 = listBufferToggleDelete(b2, b2.rows[0]!.id);
    expect(listBufferDirty(b3, isDirty)).toBe(3); // + 1 deleted
  });

  it("listBufferToggleDelete removes a brand-new row outright", () => {
    const b = listBufferFrom<EnvRow>([]);
    const b1 = listBufferAdd(b, { name: "", value: "" });
    const removed = listBufferToggleDelete(b1, b1.rows[0]!.id);
    expect(removed.rows).toHaveLength(0);
  });

  it("listBufferToArray strips bookkeeping fields and skips deleted rows", () => {
    const b0 = listBufferFrom<EnvRow>([
      { name: "A", value: "1" },
      { name: "B", value: "2" },
    ]);
    const b1 = listBufferToggleDelete(b0, b0.rows[1]!.id);
    const out = listBufferToArray(b1, (r) => ({ name: r.name, value: r.value }));
    expect(out).toEqual([{ name: "A", value: "1" }]);
  });
});

// ── Visual primitives ────────────────────────────────────────────────────

describe("EditModeChrome", () => {
  it("non-editing → pencil only, fires onEnter on click", async () => {
    const onEnter = vi.fn();
    const { getByTitle } = render(
      <EditModeChrome
        t={t}
        editing={false}
        dirty={0}
        saving={false}
        onEnter={onEnter}
        onCancel={() => {}}
        onSave={() => {}}
      />,
    );
    await userEvent.click(getByTitle("Edit"));
    expect(onEnter).toHaveBeenCalled();
  });

  it("non-editing + dirty>0 also shows the pending-dot indicator", () => {
    const { container } = render(
      <EditModeChrome
        t={t}
        editing={false}
        dirty={3}
        saving={false}
        onEnter={() => {}}
        onCancel={() => {}}
      />,
    );
    // Pending-dot has the warn token background.
    const dot = container.querySelector('span[title*="pending change"]');
    expect(dot).not.toBeNull();
  });

  it("editing → Cancel + Save (N) chips; Save fires on click", async () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const { getByText } = render(
      <EditModeChrome
        t={t}
        editing
        dirty={2}
        saving={false}
        onEnter={() => {}}
        onCancel={onCancel}
        onSave={onSave}
      />,
    );
    expect(getByText("Cancel")).toBeInTheDocument();
    expect(getByText("Save (2)")).toBeInTheDocument();
    await userEvent.click(getByText("Save (2)"));
    expect(onSave).toHaveBeenCalled();
    await userEvent.click(getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("editing + saving disables both buttons and shows 'Saving…'", () => {
    const { getByText } = render(
      <EditModeChrome
        t={t}
        editing
        dirty={1}
        saving
        onEnter={() => {}}
        onCancel={() => {}}
        onSave={() => {}}
      />,
    );
    expect(getByText("Saving…")).toBeInTheDocument();
    // Both chip buttons disabled while save is in-flight.
    const cancel = getByText("Cancel") as HTMLButtonElement;
    const save = getByText("Saving…") as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(save.disabled).toBe(true);
  });

  it("editing without onSave (global-bar flow) renders 'Revert' instead of Save", () => {
    const { getByText, queryByText } = render(
      <EditModeChrome
        t={t}
        editing
        dirty={0}
        saving={false}
        onEnter={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(getByText("Revert")).toBeInTheDocument();
    expect(queryByText(/^Save/)).toBeNull();
  });
});

describe("EditableTextValue + RowDeleteButton + AddRowButton", () => {
  it("single-line input fires onChange", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <EditableTextValue t={t} value="" onChange={onChange} placeholder="key" />,
    );
    fireEvent.change(getByRole("textbox"), { target: { value: "FOO" } });
    expect(onChange).toHaveBeenCalledWith("FOO");
  });

  it("multiline=true renders a textarea", () => {
    const { container } = render(
      <EditableTextValue
        t={t}
        value="line1\nline2"
        onChange={() => {}}
        multiline
      />,
    );
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  it("invalid=true tints the border with t.bad", () => {
    const { getByRole } = render(
      <EditableTextValue t={t} value="" onChange={() => {}} invalid />,
    );
    const input = getByRole("textbox") as HTMLInputElement;
    // borderColor is in the shorthand `border` string. Check the style declaration.
    expect(input.style.border).toMatch(/rgb\(244, ?63, ?94\)|#f43f5e/);
  });

  it("RowDeleteButton fires onClick and stops propagation", () => {
    const onClick = vi.fn();
    const outer = vi.fn();
    const { getByTitle } = render(
      <div onClick={outer}>
        <RowDeleteButton t={t} onClick={onClick} />
      </div>,
    );
    fireEvent.click(getByTitle("Remove"));
    expect(onClick).toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
  });

  it("AddRowButton renders its label and fires onClick", async () => {
    const onClick = vi.fn();
    const { getByText } = render(
      <AddRowButton t={t} label="Add label" onClick={onClick} />,
    );
    await userEvent.click(getByText("Add label"));
    expect(onClick).toHaveBeenCalled();
  });
});

describe("ConflictBanner", () => {
  it("renders managers, fields, message; Force takeover fires onForce", async () => {
    const onForce = vi.fn();
    const onDismiss = vi.fn();
    const { getByText } = render(
      <ConflictBanner
        t={t}
        conflict={{
          managers: ["argocd-controller"],
          fields: ["data.PORT", "data.DB_URL"],
          message: "fields owned by argocd-controller",
        }}
        saving={false}
        onForce={onForce}
        onDismiss={onDismiss}
      />,
    );
    expect(getByText("Conflict")).toBeInTheDocument();
    // "argocd-controller" appears in both the headline ("with argocd-controller")
    // and the message body — use a more specific check.
    expect(getByText(/with argocd-controller/)).toBeInTheDocument();
    expect(getByText(/data\.PORT/)).toBeInTheDocument();
    await userEvent.click(getByText("Force takeover"));
    expect(onForce).toHaveBeenCalled();
    await userEvent.click(getByText("Cancel"));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("force button shows 'Forcing…' and disables both buttons while saving", () => {
    const { getByText } = render(
      <ConflictBanner
        t={t}
        conflict={{ managers: [], fields: [], message: "" }}
        saving
        onForce={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(getByText("Forcing…")).toBeInTheDocument();
    expect((getByText("Cancel") as HTMLButtonElement).disabled).toBe(true);
    expect((getByText("Forcing…") as HTMLButtonElement).disabled).toBe(true);
  });

  it("empty managers falls back to a generic phrasing", () => {
    const { getByText } = render(
      <ConflictBanner
        t={t}
        conflict={{ managers: [], fields: [], message: "boom" }}
        saving={false}
        onForce={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(getByText(/another field manager/i)).toBeInTheDocument();
  });
});

// ── KvEditor (integration: buffer + edit primitives) ──────────────────────

describe("KvEditor", () => {
  it("renders one input pair per row and forwards row mutations through onChange", async () => {
    const onChange = vi.fn();
    const buffer = kvBufferFromPairs([["a", "1"]]);
    const { getAllByRole } = render(
      <KvEditor t={t} buffer={buffer} onChange={onChange} />,
    );
    // 2 inputs (key + value).
    expect(getAllByRole("textbox")).toHaveLength(2);
    fireEvent.change(getAllByRole("textbox")[1]!, {
      target: { value: "1.5" },
    });
    expect(onChange).toHaveBeenCalled();
  });

  it("invalid-key validator drives the red outline through to the input", () => {
    const buffer = kvBufferFromPairs([["BAD KEY", "1"]]);
    const { getAllByRole } = render(
      <KvEditor
        t={t}
        buffer={buffer}
        onChange={() => {}}
        validateKey={(k) => /^[a-z]+$/.test(k)}
      />,
    );
    const keyInput = getAllByRole("textbox")[0]! as HTMLInputElement;
    expect(keyInput.style.border).toMatch(/rgb\(244, ?63, ?94\)|#f43f5e/);
  });

  it("Add button calls onChange with a new appended row", async () => {
    const onChange = vi.fn();
    const { getByText } = render(
      <KvEditor t={t} buffer={kvBufferFromPairs([])} onChange={onChange} />,
    );
    await userEvent.click(getByText("Add"));
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls[0]![0];
    expect(next.rows).toHaveLength(1);
    expect(next.rows[0].isNew).toBe(true);
  });
});

// ── useApply state machine ───────────────────────────────────────────────

describe("useApply", () => {
  it("save → applied transitions through saving:true → applied, calls onSaved", async () => {
    setMockInvoke((cmd) => {
      expect(cmd).toBe("apply_resource_cmd");
      return { kind: "applied", resource_version: "42" };
    });
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      useApply<{ value: string }>({
        target: TARGET,
        initial: () => ({ value: "" }),
        serialize: (b) => ({ data: { K: b.value } }),
        dirtyCount: () => 1,
        onSaved,
      }),
    );

    expect(result.current.saving).toBe(false);
    await act(async () => {
      result.current.enter();
    });
    await act(async () => {
      result.current.setBuffer({ value: "new" });
    });
    await act(async () => {
      await result.current.save();
    });
    expect(onSaved).toHaveBeenCalled();
    expect(result.current.editing).toBe(false);
    expect(result.current.saving).toBe(false);
  });

  it("save → conflict surfaces managers/fields/message; dismissConflict clears", async () => {
    setMockInvoke(() => ({
      kind: "conflict",
      managers: ["argocd"],
      fields: ["spec.replicas"],
      message: "owned",
    }));
    const { result } = renderHook(() =>
      useApply<unknown>({
        target: TARGET,
        initial: () => ({}),
        serialize: () => ({}),
        dirtyCount: () => 1,
        onSaved: () => {},
      }),
    );
    await act(async () => {
      result.current.enter();
    });
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.conflict).toEqual({
      kind: "conflict",
      managers: ["argocd"],
      fields: ["spec.replicas"],
      message: "owned",
    });
    await act(async () => {
      result.current.dismissConflict();
    });
    expect(result.current.conflict).toBeNull();
  });

  it("forceSave passes force=true to apply_resource_cmd", async () => {
    let receivedForce: unknown = null;
    setMockInvoke((_cmd, args) => {
      receivedForce = args?.force;
      return { kind: "applied" };
    });
    const { result } = renderHook(() =>
      useApply<unknown>({
        target: TARGET,
        initial: () => ({}),
        serialize: () => ({ data: { K: "v" } }),
        dirtyCount: () => 1,
        onSaved: () => {},
      }),
    );
    await act(async () => {
      result.current.enter();
    });
    await act(async () => {
      await result.current.forceSave();
    });
    expect(receivedForce).toBe(true);
  });

  it("save → throw surfaces as error state without onSaved firing", async () => {
    setMockInvoke(() => {
      throw new Error("network down");
    });
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      useApply<unknown>({
        target: TARGET,
        initial: () => ({}),
        serialize: () => ({}),
        dirtyCount: () => 1,
        onSaved,
      }),
    );
    await act(async () => {
      result.current.enter();
    });
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.error).toMatch(/network down/);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("cancel exits edit mode and clears any error", async () => {
    setMockInvoke(() => {
      throw new Error("nope");
    });
    const { result } = renderHook(() =>
      useApply<unknown>({
        target: TARGET,
        initial: () => ({}),
        serialize: () => ({}),
        dirtyCount: () => 0,
        onSaved: () => {},
      }),
    );
    await act(async () => {
      result.current.enter();
    });
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.error).not.toBeNull();
    await act(async () => {
      result.current.cancel();
    });
    expect(result.current.editing).toBe(false);
    expect(result.current.error).toBeNull();
  });
});
