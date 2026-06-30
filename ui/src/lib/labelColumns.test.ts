// Pure helpers behind custom label columns. The header-shortening,
// key-universe aggregation, and `cellRaw` indirection are the bits that
// silently break a column (wrong header, missing key, value read from the
// wrong place), so they're worth pinning.

import { describe, it, expect } from "vitest";
import {
  LABEL_COL_PREFIX,
  labelColumnId,
  isLabelColumnId,
  labelColumnHeader,
  labelColumnDef,
  labelKeyUniverse,
  placeLabelColumns,
  headerWidthFloor,
  cellRaw,
} from "./labelColumns";
import type { ColumnDef, ResourceRow } from "../types";

const row = (
  fields: Record<string, unknown>,
  labels?: Record<string, string>,
): ResourceRow => ({ uid: String(fields.uid ?? "u"), __labels: labels, ...fields });

describe("labelColumnId / isLabelColumnId", () => {
  it("prefixes the key and round-trips the predicate", () => {
    const id = labelColumnId("topology.kubernetes.io/zone");
    expect(id).toBe(`${LABEL_COL_PREFIX}topology.kubernetes.io/zone`);
    expect(isLabelColumnId(id)).toBe(true);
  });

  it("does not flag backend column ids", () => {
    expect(isLabelColumnId("name")).toBe(false);
    expect(isLabelColumnId("namespace")).toBe(false);
    expect(isLabelColumnId("cpu")).toBe(false);
  });
});

describe("labelColumnHeader", () => {
  it("shows the segment after the last slash", () => {
    expect(labelColumnHeader("topology.kubernetes.io/zone")).toBe("zone");
    expect(labelColumnHeader("node-role.kubernetes.io/control-plane")).toBe(
      "control-plane",
    );
  });

  it("falls back to the whole key when there is no prefix", () => {
    expect(labelColumnHeader("app")).toBe("app");
  });

  it("falls back to the whole key when the tail is empty", () => {
    expect(labelColumnHeader("foo/")).toBe("foo/");
  });
});

describe("labelColumnDef", () => {
  it("builds a text column carrying labelKey", () => {
    const c = labelColumnDef("kubernetes.io/arch");
    expect(c).toEqual({
      id: "label:kubernetes.io/arch",
      header: "arch",
      kind: "text",
      labelKey: "kubernetes.io/arch",
    });
  });
});

describe("labelKeyUniverse", () => {
  it("collects distinct keys across rows, sorted", () => {
    const rows = [
      row({ uid: "a" }, { zone: "us-1", arch: "amd64" }),
      row({ uid: "b" }, { arch: "arm64", os: "linux" }),
      row({ uid: "c" }),
    ];
    expect(labelKeyUniverse(rows)).toEqual(["arch", "os", "zone"]);
  });

  it("returns empty when no row carries labels", () => {
    expect(labelKeyUniverse([row({ uid: "a" }), row({ uid: "b" })])).toEqual([]);
  });

  it("respects the sample limit", () => {
    const rows = [
      row({ uid: "0" }, { only: "first" }),
      row({ uid: "1" }, { hidden: "beyond-sample" }),
    ];
    // Sampling just the first row never sees the second row's keys.
    expect(labelKeyUniverse(rows, 1)).toEqual(["only"]);
  });
});

describe("placeLabelColumns", () => {
  const col = (id: string, kind?: ColumnDef["kind"]): ColumnDef => ({
    id,
    header: id,
    kind,
  });
  const labels = [labelColumnDef("zone"), labelColumnDef("arch")];

  it("inserts label columns just before the trailing Age column", () => {
    const cols = [col("name"), col("cpu"), col("creation_timestamp", "age")];
    expect(placeLabelColumns(cols, labels).map((c) => c.id)).toEqual([
      "name",
      "cpu",
      "label:zone",
      "label:arch",
      "creation_timestamp",
    ]);
  });

  it("anchors on the LAST age column (keeps an earlier age-kind col put)", () => {
    // Lease: "Renewed" (age) then "Age" (age). Labels go before the last one.
    const cols = [
      col("name"),
      col("renew_time", "age"),
      col("creation_timestamp", "age"),
    ];
    expect(placeLabelColumns(cols, labels).map((c) => c.id)).toEqual([
      "name",
      "renew_time",
      "label:zone",
      "label:arch",
      "creation_timestamp",
    ]);
  });

  it("appends when there is no age column", () => {
    const cols = [col("name"), col("data", "number")];
    expect(placeLabelColumns(cols, labels).map((c) => c.id)).toEqual([
      "name",
      "data",
      "label:zone",
      "label:arch",
    ]);
  });

  it("is a no-op when there are no label columns", () => {
    const cols = [col("name"), col("creation_timestamp", "age")];
    expect(placeLabelColumns(cols, [])).toBe(cols);
  });
});

describe("headerWidthFloor", () => {
  it("is 0 for label columns (size to values, header ellipsises)", () => {
    expect(headerWidthFloor(labelColumnDef("zone"), 120)).toBe(0);
  });

  it("is the measured header width for built-in columns", () => {
    const c = { id: "restarts", header: "Restarts", kind: "number" as const };
    expect(headerWidthFloor(c, 120)).toBe(120);
  });
});

describe("cellRaw", () => {
  it("reads label columns from __labels", () => {
    const c = labelColumnDef("zone");
    expect(cellRaw(c, row({ uid: "a" }, { zone: "us-east-1a" }))).toBe(
      "us-east-1a",
    );
  });

  it("yields undefined when the row lacks the label", () => {
    const c = labelColumnDef("zone");
    expect(cellRaw(c, row({ uid: "a" }, { other: "x" }))).toBeUndefined();
    expect(cellRaw(c, row({ uid: "a" }))).toBeUndefined();
  });

  it("reads normal columns from the top-level field", () => {
    const c = { id: "name", header: "Name", kind: "text" as const };
    expect(cellRaw(c, row({ uid: "a", name: "nginx" }))).toBe("nginx");
  });
});
