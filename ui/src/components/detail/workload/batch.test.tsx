// Job / CronJob detail surfaces: the duration helpers, the parallelism
// variant of the ReplicasEditor pill, and the CronJob run-history section.
//
// The history section's empty state is asserted on purpose — "no runs" and
// "runs aged out of the cluster" look identical to a user, and only one of
// them is a problem worth chasing.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CronJobSummary, formatSeconds, untilIso } from "./index";
import { ReplicasEditor } from "./shared";
import { EditSessionProvider } from "../editSession";
import { GlobalSaveBar } from "../globalSaveBar";
import { tokens } from "../../../theme";
import { resetMockInvoke, setMockInvoke } from "../../../test/tauri-mock";
import type { CronJobDetail, CronJobRun } from "../../../types";

const t = tokens("dark");

beforeEach(() => {
  resetMockInvoke();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/// Records every invoke so a test can assert on the payload a control sent,
/// and answers from `replies`. An unlisted command throws — a component that
/// starts calling something new should fail loudly, not coast on undefined.
function stubInvoke(replies: Record<string, unknown | (() => unknown)>) {
  const calls: { cmd: string; args: Record<string, unknown> | undefined }[] = [];
  setMockInvoke((cmd, args) => {
    calls.push({ cmd, args });
    if (!(cmd in replies)) throw new Error(`unexpected command: ${cmd}`);
    const reply = replies[cmd];
    return typeof reply === "function" ? (reply as () => unknown)() : reply;
  });
  return calls;
}

describe("formatSeconds", () => {
  it("shows the two largest non-zero units", () => {
    expect(formatSeconds(45)).toBe("45s");
    expect(formatSeconds(90)).toBe("1m 30s");
    expect(formatSeconds(3 * 3600 + 4 * 60)).toBe("3h 4m");
    expect(formatSeconds(2 * 86400 + 5 * 3600)).toBe("2d 5h");
  });

  /// A negative or fractional span must not render "-1m -30s" — the caller
  /// computes it from two clocks that can disagree.
  it("clamps at zero and floors fractions", () => {
    expect(formatSeconds(-10)).toBe("0s");
    expect(formatSeconds(1.9)).toBe("1s");
  });
});

describe("untilIso", () => {
  it("counts forward to a future instant", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T10:00:00Z"));
    expect(untilIso("2026-08-27T13:30:00Z")).toBe("3h 30m");
  });

  /// A next-run time that has slipped into the past means our computed value
  /// is stale, not that the job runs in negative time.
  it("reports 'now' once the instant has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T10:00:00Z"));
    expect(untilIso("2026-08-27T09:00:00Z")).toBe("now");
  });

  it("returns a dash for an unparseable instant", () => {
    expect(untilIso("not a date")).toBe("—");
  });
});

describe("ReplicasEditor — parallelism variant", () => {
  function mount() {
    return render(
      <EditSessionProvider
        target={{
          clusterId: "ctx",
          kindId: "jobs",
          namespace: "default",
          name: "migrate",
        }}
        onSaved={() => {}}
      >
        <ReplicasEditor t={t} desired={3} field="parallelism" label="parallel" />
        <GlobalSaveBar t={t} />
      </EditSessionProvider>,
    );
  }

  it("labels itself with the field it owns, not 'replicas'", () => {
    const { container } = mount();
    expect(container.textContent).toContain("parallel");
    expect(container.textContent).not.toContain("replicas");
  });

  /// The whole reason the pill is parameterised: it must write
  /// `spec.parallelism`, never `spec.replicas` — a Job has no such field and
  /// the apiserver would reject the apply.
  it("serializes to spec.parallelism", async () => {
    const { container } = mount();
    const label = Array.from(container.querySelectorAll("span")).find(
      (s) => s.textContent === "parallel",
    );
    fireEvent.click(label!.parentElement!);

    const input = container.querySelector(
      "input[type='text']",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "5" } });

    const calls = stubInvoke({
      apply_resource_cmd: { kind: "applied", resource_version: "2" },
    });
    fireEvent.click(await screen.findByText(/^Save \(1\)$/));

    await waitFor(() => {
      const call = calls.find((c) => c.cmd === "apply_resource_cmd");
      expect(call).toBeTruthy();
      expect(call!.args?.fields).toEqual({ spec: { parallelism: 5 } });
    });
  });
});

