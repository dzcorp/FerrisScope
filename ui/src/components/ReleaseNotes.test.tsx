// ReleaseNotes: the About panel's dynamic "What's new" view. Guards the merged
// grouping, the version-range title, the per-version toggle, and the
// loading/empty/error states — the bits CLAUDE.md calls "finishing the loop".

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { ReleaseNotes } from "./ReleaseNotes";
import { tokens } from "../theme";
import { setMockInvoke, resetMockInvoke } from "../test/tauri-mock";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReleaseNote, ReleaseNotesBundle } from "../types";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

const t = tokens("dark");

function rel(version: string, changes: ReleaseNote["changes"]): ReleaseNote {
  return {
    version,
    tag: `v${version}`,
    name: `v${version}`,
    published_at: "2026-06-20T00:00:00Z",
    html_url: `https://github.com/dzcorp/FerrisScope/releases/tag/v${version}`,
    changes,
  };
}

function bundle(releases: ReleaseNote[]): ReleaseNotesBundle {
  return {
    current_version: "1.0.0",
    latest_version: releases[0]?.version ?? null,
    releases,
    fetched_at: 0,
  };
}

const MULTI = bundle([
  rel("1.0.27", [
    { kind: "feat", scope: "port-forward", text: "global DNS forwarding", pr: 45, author: "u" },
  ]),
  rel("1.0.26", [{ kind: "fix", scope: "watch", text: "keepalive", pr: 44, author: "u" }]),
]);

beforeEach(() => {
  vi.mocked(openUrl).mockClear();
});

afterEach(() => {
  resetMockInvoke();
  cleanup();
});

describe("ReleaseNotes", () => {
  it("renders a merged, version-range title with grouped changes", async () => {
    setMockInvoke(() => MULTI);
    render(<ReleaseNotes t={t} />);

    expect(await screen.findByText("What's new in v1.0.26 – v1.0.27")).toBeTruthy();
    // Both groups present, changes merged across the two releases.
    expect(screen.getByText("Features")).toBeTruthy();
    expect(screen.getByText("Fixes")).toBeTruthy();
    expect(screen.getByText("global DNS forwarding")).toBeTruthy();
    expect(screen.getByText("keepalive")).toBeTruthy();
    // PR deep-link renders.
    expect(screen.getByText("#45")).toBeTruthy();
  });

  it("toggles to a per-version breakdown and back", async () => {
    setMockInvoke(() => MULTI);
    render(<ReleaseNotes t={t} />);
    const toggle = await screen.findByText("Show per-version");
    fireEvent.click(toggle);
    // Per-version headers appear (one per release).
    expect(screen.getByText("v1.0.27")).toBeTruthy();
    expect(screen.getByText("v1.0.26")).toBeTruthy();
    expect(screen.getByText("Show merged")).toBeTruthy();
  });

  it("uses a single version (no range) when only one release pends", async () => {
    setMockInvoke(() => bundle([rel("1.0.27", [{ kind: "feat", scope: null, text: "a", pr: 1, author: null }])]));
    render(<ReleaseNotes t={t} />);
    expect(await screen.findByText("What's new in v1.0.27")).toBeTruthy();
    // No per-version toggle for a single release.
    expect(screen.queryByText("Show per-version")).toBeNull();
  });

  it("shows an up-to-date message when there are no newer releases", async () => {
    setMockInvoke(() => bundle([]));
    render(<ReleaseNotes t={t} />);
    expect(
      await screen.findByText(/on the latest version/i),
    ).toBeTruthy();
  });

  it("surfaces a load error", async () => {
    setMockInvoke(() => {
      throw new Error("network down");
    });
    render(<ReleaseNotes t={t} />);
    await waitFor(() => {
      expect(screen.getByText(/network down/i)).toBeTruthy();
    });
  });

  it("force-refetches when reloadKey changes, but not on first render", async () => {
    const calls: { force: unknown }[] = [];
    setMockInvoke((_cmd, args) => {
      calls.push({ force: (args as { force: unknown }).force });
      return MULTI;
    });
    const { rerender } = render(<ReleaseNotes t={t} reloadKey="a:1.0.0" />);
    await screen.findByText("What's new in v1.0.26 – v1.0.27");
    // Mount load is cached (force=false), no extra fetch yet.
    expect(calls).toEqual([{ force: false }]);

    // A check that changes the detected version → one forced refetch.
    rerender(<ReleaseNotes t={t} reloadKey="a:1.0.27" />);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ force: true });
  });
});
