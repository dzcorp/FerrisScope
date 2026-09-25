import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { renderCell, rowComparatorFor } from "./ResourceTable";
import { tokens } from "../theme";

describe("GitOps table status columns", () => {
  it("renders independent sync and health cells", () => {
    const row = { uid: "u", name: "app", sync: "OutOfSync", health: "Healthy" };
    const { getByText } = render(
      <>
        {renderCell(
          { id: "sync", header: "Sync", kind: "phase" },
          row,
          "dark",
          tokens("dark"),
          false,
          null,
          false,
          () => {},
          () => {},
        )}
        {renderCell(
          { id: "health", header: "Health", kind: "phase" },
          row,
          "dark",
          tokens("dark"),
          false,
          null,
          false,
          () => {},
          () => {},
        )}
      </>,
    );
    expect(getByText("OutOfSync")).toBeInTheDocument();
    expect(getByText("Healthy")).toBeInTheDocument();
  });

  it("sorts failures and drift before healthy resources", () => {
    const compare = rowComparatorFor(
      { id: "health", header: "Health", kind: "phase" },
      { current: null },
      false,
    );
    const row = (health: string) => ({ uid: health, health });
    expect(compare(row("Degraded"), row("Healthy"))).toBeLessThan(0);
    expect(compare(row("OutOfSync"), row("Synced"))).toBeLessThan(0);
    expect(compare(row("Stalled"), row("Ready"))).toBeLessThan(0);
  });
});
