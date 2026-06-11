// ForwardChip renders three visible states (idle / live / failed) and tints
// the chip by the forward's status so a running tunnel reads at a glance:
// active → good, listening → info, reconnecting → warn (pulsing), failed →
// bad. These tests pin the tone-by-status mapping and the idle vs live
// chrome, since the color *is* the feature here.

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ForwardChip, forwardId } from "./forwardChip";
import { useAppStore } from "../../store";
import { tokens, hexWithAlpha, tintPair, THEMES, type Tokens } from "../../theme";
import type { ForwardEntry, ForwardStatus, ForwardTarget } from "../../types";

const t = tokens("dark");
const clusterId = "ctx-a";
const target: ForwardTarget = { kind: "Pod", namespace: "default", name: "api-0" };
const remotePort = 8080;
const id = forwardId(clusterId, target, remotePort);

function entry(status: ForwardStatus): ForwardEntry {
  return {
    spec: {
      id,
      cluster_id: clusterId,
      target,
      remote_port: remotePort,
      requested_local_port: null,
      autostart: false,
    },
    actual_local_port: 51080,
    status,
  };
}

function seed(status: ForwardStatus | null) {
  useAppStore.setState({ forwards: status ? { [id]: entry(status) } : {} });
}

// The chip's stop/start control is the first button (the one carrying the
// status dot + port, or the idle "forward" label).
function chipButton(): HTMLElement {
  const btn = screen.getAllByRole("button")[0];
  if (!btn) throw new Error("no chip button rendered");
  return btn;
}

beforeEach(() => {
  seed(null);
});

describe("ForwardChip", () => {
  it("idle: accent-colored 'forward' call-to-action, filling on hover", () => {
    render(<ForwardChip t={t} clusterId={clusterId} target={target} remotePort={remotePort} />);
    const btn = chipButton();
    expect(btn).toHaveTextContent("forward");
    // Accent text so the affordance is easy to spot; transparent until hover.
    expect(btn.style.color).toBe(toRgb(t.accent));
    expect(btn.style.background).toBe("transparent");
    fireEvent.mouseEnter(btn);
    expect(btn.style.background).not.toBe("transparent");
    fireEvent.mouseLeave(btn);
    expect(btn.style.background).toBe("transparent");
  });

  it("active: green tint + bound local port shown", () => {
    seed({ kind: "active" });
    render(<ForwardChip t={t} clusterId={clusterId} target={target} remotePort={remotePort} />);
    const btn = chipButton();
    expect(btn).toHaveTextContent(":51080");
    expect(btn.style.border).toContain(toRgb(t.good));
    expect(btn.style.color).toBe(toRgb(t.good));
    expect(btn.style.background).toBe(hexWithAlpha(t.good, 0.16));
  });

  it("listening: info (blue) tint", () => {
    seed({ kind: "listening" });
    render(<ForwardChip t={t} clusterId={clusterId} target={target} remotePort={remotePort} />);
    expect(chipButton().style.border).toContain(toRgb(t.info));
  });

  it("reconnecting: amber tint and the status dot pulses", () => {
    seed({ kind: "reconnecting", reason: "stream reset" });
    const { container } = render(
      <ForwardChip t={t} clusterId={clusterId} target={target} remotePort={remotePort} />,
    );
    expect(chipButton().style.border).toContain(toRgb(t.warn));
    // The dot animates while reconnecting so the operator notices the blip.
    expect(container.querySelector(".fs-pulse-dot")).not.toBeNull();
  });

  it("light mode darkens the live foreground for legibility (amber worst case)", () => {
    const lt = tokens("light");
    seed({ kind: "reconnecting", reason: "stream reset" });
    render(<ForwardChip t={lt} clusterId={clusterId} target={target} remotePort={remotePort} />);
    const btn = chipButton();
    // The raw amber washes out on its own pale tint, so the chip uses the same
    // darkened foreground StatusPill does — not the bare token color.
    expect(btn.style.color).toBe(tintPair(lt.warn, false).fg);
    expect(btn.style.color).not.toBe(toRgb(lt.warn));
  });

  it("failed: red tint, stop button disabled (nothing to stop)", () => {
    seed({ kind: "failed", reason: "bind: address in use" });
    render(<ForwardChip t={t} clusterId={clusterId} target={target} remotePort={remotePort} />);
    const btn = chipButton();
    expect(btn.style.border).toContain(toRgb(t.bad));
    expect(btn).toBeDisabled();
  });
});

// Every shipped theme × palette × mode. The chip pulls its colors straight
// from the resolved palette tokens, so this is the real "no surprises across
// themes" guard: a palette whose accent/status color the tint helper can't
// parse would fall through to a flat, un-tinted color — caught here.
function allPalettes(): { label: string; t: Tokens }[] {
  const out: { label: string; t: Tokens }[] = [];
  for (const theme of THEMES) {
    for (const p of theme.palettes) {
      out.push({ label: `${theme.id}/${p.id}/light`, t: p.light });
      out.push({ label: `${theme.id}/${p.id}/dark`, t: p.dark });
    }
  }
  return out;
}

const ALL_STATUSES: (ForwardStatus | null)[] = [
  null,
  { kind: "listening" },
  { kind: "active" },
  { kind: "reconnecting", reason: "stream reset" },
  { kind: "failed", reason: "bind: address in use" },
];

describe("ForwardChip color resolution across every theme", () => {
  for (const { label, t: tt } of allPalettes()) {
    it(`tints accent + all status colors for ${label}`, () => {
      // The four status tones plus the idle accent must all survive the tint
      // helper as real rgba() — a hex/rgba the parser rejected would come back
      // unchanged (no "rgba(" prefix), meaning that surface wouldn't tint.
      for (const c of [tt.accent, tt.good, tt.warn, tt.bad, tt.info]) {
        expect(hexWithAlpha(c, 0.16)).toMatch(/^rgba\(/);
      }
    });

    it(`renders every forward state without breaking for ${label}`, () => {
      for (const status of ALL_STATUSES) {
        seed(status);
        const { unmount } = render(
          <ForwardChip t={tt} clusterId={clusterId} target={target} remotePort={remotePort} />,
        );
        const btn = chipButton();
        // A colored border + non-empty text color in every state — the chip
        // never collapses to an invisible/unstyled control.
        expect(btn.style.border).toMatch(/rgb/);
        expect(btn.style.color).not.toBe("");
        unmount();
      }
    });
  }
});

// jsdom serializes a hex color set via inline style into `rgb(...)`. Mirror
// that so the `color` assertion compares apples to apples.
function toRgb(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const r = parseInt(m[1]!, 16);
  const g = parseInt(m[2]!, 16);
  const b = parseInt(m[3]!, 16);
  return `rgb(${r}, ${g}, ${b})`;
}
