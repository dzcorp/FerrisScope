import { describe, expect, it } from "vitest";
import type { LogStatus } from "./LogView";
import { streamStatusDetail, streamStatusLabel } from "./status";

describe("streamStatusLabel", () => {
  it("is terse for every status — never inlines the reason/message", () => {
    expect(streamStatusLabel({ kind: "starting" }, false, 0)).toBe(
      "connecting…",
    );
    expect(streamStatusLabel({ kind: "streaming" }, false, 0)).toBe(
      "streaming",
    );
    expect(
      streamStatusLabel({ kind: "waiting", reason: "PodInitializing" }, false, 0),
    ).toBe("waiting for container…");
    // The reason / message must NOT leak into the chrome label — that was
    // the visible duplicate (chrome pill + body line both showed it).
    const ended = streamStatusLabel(
      { kind: "ended", reason: "open failed: boom" },
      false,
      0,
    );
    expect(ended).toBe("ended");
    expect(ended).not.toContain("boom");
    const errored = streamStatusLabel(
      { kind: "error", message: "invoke failed" },
      false,
      0,
    );
    expect(errored).toBe("error");
    expect(errored).not.toContain("invoke failed");
  });

  it("paused wins over the underlying status and shows the buffer count", () => {
    const streaming: LogStatus = { kind: "streaming" };
    expect(streamStatusLabel(streaming, true, 0)).toBe("paused");
    expect(streamStatusLabel(streaming, true, 42)).toBe("paused · 42 buffered");
    // Even when ended, paused chrome takes precedence.
    expect(
      streamStatusLabel({ kind: "ended", reason: "x" }, true, 3),
    ).toBe("paused · 3 buffered");
  });
});

describe("streamStatusDetail", () => {
  it("carries the full reason/message for the hover tooltip", () => {
    expect(
      streamStatusDetail({ kind: "waiting", reason: "ContainerCreating" }),
    ).toBe("ContainerCreating");
    expect(
      streamStatusDetail({ kind: "ended", reason: "open failed: boom" }),
    ).toBe("open failed: boom");
    expect(
      streamStatusDetail({ kind: "error", message: "invoke failed" }),
    ).toBe("invoke failed");
  });

  it("is null when there's nothing extra to show", () => {
    expect(streamStatusDetail({ kind: "starting" })).toBeNull();
    expect(streamStatusDetail({ kind: "streaming" })).toBeNull();
  });
});
