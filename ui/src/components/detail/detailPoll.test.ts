import { describe, it, expect } from "vitest";
import { DETAIL_POLL_MS, shouldPollDetail } from "./detailPoll";

const base = { hidden: false, yamlEditing: false, tab: "summary" as string };

describe("shouldPollDetail", () => {
  it("polls on pull-based tabs that key on detailVersion", () => {
    for (const tab of ["summary", "yaml", "related"]) {
      expect(shouldPollDetail({ ...base, tab })).toBe(true);
    }
  });

  it("does not poll on tabs with their own live stream", () => {
    for (const tab of ["events", "logs", "metrics"]) {
      expect(shouldPollDetail({ ...base, tab })).toBe(false);
    }
  });

  it("does not poll on an unknown tab", () => {
    expect(shouldPollDetail({ ...base, tab: "bogus" })).toBe(false);
  });

  it("pauses while the window is hidden, even on a pull tab", () => {
    expect(shouldPollDetail({ ...base, hidden: true })).toBe(false);
  });

  it("pauses while a YAML draft is in flight", () => {
    // The clobber-sensitive case: yaml tab + active buffer.
    expect(shouldPollDetail({ hidden: false, yamlEditing: true, tab: "yaml" })).toBe(
      false,
    );
    // Editing also suppresses polling for the summary tab beneath.
    expect(
      shouldPollDetail({ hidden: false, yamlEditing: true, tab: "summary" }),
    ).toBe(false);
  });

  it("hidden takes precedence over an otherwise-pollable tab", () => {
    expect(
      shouldPollDetail({ hidden: true, yamlEditing: false, tab: "related" }),
    ).toBe(false);
  });

  it("uses a 10s cadence", () => {
    expect(DETAIL_POLL_MS).toBe(10_000);
  });
});
