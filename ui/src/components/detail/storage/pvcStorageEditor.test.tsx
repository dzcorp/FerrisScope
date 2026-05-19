// Behavioural coverage for the PVC requested-storage inline editor.
// Same pattern as MetaSection labels/annotations: a pencil enters edit
// mode, an input swaps in, EditModeChrome's Cancel reverts. No pill, no
// hover-reveal — kept on the standard chrome so every editable field on
// the panel feels the same.

import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { PvcRequestedStorageEditor } from "./index";
import { EditSessionProvider } from "../editSession";
import { tokens } from "../../../theme";
import { resetMockInvoke } from "../../../test/tauri-mock";

const t = tokens("dark");
const TARGET = {
  clusterId: "ctx",
  kindId: "persistentvolumeclaims",
  namespace: "default",
  name: "data",
};

beforeEach(() => {
  resetMockInvoke();
});

function mount(requestedStorage: string | null) {
  return render(
    <EditSessionProvider target={TARGET} onSaved={() => {}}>
      <PvcRequestedStorageEditor t={t} requestedStorage={requestedStorage} />
    </EditSessionProvider>,
  );
}

function pencil(container: HTMLElement): HTMLButtonElement {
  // EditModeChrome renders an icon button with title "Edit" in read mode.
  const btn = container.querySelector("button[title='Edit']");
  if (!btn) throw new Error("pencil (Edit) button not found");
  return btn as HTMLButtonElement;
}

function input(container: HTMLElement): HTMLInputElement {
  const i = container.querySelector("input");
  if (!i) throw new Error("edit-mode input not rendered");
  return i as HTMLInputElement;
}

describe("PvcRequestedStorageEditor", () => {
  it("renders the requested storage when set", () => {
    const { container } = mount("10Gi");
    expect(container.textContent).toContain("10Gi");
    expect(container.querySelector("input")).toBeNull();
  });

  it("renders an em-dash when unset", () => {
    const { container } = mount(null);
    expect(container.textContent).toContain("—");
  });

  it("pencil enters edit mode with the current value", () => {
    const { container } = mount("10Gi");
    fireEvent.click(pencil(container));
    expect(input(container).value).toBe("10Gi");
  });

  it("Cancel exits edit mode without persisting", () => {
    const { container } = mount("10Gi");
    fireEvent.click(pencil(container));
    fireEvent.change(input(container), { target: { value: "50Gi" } });
    // Edit-mode chrome carries the Cancel/Revert chip.
    const cancel = Array.from(container.querySelectorAll("button")).find((b) =>
      /Cancel|Revert/.test(b.textContent ?? ""),
    );
    expect(cancel).toBeTruthy();
    fireEvent.click(cancel!);
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain("10Gi");
  });

  it("typing in edit mode flows through to the buffer", () => {
    const { container } = mount("10Gi");
    fireEvent.click(pencil(container));
    fireEvent.change(input(container), { target: { value: "20Gi" } });
    expect(input(container).value).toBe("20Gi");
  });

  it("invalid quantity strings do not block typing", () => {
    const { container } = mount("10Gi");
    fireEvent.click(pencil(container));
    fireEvent.change(input(container), { target: { value: "not a size" } });
    // The chrome surfaces validation through the global save bar; the
    // input itself stays usable so the operator can keep editing.
    expect(input(container).value).toBe("not a size");
  });
});
