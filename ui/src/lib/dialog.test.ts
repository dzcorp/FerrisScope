// Confirm modal + toast helpers — thin wrappers around the store, but the
// behaviour around default tones / durations / split-line bodies matters
// because every save / delete / refresh emits through these.

import { describe, it, expect, beforeEach } from "vitest";
import { confirm, toast } from "./dialog";
import { useAppStore } from "../store";

const initial = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState({
    ...initial,
    modals: [],
    toasts: [],
    notifications: [],
  });
});

describe("confirm", () => {
  it("pushes a modal carrying the operator-provided labels and tone, then resolves on resolveModal", async () => {
    const p = confirm({ title: "Delete pod?", tone: "danger" });
    const modal = useAppStore.getState().modals[0];
    expect(modal?.title).toBe("Delete pod?");
    expect(modal?.tone).toBe("danger");
    expect(modal?.confirmLabel).toBe("Confirm");
    expect(modal?.cancelLabel).toBe("Cancel");

    useAppStore.getState().resolveModal(modal!.id, true);
    await expect(p).resolves.toBe(true);
  });

  it("defaults tone to neutral", async () => {
    const p = confirm({ title: "OK?" });
    const modal = useAppStore.getState().modals[0];
    expect(modal?.tone).toBe("neutral");
    useAppStore.getState().resolveModal(modal!.id, false);
    await expect(p).resolves.toBe(false);
  });

  it("custom labels override the defaults", async () => {
    const p = confirm({
      title: "Apply?",
      confirmLabel: "Apply",
      cancelLabel: "Discard",
    });
    const modal = useAppStore.getState().modals[0];
    expect(modal?.confirmLabel).toBe("Apply");
    expect(modal?.cancelLabel).toBe("Discard");
    useAppStore.getState().resolveModal(modal!.id, true);
    await p;
  });
});

describe("toast", () => {
  it("ok/info/warn emit with their default durations and tone", () => {
    toast.ok("saved");
    toast.info("hi");
    toast.warn("careful");
    const toasts = useAppStore.getState().toasts;
    expect(toasts).toHaveLength(3);
    expect(toasts[0]?.tone).toBe("ok");
    expect(toasts[0]?.durationMs).toBe(3500);
    expect(toasts[1]?.tone).toBe("info");
    expect(toasts[1]?.durationMs).toBe(4000);
    expect(toasts[2]?.tone).toBe("warn");
    expect(toasts[2]?.durationMs).toBe(6000);
  });

  it("bad is sticky — durationMs: 0", () => {
    toast.bad("explosion");
    const t = useAppStore.getState().toasts[0];
    expect(t?.tone).toBe("bad");
    expect(t?.durationMs).toBe(0);
  });

  it("explicit duration overrides the tone default", () => {
    toast.info("flash", 1234);
    expect(useAppStore.getState().toasts[0]?.durationMs).toBe(1234);
  });

  it("a newline in the text splits headline from body", () => {
    toast.warn("Short\nDetailed reason that wraps");
    const t = useAppStore.getState().toasts[0];
    expect(t?.text).toBe("Short");
    expect(t?.body).toBe("Detailed reason that wraps");
  });

  it("no newline leaves body undefined", () => {
    toast.ok("one-line");
    const t = useAppStore.getState().toasts[0];
    expect(t?.text).toBe("one-line");
    expect(t?.body).toBeUndefined();
  });

  it("dismiss removes from toasts but keeps it in notifications log", () => {
    const id = toast.info("flash");
    expect(useAppStore.getState().toasts).toHaveLength(1);
    toast.dismiss(id);
    expect(useAppStore.getState().toasts).toHaveLength(0);
    // Notifications log is the audit trail — dismissal doesn't clear it.
    expect(useAppStore.getState().notifications).toHaveLength(1);
  });
});
