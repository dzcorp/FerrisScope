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

describe("NamespaceModal selection model", () => {
  function renderSel(initial: Set<string>) {
    const onApply = vi.fn();
    render(
      <NamespaceModal
        mode="dark"
        namespaces={["default", "eu-only", "web"]}
        initial={initial}
        onApply={onApply}
        onClose={() => {}}
      />,
    );
    return onApply;
  }

  it("single-selects on a plain row click, replacing the prior selection", () => {
    const onApply = renderSel(new Set());
    fireEvent.click(screen.getByText("default"));
    fireEvent.click(screen.getByText("web")); // replaces, not adds
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply).toHaveBeenCalledWith(new Set(["web"]));
  });

  it("checkbox clicks accumulate a multi-selection", () => {
    const onApply = renderSel(new Set());
    fireEvent.click(screen.getByLabelText("Toggle default"));
    fireEvent.click(screen.getByLabelText("Toggle web"));
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply).toHaveBeenCalledWith(new Set(["default", "web"]));
  });

  it("the checkbox hit-zone stretches into the row's left padding", () => {
    renderSel(new Set());
    const box = screen.getByLabelText("Toggle default");
    // Negative margins eat the row's 8px×18px padding so a near-miss in the
    // left column still toggles (multi) rather than single-selecting the row.
    expect(box.style.marginLeft).toBe("-18px");
    expect(box.style.marginTop).toBe("-8px");
    expect(box.style.alignSelf).toBe("stretch");
  });

  it("a second checkbox click on the same row removes it", () => {
    const onApply = renderSel(new Set());
    fireEvent.click(screen.getByLabelText("Toggle default"));
    fireEvent.click(screen.getByLabelText("Toggle web"));
    fireEvent.click(screen.getByLabelText("Toggle default")); // toggle off
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply).toHaveBeenCalledWith(new Set(["web"]));
  });

  it("modifier-click on the row body toggles additively", () => {
    const onApply = renderSel(new Set());
    fireEvent.click(screen.getByText("default")); // single: {default}
    fireEvent.click(screen.getByText("web"), { metaKey: true }); // add web
    fireEvent.click(screen.getByText("eu-only"), { ctrlKey: true }); // add eu-only
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply).toHaveBeenCalledWith(
      new Set(["default", "web", "eu-only"]),
    );
  });

  it("marks 'All namespaces' pressed only when nothing is selected", () => {
    renderSel(new Set());
    const allRow = screen.getByText("All namespaces").closest("button");
    // Active state is carried by aria-pressed + accent styling, not a radio.
    expect(allRow?.getAttribute("aria-pressed")).toBe("true");
  });

  it("clears the 'All namespaces' pressed state once a namespace is picked", () => {
    renderSel(new Set());
    fireEvent.click(screen.getByText("web")); // single-select → not all-mode
    const allRow = screen.getByText("All namespaces").closest("button");
    expect(allRow?.getAttribute("aria-pressed")).toBe("false");
  });

  it("floats the initially-selected namespaces to the top of the list", () => {
    renderSel(new Set(["web"]));
    const labels = screen
      .getAllByText(/^(default|eu-only|web)$/)
      .map((n) => n.textContent);
    expect(labels[0]).toBe("web");
    // The rest keep their alpha order beneath the pinned selection.
    expect(labels.slice(1)).toEqual(["default", "eu-only"]);
  });

  it("does not reshuffle rows mid-session as the draft changes", () => {
    renderSel(new Set(["web"]));
    fireEvent.click(screen.getByText("default")); // single-select default
    const labels = screen
      .getAllByText(/^(default|eu-only|web)$/)
      .map((n) => n.textContent);
    // `web` stays pinned to the top even though it is no longer selected;
    // ordering is frozen for the session and only refreshes on the next open.
    expect(labels[0]).toBe("web");
  });
});
