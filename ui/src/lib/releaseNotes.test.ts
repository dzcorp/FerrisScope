import { describe, it, expect } from "vitest";
import type { ChangeItem, ReleaseNote } from "../types";
import {
  changeSummary,
  groupChanges,
  groupKeyForKind,
  totalChangeCount,
  versionRangeLabel,
} from "./releaseNotes";

function change(partial: Partial<ChangeItem>): ChangeItem {
  return {
    kind: "other",
    scope: null,
    text: "x",
    pr: null,
    author: null,
    ...partial,
  };
}

function release(version: string, changes: ChangeItem[]): ReleaseNote {
  return {
    version,
    tag: `v${version}`,
    name: `v${version}`,
    published_at: null,
    html_url: `https://github.com/dzcorp/FerrisScope/releases/tag/v${version}`,
    changes,
  };
}

describe("versionRangeLabel", () => {
  it("returns a single version when only one release pends", () => {
    expect(versionRangeLabel([release("1.0.27", [])])).toBe("v1.0.27");
  });

  it("collapses skipped versions into a range (newest-first input)", () => {
    const releases = [
      release("1.0.27", []),
      release("1.0.26", []),
      release("1.0.1", []),
    ];
    expect(versionRangeLabel(releases)).toBe("v1.0.1 – v1.0.27");
  });

  it("is empty for no releases", () => {
    expect(versionRangeLabel([])).toBe("");
  });
});

describe("groupKeyForKind", () => {
  it("maps feat/fix to their groups and everything else to other", () => {
    expect(groupKeyForKind("feat")).toBe("features");
    expect(groupKeyForKind("fix")).toBe("fixes");
    expect(groupKeyForKind("refactor")).toBe("other");
    expect(groupKeyForKind("perf")).toBe("other");
    expect(groupKeyForKind("anything")).toBe("other");
  });
});

describe("groupChanges", () => {
  it("merges changes across releases, tagging source version, dropping empty groups", () => {
    const releases = [
      release("1.0.27", [change({ kind: "feat", text: "newest" })]),
      release("1.0.26", [
        change({ kind: "fix", text: "a" }),
        change({ kind: "chore", text: "bump" }),
      ]),
    ];
    const groups = groupChanges(releases);
    // Features, Fixes, Other — all three present here.
    expect(groups.map((g) => g.key)).toEqual(["features", "fixes", "other"]);
    const features = groups.find((g) => g.key === "features");
    expect(features?.items).toHaveLength(1);
    expect(features?.items[0]?.version).toBe("1.0.27");
    // "chore" folds into Other.
    expect(groups.find((g) => g.key === "other")?.items[0]?.text).toBe("bump");
  });

  it("omits groups with no items", () => {
    const groups = groupChanges([
      release("1.0.1", [change({ kind: "feat", text: "only feature" })]),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["features"]);
  });
});

describe("totalChangeCount", () => {
  it("sums changes across all releases", () => {
    const releases = [
      release("1.0.27", [change({}), change({})]),
      release("1.0.26", [change({})]),
    ];
    expect(totalChangeCount(releases)).toBe(3);
  });
});

describe("changeSummary", () => {
  it("prefixes the scope when present", () => {
    expect(changeSummary(change({ scope: "watch", text: "keepalive" }))).toBe(
      "watch: keepalive",
    );
    expect(changeSummary(change({ scope: null, text: "plain" }))).toBe("plain");
  });
});
