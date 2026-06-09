import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logErr, reportErr } from "./log";
import { useAppStore } from "../store";

describe("logErr", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("logs the error under the scope tag", () => {
    const err = new Error("boom");
    logErr("prefs")(err);
    expect(warn).toHaveBeenCalledWith("[prefs]", err);
  });

  it("never throws, so it is safe as a catch sink", () => {
    expect(() => logErr("x")(undefined)).not.toThrow();
  });
});

describe("reportErr", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useAppStore.setState({ toasts: [] });
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("logs and pushes a warn toast with headline + error body", () => {
    reportErr("prefs", "Couldn't load preferences")(new Error("disk on fire"));
    expect(warn).toHaveBeenCalledTimes(1);
    const toasts = useAppStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.tone).toBe("warn");
    expect(toasts[0]?.text).toBe("Couldn't load preferences");
    expect(toasts[0]?.body).toContain("disk on fire");
  });
});
