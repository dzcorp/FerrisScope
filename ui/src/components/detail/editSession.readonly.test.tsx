// Read-only gating: when the cluster is unavailable / mid auto-reconnect, the
// edit session must (a) refuse to open a pencil, (b) disable the global Save,
// and (c) hard-stop saveAll even if a row was already dirty when health
// flipped — so no doomed SSA apply is fired at a dead apiserver.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import {
  EditSessionProvider,
  useEditField,
  useEditSession,
} from "./editSession";
import { GlobalSaveBar } from "./globalSaveBar";
import type { ApplyTarget } from "./edit";
import { tokens } from "../../theme";
import { useAppStore } from "../../store";
import { setMockInvoke, resetMockInvoke } from "../../test/tauri-mock";
import { resetAccessCache } from "../../lib/access";
import { EditModeChrome } from "./edit";

const t = tokens("dark");
const TARGET: ApplyTarget = {
  clusterId: "ctx",
  kindId: "configmaps",
  namespace: "default",
  name: "hello",
};

const storeInitial = useAppStore.getState();

beforeEach(() => {
  resetMockInvoke();
  resetAccessCache();
  useAppStore.setState({
    ...storeInitial,
    clusterHealth: {},
    clusterHealthReason: {},
    clusterReconnecting: {},
  });
});

function setDegraded(value: boolean) {
  act(() => {
    useAppStore
      .getState()
      .applyClusterHealth("ctx", value ? "unavailable" : "healthy", null);
  });
}

function Editor() {
  const field = useEditField<{ value: string }>({
    id: "e1",
    initial: () => ({ value: "" }),
    serialize: (b) => ({ data: { k: b.value } }),
    dirtyCount: (b) => (b.value === "" ? 0 : 1),
  });
  return (
    <div>
      <span data-testid="editing">{String(field.editing)}</span>
      <span data-testid="dirty">{field.dirty}</span>
      <span data-testid="readonly">{String(field.readOnly)}</span>
      <button data-testid="enter" onClick={field.enter} />
      <button
        data-testid="set"
        onClick={() => field.setBuffer({ value: "new" })}
      />
    </div>
  );
}

// Exposes the session-level saveAll so a test can call it directly (the
// GlobalSaveBar button is disabled when degraded, so we can't reach saveAll
// through it — this proves the internal guard, not just the UI gate).
function DirectSave() {
  const session = useEditSession();
  return (
    <button data-testid="direct-save" onClick={() => void session?.saveAll()} />
  );
}

function renderPanel() {
  return render(
    <EditSessionProvider target={TARGET} onSaved={() => {}}>
      <Editor />
      <DirectSave />
      <GlobalSaveBar t={t} />
    </EditSessionProvider>,
  );
}

describe("edit session read-only gating", () => {
  it("pencil enter() no-ops while the cluster is degraded", () => {
    setDegraded(true);
    const { getByTestId } = renderPanel();
    expect(getByTestId("readonly").textContent).toBe("true");
    fireEvent.click(getByTestId("enter"));
    expect(getByTestId("editing").textContent).toBe("false");
  });

  it("disables Save and shows the unavailable note when health flips mid-edit", () => {
    const { getByTestId, container } = renderPanel();
    // Dirty the row while healthy.
    fireEvent.click(getByTestId("enter"));
    fireEvent.click(getByTestId("set"));
    expect(getByTestId("dirty").textContent).toBe("1");

    // Cluster goes unavailable — the bar must disable Save and explain why.
    setDegraded(true);
    const save = Array.from(container.querySelectorAll("button")).find((b) =>
      /Save \(\d+\)/.test(b.textContent ?? ""),
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(container.textContent ?? "").toMatch(/Cluster unavailable/);
  });

  it("saveAll hard-stops while degraded — no apply_resource_cmd fires", async () => {
    const invokeSpy = vi.fn(() => ({ kind: "applied", resource_version: "1" }));
    setMockInvoke(invokeSpy);
    const { getByTestId, container } = renderPanel();

    fireEvent.click(getByTestId("enter"));
    fireEvent.click(getByTestId("set"));
    setDegraded(true);

    await act(async () => {
      fireEvent.click(getByTestId("direct-save"));
    });

    expect(invokeSpy).not.toHaveBeenCalledWith("apply_resource_cmd", expect.anything());
    expect(container.textContent ?? "").toMatch(
      /Cluster unavailable — reconnect to save/,
    );
  });
});

describe("edit session RBAC gating", () => {
  it("a denied patch makes the session read-only and the pencil says why", async () => {
    const calls: string[] = [];
    setMockInvoke((cmd) => {
      calls.push(cmd);
      return cmd === "access_check_cmd"
        ? [{ state: "denied", reason: 'cannot patch configmaps "hello" in default' }]
        : undefined;
    });
    const { getByTestId, getByRole } = render(
      <EditSessionProvider target={TARGET} onSaved={() => {}}>
        <Editor />
        <EditModeChrome t={t} editing={false} dirty={0} saving={false} onEnter={() => {}} onCancel={() => {}} />
      </EditSessionProvider>,
    );
    await act(async () => {});
    expect(getByTestId("readonly").textContent).toBe("true");
    fireEvent.click(getByTestId("enter"));
    expect(getByTestId("editing").textContent).toBe("false");
    expect(
      getByRole("button", { name: 'Not permitted: cannot patch configmaps "hello" in default' }),
    ).toBeTruthy();
    expect(calls).toContain("access_check_cmd");
  });
});