function cronDetail(over: Partial<CronJobDetail> = {}): CronJobDetail {
  return {
    meta: {
      name: "nightly",
      namespace: "default",
      uid: "u1",
      creation_timestamp: "2026-08-01T00:00:00Z",
      labels: [],
      annotations: [],
      owner_references: [],
      finalizers: [],
      resource_version: "1",
      generation: 1,
      managed_fields: [],
    } as unknown as CronJobDetail["meta"],
    schedule: "0 3 * * *",
    time_zone: null,
    suspend: false,
    concurrency_policy: "Allow",
    starting_deadline_seconds: null,
    successful_jobs_history_limit: 3,
    failed_jobs_history_limit: 1,
    next_run: "2026-08-28T03:00:00Z",
    last_schedule_time: null,
    last_successful_time: null,
    active: [],
    job_template: null,
    pod_template: null,
    ...over,
  };
}

function run(over: Partial<CronJobRun> = {}): CronJobRun {
  return {
    uid: "j1",
    name: "nightly-28001",
    namespace: "default",
    phase: "Succeeded",
    succeeded: 1,
    failed: 0,
    active: 0,
    completions_desired: 1,
    start_time: "2026-08-27T03:00:00Z",
    completion_time: "2026-08-27T03:00:30Z",
    duration_seconds: 30,
    creation_timestamp: "2026-08-27T03:00:00Z",
    manual: false,
    ...over,
  };
}

function mountCronJob(detail: CronJobDetail, runs: CronJobRun[]) {
  stubInvoke({
    get_cron_job_detail_cmd: detail,
    list_jobs_for_cron_job_cmd: runs,
  });
  return render(
    <CronJobSummary
      mode="dark"
      clusterId="ctx"
      namespace="default"
      name="nightly"
      detailVersion={0}
    />,
  );
}

describe("CronJobSummary — next run", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-08-27T10:00:00Z"));
  });

  it("renders the computed next fire with its absolute instant", async () => {
    const { container } = mountCronJob(cronDetail(), []);
    await waitFor(() => expect(container.textContent).toContain("Next Run"));
    expect(container.textContent).toContain("2026-08-28T03:00:00Z");
    expect(container.textContent).toContain("17h 0m");
  });

  /// A schedule we couldn't evaluate must say so rather than render a blank
  /// row an operator would read as "never runs".
  it("explains a missing next run instead of showing an empty row", async () => {
    const { container } = mountCronJob(cronDetail({ next_run: null }), []);
    await waitFor(() => expect(container.textContent).toContain("Next Run"));
    expect(container.textContent).toContain("not evaluable");
  });

  /// The controller keeps evaluating the schedule while suspended; it just
  /// never acts on it. Showing the time without that caveat would be a lie.
  it("marks the next run as inert while suspended", async () => {
    const { container } = mountCronJob(cronDetail({ suspend: true }), []);
    await waitFor(() => expect(container.textContent).toContain("Next Run"));
    expect(container.textContent).toContain("will not fire");
  });
});

describe("CronJobSummary — run history", () => {
  it("lists owned Jobs with outcome, duration and a manual marker", async () => {
    const { container } = mountCronJob(cronDetail(), [
      run(),
      run({
        uid: "j2",
        name: "nightly-manual-1",
        manual: true,
        phase: "Failed",
        succeeded: 0,
        failed: 3,
        completion_time: null,
        duration_seconds: null,
      }),
    ]);

    await waitFor(() =>
      expect(container.textContent).toContain("nightly-28001"),
    );
    expect(container.textContent).toContain("Run History");
    expect(container.textContent).toContain("took 30s");
    expect(container.textContent).toContain("nightly-manual-1");
    expect(container.textContent).toContain("manual");
    expect(container.textContent).toContain("3 failed");
    expect(container.textContent).toContain("2 kept");
  });

  /// An empty history is a retention fact, not "this CronJob never ran".
  /// Saying only "no runs" would send operators looking for a scheduling bug
  /// that isn't there.
  it("attributes an empty history to the CronJob's own retention limits", async () => {
    const { container } = mountCronJob(cronDetail(), []);
    await waitFor(() =>
      expect(container.textContent).toContain("history limits"),
    );
    expect(container.textContent).toContain("No Jobs owned by this CronJob");
  });

  /// The history call failing must not take the rest of the panel with it —
  /// the schedule and spec are still worth reading.
  it("keeps the rest of the panel when history fails to load", async () => {
    stubInvoke({
      get_cron_job_detail_cmd: cronDetail(),
      list_jobs_for_cron_job_cmd: () => {
        throw new Error("forbidden: cannot list jobs");
      },
    });
    const { container } = render(
      <CronJobSummary
        mode="dark"
        clusterId="ctx"
        namespace="default"
        name="nightly"
        detailVersion={0}
      />,
    );
    await waitFor(() =>
      expect(container.textContent).toContain("Couldn't load run history"),
    );
    expect(container.textContent).toContain("Cron Expression");
  });
});

