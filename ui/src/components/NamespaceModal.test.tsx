// NamespaceModal: cluster-origin chips in multi-cluster views — namespaces
// that exist on only a subset of the active members get a compressed
// cluster-name label; namespaces present everywhere render unchanged.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

import { NamespaceModal } from "./NamespaceModal";

afterEach(cleanup);

function renderModal(
  clusterTags?: Record<string, { label: string; color: string }[]>,
) {
  const onApply = vi.fn();
  render(
    <NamespaceModal
      mode="dark"
      namespaces={["default", "eu-only", "web"]}
      clusterTags={clusterTags}
      initial={new Set<string>()}
      onApply={onApply}
      onClose={() => {}}
    />,
  );
  return onApply;
}

describe("NamespaceModal cluster tags", () => {
  it("renders an origin chip only for tagged namespaces", () => {
    renderModal({ "eu-only": [{ label: "eu", color: "#0ea5e9" }] });
    const chip = screen.getByTitle("Only in eu");
    expect(chip.textContent).toBe("eu");
    // Untagged namespaces carry no chips.
    expect(screen.queryByTitle(/Only in (default|web)/)).toBeNull();
  });

  it("renders multiple chips when a namespace lives on several (not all) members", () => {
    renderModal({
      web: [
        { label: "eu", color: "#0ea5e9" },
        { label: "us", color: "#8b5cf6" },
      ],
    });
    expect(screen.getByTitle("Only in eu")).toBeTruthy();
    expect(screen.getByTitle("Only in us")).toBeTruthy();
  });

  it("renders no chips at all without clusterTags (single-cluster view)", () => {
    renderModal(undefined);
    expect(screen.queryByTitle(/Only in/)).toBeNull();
  });

  it("keeps rows clickable with chips present", () => {
    const onApply = renderModal({
      "eu-only": [{ label: "eu", color: "#0ea5e9" }],
    });
    fireEvent.click(screen.getByText("eu-only"));
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply).toHaveBeenCalledWith(new Set(["eu-only"]));
  });
});
