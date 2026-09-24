// ForwardChip renders three visible states (idle / live / failed) and tints
// the chip by the forward's status so a running tunnel reads at a glance:
// active → good, listening → info, reconnecting → warn (pulsing), failed →
// bad. These tests pin the tone-by-status mapping and the idle vs live
// chrome, since the color *is* the feature here.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ForwardChip, forwardId, parseLocalPort, portIssue } from "./forwardChip";
import { api } from "../../api";
import { useAppStore } from "../../store";
import { tokens, hexWithAlpha, tintPair, THEMES, type Tokens } from "../../theme";
import type { ForwardEntry, ForwardStatus, ForwardTarget, LocalPortCheck } from "../../types";

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
  it("idle: split pill — auto 'forward' half + port-picker half, each filling on hover", () => {
    render(<ForwardChip t={t} clusterId={clusterId} target={target} remotePort={remotePort} />);
    const btn = chipButton();
    const pick = screen.getByRole("button", { name: "Pick local port" });
    expect(btn).toHaveTextContent("forward");
    // Both halves share one bordered group, split by a divider on the picker half.
    expect(btn.parentElement).toBe(pick.parentElement);
    expect(btn.parentElement!.style.border).toMatch(/rgb/);
    expect(pick.style.borderLeft).toMatch(/rgb/);
    fireEvent.mouseEnter(pick);
    expect(pick.style.background).not.toBe("transparent");
    expect(btn.style.background).toBe("transparent");
    fireEvent.mouseLeave(pick);
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

describe("parseLocalPort", () => {
  it("empty means auto", () => expect(parseLocalPort("")).toBeNull());
  it("accepts the TCP range", () => {
    expect(parseLocalPort("1")).toBe(1);
    expect(parseLocalPort("8080")).toBe(8080);
    expect(parseLocalPort("65535")).toBe(65535);
  });
  it("rejects out-of-range and non-numeric", () => {
    for (const bad of ["0", "65536", "99999", "123456", "80a", "-1", "8.0", " 80"]) {
      expect(parseLocalPort(bad)).toBeUndefined();
    }
  });
});

function portCheck(port: number, probe: LocalPortCheck["probe"], extra: Partial<LocalPortCheck> = {}): LocalPortCheck {
  return { port, probe, held_by: null, suggestion: null, ...extra };
}

describe("portIssue", () => {
  it("free port has no issue", () => {
    expect(portIssue(portCheck(8080, { kind: "free" }))).toBeNull();
  });
  it("explains each clash kind with a title and blocking flag", () => {
    expect(portIssue(portCheck(8080, { kind: "in_use" }))).toMatchObject({
      tone: "warn",
      blocking: true,
      title: "Port 8080 is in use",
    });
    expect(portIssue(portCheck(80, { kind: "permission_denied" }))).toMatchObject({
      tone: "bad",
      title: "Port 80 needs admin rights",
    });
    expect(portIssue(portCheck(50000, { kind: "permission_denied" }))?.title).toBe(
      "Port 50000 is reserved by the system",
    );
    expect(portIssue(portCheck(1, { kind: "error", message: "boom" }))).toMatchObject({
      blocking: true,
      detail: "boom",
    });
  });
  it("shadowed warns without blocking and names the other listener", () => {
    const issue = portIssue(portCheck(8080, { kind: "shadowed", addr: "[::1]:8080" }));
    expect(issue).toMatchObject({ tone: "warn", blocking: false, title: "Port 8080 is shared" });
    expect(issue?.detail).toContain("[::1]:8080");
  });
  it("names our own forward holding the port", () => {
    const other = entry({ kind: "active" });
    const c = portCheck(8080, { kind: "in_use" }, { held_by: other.spec.id });
    expect(portIssue(c, other)).toMatchObject({
      title: "Port 8080 is already forwarded",
      detail: "Pod api-0:8080 is using it.",
    });
    expect(portIssue(c)?.detail).toMatch(/Another FerrisScope forward/);
  });
});

describe("ForwardChip local-port picker", () => {
  beforeEach(() => {
    vi.spyOn(api, "pfCheckLocalPort").mockImplementation(async (port) => portCheck(port, { kind: "free" }));
  });
  afterEach(() => vi.restoreAllMocks());

  function renderChip() {
    render(<ForwardChip t={t} clusterId={clusterId} target={target} remotePort={remotePort} />);
  }

  it("main chip still starts on an automatic port", async () => {
    const start = vi.spyOn(api, "pfStart").mockResolvedValue(entry({ kind: "listening" }));
    renderChip();
    fireEvent.click(chipButton());
    await waitFor(() => expect(start).toHaveBeenCalledWith(clusterId, target, remotePort, null, false));
    expect(await screen.findByText(":51080")).toBeInTheDocument();
  });

  it("caret opens an input prefilled with the remote port; Enter starts on it", async () => {
    const start = vi.spyOn(api, "pfStart").mockResolvedValue(entry({ kind: "listening" }));
    renderChip();
    fireEvent.click(screen.getByRole("button", { name: "Pick local port" }));
    const input = screen.getByRole("textbox", { name: "Local port" });
    expect(input).toHaveValue(String(remotePort));
    fireEvent.change(input, { target: { value: "9000" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(start).toHaveBeenCalledWith(clusterId, target, remotePort, 9000, false));
    expect(await screen.findByText(":51080")).toBeInTheDocument();
  });

  it("empty input starts on an automatic port", async () => {
    const start = vi.spyOn(api, "pfStart").mockResolvedValue(entry({ kind: "listening" }));
    renderChip();
    fireEvent.click(screen.getByRole("button", { name: "Pick local port" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Local port" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Start forward" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(clusterId, target, remotePort, null, false));
  });

  it("invalid port disables start and never calls the backend", () => {
    const start = vi.spyOn(api, "pfStart");
    renderChip();
    fireEvent.click(screen.getByRole("button", { name: "Pick local port" }));
    const input = screen.getByRole("textbox", { name: "Local port" });
    fireEvent.change(input, { target: { value: "70000" } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Enter a port from 1 to 65535");
    expect(screen.getByRole("button", { name: "Start forward" })).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(start).not.toHaveBeenCalled();
  });

  it("picker shows only the port input, no loopback prefix", () => {
    renderChip();
    fireEvent.click(screen.getByRole("button", { name: "Pick local port" }));
    expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull();
  });

  it("Esc and × return to idle without starting", () => {
    const start = vi.spyOn(api, "pfStart");
    renderChip();
    fireEvent.click(screen.getByRole("button", { name: "Pick local port" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Local port" }), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pick local port" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("busy port: says why, blocks start, and one-click starts the suggested port", async () => {
    vi.mocked(api.pfCheckLocalPort).mockResolvedValue(
      portCheck(remotePort, { kind: "in_use" }, { suggestion: 8081 }),
    );
    const start = vi.spyOn(api, "pfStart").mockResolvedValue(entry({ kind: "listening" }));
    renderChip();
    fireEvent.click(screen.getByRole("button", { name: "Pick local port" }));
    expect(await screen.findByText("Port 8080 is in use")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Another app on this machine");
    expect(screen.getByRole("button", { name: "Start forward" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Local port" }), { key: "Enter" });
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use 8081" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(clusterId, target, remotePort, 8081, false));
  });

  it("a stale check for a previous draft never blocks the current port", async () => {
    vi.mocked(api.pfCheckLocalPort).mockImplementation(async (port) =>
      port === remotePort ? portCheck(port, { kind: "in_use" }) : portCheck(port, { kind: "free" }),
    );
    renderChip();
    fireEvent.click(screen.getByRole("button", { name: "Pick local port" }));
    await screen.findByText("Port 8080 is in use");
    fireEvent.change(screen.getByRole("textbox", { name: "Local port" }), { target: { value: "9001" } });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: "Start forward" })).not.toBeDisabled();
  });

  it("losing the port race after the pre-check shows the clash inline", async () => {
    vi.mocked(api.pfCheckLocalPort)
      .mockResolvedValueOnce(portCheck(remotePort, { kind: "free" }))
      .mockResolvedValue(portCheck(remotePort, { kind: "in_use" }, { suggestion: 8081 }));
    vi.spyOn(api, "pfStart").mockRejectedValue("io: Address already in use (os error 98)");
    renderChip();
    fireEvent.click(screen.getByRole("button", { name: "Pick local port" }));
    await waitFor(() => expect(api.pfCheckLocalPort).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Local port" }), { key: "Enter" });
    expect(await screen.findByText("Port 8080 is in use")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use 8081" })).toBeInTheDocument();
  });

  it("shadowed port warns but still lets the operator start on it", async () => {
    vi.mocked(api.pfCheckLocalPort).mockResolvedValue(
      portCheck(remotePort, { kind: "shadowed", addr: "[::1]:8080" }, { suggestion: 8081 }),
    );
    const start = vi.spyOn(api, "pfStart").mockResolvedValue(entry({ kind: "listening" }));
    renderChip();
    fireEvent.click(screen.getByRole("button", { name: "Pick local port" }));
    expect(await screen.findByText("Port 8080 is shared")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use 8081" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start forward" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith(clusterId, target, remotePort, 8080, false));
  });

  it("reopening the picker drops the previous check result", async () => {
    vi.mocked(api.pfCheckLocalPort).mockResolvedValueOnce(portCheck(remotePort, { kind: "in_use" }));
    renderChip();
    fireEvent.click(screen.getByRole("button", { name: "Pick local port" }));
    await screen.findByText("Port 8080 is in use");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick local port" }));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("suggestion button keeps its own border", async () => {
    vi.mocked(api.pfCheckLocalPort).mockResolvedValue(
      portCheck(remotePort, { kind: "in_use" }, { suggestion: 8081 }),
    );
    renderChip();
    fireEvent.click(screen.getByRole("button", { name: "Pick local port" }));
    const use = await screen.findByRole("button", { name: "Use 8081" });
    expect(use.style.borderStyle).toBe("solid");
    expect(use.style.borderLeftColor).toMatch(/rgb/);
  });

  it("bind failure keeps the picker open so the operator can pick another port", async () => {
    vi.spyOn(api, "pfStart").mockRejectedValue("bind: address in use");
    renderChip();
    fireEvent.click(screen.getByRole("button", { name: "Pick local port" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Local port" }), { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Local port" })).not.toBeDisabled(),
    );
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
        // never collapses to an invisible/unstyled control. Idle draws its
        // border on the split group, live states on the chip itself.
        const edge = status ? btn : btn.parentElement!;
        expect(edge.style.border).toMatch(/rgb/);
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
