import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FieldsTab } from "./FieldsTab";
import { tokens } from "../../theme";
import type { DocState, InspectSubject } from ".";

afterEach(cleanup);

const t = tokens("dark");

function subject(name: string, i: number): InspectSubject {
  return {
    sid: `ctx::${name}-uid`,
    uid: `${name}-uid`,
    clusterId: "ctx",
    clusterName: "prod",
    colorIdx: i,
    namespace: "default",
    name,
  };
}

function ok(doc: Record<string, unknown>): DocState {
  return { status: "ok", doc: doc as DocState extends { doc: infer D } ? D : never };
}

function show(
  subjects: InspectSubject[],
  docs: [string, DocState][],
) {
  render(<FieldsTab t={t} subjects={subjects} docs={new Map(docs)} />);
}

const A = subject("web-a", 0);
const B = subject("web-b", 1);

describe("FieldsTab", () => {
  it("hides matching fields by default and counts the differences", () => {
    show(
      [A, B],
      [
        [A.sid, ok({ spec: { replicas: 3, image: "v1" } })],
        [B.sid, ok({ spec: { replicas: 3, image: "v2" } })],
      ],
    );
    expect(screen.getByText("1 of 2 fields differ")).toBeInTheDocument();
    expect(screen.getByText("spec.image")).toBeInTheDocument();
    expect(screen.queryByText("spec.replicas")).not.toBeInTheDocument();
  });

  it("reveals matching fields when the filter is turned off", () => {
    show(
      [A, B],
      [
        [A.sid, ok({ spec: { replicas: 3, image: "v1" } })],
        [B.sid, ok({ spec: { replicas: 3, image: "v2" } })],
      ],
    );
    fireEvent.click(screen.getByLabelText("Differences only"));
    expect(screen.getByText("spec.replicas")).toBeInTheDocument();
  });

  // "set here, missing there" is a difference — the whole point of the view.
  it("renders a missing value as a placeholder and counts it as differing", () => {
    show(
      [A, B],
      [
        [A.sid, ok({ spec: { image: "v1" } })],
        [B.sid, ok({ spec: {} })],
      ],
    );
    expect(screen.getByText("spec.image")).toBeInTheDocument();
    // `spec: {}` on B flattens to its own leaf, so both that row and the
    // image row carry a placeholder.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("says so when everything matches", () => {
    show(
      [A, B],
      [
        [A.sid, ok({ spec: { replicas: 3 } })],
        [B.sid, ok({ spec: { replicas: 3 } })],
      ],
    );
    expect(screen.getByText("No differences")).toBeInTheDocument();
  });

  // A column of blanks would read as "unset here", which is a different claim
  // from "we could not read this object".
  it("drops a subject whose manifest failed instead of blanking its column", () => {
    show(
      [A, B],
      [
        [A.sid, ok({ spec: { image: "v1" } })],
        [B.sid, { status: "error", message: "404" }],
      ],
    );
    // One readable subject means nothing can differ, so the grid only appears
    // once the filter is off.
    expect(screen.getByText("0 of 1 fields differ")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Differences only"));
    expect(screen.getByText("web-a")).toBeInTheDocument();
    expect(screen.queryByText("web-b")).not.toBeInTheDocument();
  });

  it("renders one column header per readable subject", () => {
    show(
      [A, B],
      [
        [A.sid, ok({ spec: { image: "v1" } })],
        [B.sid, ok({ spec: { image: "v2" } })],
      ],
    );
    expect(screen.getByText("Field")).toBeInTheDocument();
    expect(screen.getByText("web-a")).toBeInTheDocument();
    expect(screen.getByText("web-b")).toBeInTheDocument();
  });
});
