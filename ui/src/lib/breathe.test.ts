import { afterEach, describe, expect, it, vi } from "vitest";
import { BREATHE_FPS, BREATHE_PERIOD_MS, breatheOpacity, startBreathe } from "./breathe";

describe("breatheOpacity", () => {
  it("fades from full to 0.4 and back over one period", () => {
    expect(breatheOpacity(0)).toBe("1.00");
    expect(breatheOpacity(BREATHE_PERIOD_MS / 2)).toBe("0.40");
    expect(breatheOpacity(BREATHE_PERIOD_MS)).toBe("1.00");
  });
});

describe("startBreathe", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("writes opacity only on breathing elements, including ones added later", () => {
    vi.useFakeTimers();
    let clock = 0;
    const stop = startBreathe(document, () => clock);
    const frame = 1000 / BREATHE_FPS;

    const still = document.createElement("span");
    const dot = document.createElement("span");
    dot.className = "fs-breathe";
    document.body.append(still, dot);

    clock = BREATHE_PERIOD_MS / 2;
    vi.advanceTimersByTime(frame);
    expect(dot.style.opacity).toBe("0.4");
    expect(still.style.opacity).toBe("");

    const late = document.createElement("span");
    late.className = "fs-breathe";
    document.body.append(late);
    clock = 0;
    vi.advanceTimersByTime(frame);
    expect(late.style.opacity).toBe("1");

    stop();
    clock = BREATHE_PERIOD_MS / 2;
    vi.advanceTimersByTime(frame * 3);
    expect(late.style.opacity).toBe("1");
  });

  it("does nothing under prefers-reduced-motion", () => {
    vi.useFakeTimers();
    const matchMedia = vi
      .spyOn(window, "matchMedia")
      .mockReturnValue({ matches: true } as MediaQueryList);
    const dot = document.createElement("span");
    dot.className = "fs-breathe";
    document.body.append(dot);
    const stop = startBreathe(document, () => BREATHE_PERIOD_MS / 2);
    vi.advanceTimersByTime(1000);
    expect(dot.style.opacity).toBe("");
    stop();
    matchMedia.mockRestore();
  });
});
