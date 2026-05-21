import { describe, it, expect } from "vitest";
import { findLogMatches, splitHighlight } from "./logSearch";

describe("findLogMatches", () => {
  const lines = [
    { text: "starting up" },
    { text: "connection refused" },
    { text: "Connection re-established" },
    { text: "all good" },
  ];

  it("returns indices of lines containing the query, case-insensitively", () => {
    expect(findLogMatches(lines, "connection")).toEqual([1, 2]);
  });

  it("matches a substring anywhere in the line", () => {
    expect(findLogMatches(lines, "refused")).toEqual([1]);
  });

  it("returns an empty array for a blank query (matches nothing)", () => {
    expect(findLogMatches(lines, "")).toEqual([]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(findLogMatches(lines, "zzz")).toEqual([]);
  });

  it("strips ANSI before matching so coloured lines still hit", () => {
    const colored = [{ text: "\x1b[31mfatal error\x1b[0m here" }];
    expect(findLogMatches(colored, "fatal error")).toEqual([0]);
    // The escape bytes themselves are never matchable.
    expect(findLogMatches(colored, "[31m")).toEqual([]);
  });
});

describe("splitHighlight", () => {
  it("splits a single match into non-match / match / non-match", () => {
    expect(splitHighlight("the error here", "error")).toEqual([
      { text: "the ", match: false },
      { text: "error", match: true },
      { text: " here", match: false },
    ]);
  });

  it("preserves the source casing while matching case-insensitively", () => {
    expect(splitHighlight("Error: ERROR", "error")).toEqual([
      { text: "Error", match: true },
      { text: ": ", match: false },
      { text: "ERROR", match: true },
    ]);
  });

  it("highlights a match at the start and end", () => {
    expect(splitHighlight("abcabc", "abc")).toEqual([
      { text: "abc", match: true },
      { text: "abc", match: true },
    ]);
  });

  it("returns a single non-match segment for a blank query", () => {
    const segs = splitHighlight("anything", "");
    expect(segs).toEqual([{ text: "anything", match: false }]);
    expect(segs.length === 1 && !segs[0]!.match).toBe(true);
  });

  it("returns a single non-match segment when there is no match", () => {
    expect(splitHighlight("nothing to see", "xyz")).toEqual([
      { text: "nothing to see", match: false },
    ]);
  });
});
