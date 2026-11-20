import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPermanentArchiveError } from "@/server/features/search-archive/archiveFetch";
import { Ga4ReportError } from "@/server/lib/ga4Errors";
import { GscApiError, GscTokenError } from "@/server/lib/gscErrors";
import { runSearchArchive } from "./searchArchiveRun";

const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  fetchPeriod: vi.fn(),
  recordProgress: vi.fn(),
  finishRun: vi.fn(),
  recordAlerts: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {
    name = "NonRetryableError";
  },
}));
vi.mock("@/db", () => ({ withPgClient: (fn: () => unknown) => fn() }));
vi.mock("@/server/features/search-archive/SearchArchiveService", () => ({
  SearchArchiveService: mocks,
}));
vi.mock("@/server/features/daily-pulse/DailyPulseService", () => ({
  DailyPulseService: { recordAlerts: mocks.recordAlerts },
}));

const payload = {
  projectId: "project",
  runId: "run",
  mode: "backfill" as const,
};
const monthFetch = (source: string, month: string) => ({
  source,
  month,
  startDate: `${month}-01`,
  endDate: `${month}-28`,
  complete: true,
});

/**
 * A step like the engine's: each step runs until it succeeds, retrying once,
 * except that a NonRetryableError ends it at once. `names` records the steps
 * in order and `errors` what each failed attempt threw.
 */
function engineStep() {
  const names: string[] = [];
  const errors: unknown[] = [];
  const sleeps: Array<[string, unknown]> = [];
  async function stepDo<T extends Rpc.Serializable<T>>(
    name: string,
    configOrCallback: WorkflowStepConfig | (() => Promise<T>),
    callback?: () => Promise<T>,
  ): Promise<T> {
    const run =
      typeof configOrCallback === "function" ? configOrCallback : callback;
    if (!run) throw new Error(`step ${name} has no callback`);
    names.push(name);
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        errors.push(error);
        const retryable = !(
          error instanceof Error && error.name === "NonRetryableError"
        );
        if (!retryable || attempt >= 1) throw error;
      }
    }
  }
  const step: WorkflowStep = {
    do: stepDo,
    sleep: async (name, duration) => {
      sleeps.push([name, duration]);
    },
    sleepUntil: async () => {},
    waitForEvent: () => Promise.reject(new Error("not used")),
  };
  return { step, names, errors, sleeps };
}

beforeEach(() => {
  mocks.plan.mockResolvedValue({
    fetches: [
      monthFetch("gsc_site", "2026-01"),
      monthFetch("gsc_site", "2026-02"),
    ],
    notes: [],
  });
  mocks.fetchPeriod.mockResolvedValue({ rows: 5, pauseSeconds: 0 });
  mocks.recordAlerts.mockResolvedValue({ alerts: 0 });
});

describe("search archive run", () => {
  // The engine replays a run by step name, so the names must be the same on
  // every run and never repeat within one.
  it("names its steps the same way on every run", async () => {
    const first = engineStep();
    const second = engineStep();
    await runSearchArchive(payload, first.step);
    await runSearchArchive(payload, second.step);

    expect(first.names).toEqual([
      "plan",
      "gsc_site-2026-01",
      "gsc_site-2026-02",
      "pulse",
      "finish",
    ]);
    expect(second.names).toEqual(first.names);
    expect(mocks.finishRun).toHaveBeenLastCalledWith("project", "run", {
      ok: true,
      rowsWritten: 10,
      note: null,
    });
  });

  it("keeps a completed run completed when the daily pulse fails", async () => {
    mocks.recordAlerts.mockRejectedValue(new Error("pulse broke"));
    const engine = engineStep();
    await runSearchArchive(payload, engine.step);

    expect(mocks.recordAlerts).toHaveBeenCalledWith("project");
    expect(mocks.finishRun).toHaveBeenCalledTimes(1);
    expect(mocks.finishRun).toHaveBeenLastCalledWith(
      "project",
      "run",
      expect.objectContaining({ ok: true }),
    );
  });

  it("retries a transient failure and continues", async () => {
    mocks.fetchPeriod.mockRejectedValueOnce(new GscApiError(503, "down"));
    const engine = engineStep();
    await runSearchArchive(payload, engine.step);

    expect(engine.errors).toHaveLength(1);
    expect(mocks.finishRun).toHaveBeenLastCalledWith(
      "project",
      "run",
      expect.objectContaining({ ok: true }),
    );
  });

  it("fails the run without retrying a revoked grant", async () => {
    mocks.fetchPeriod.mockRejectedValueOnce(
      new GscTokenError("Grant revoked."),
    );
    const engine = engineStep();
    await expect(runSearchArchive(payload, engine.step)).rejects.toThrow(
      "Grant revoked.",
    );

    expect(engine.errors).toHaveLength(1);
    expect(mocks.fetchPeriod).toHaveBeenCalledTimes(1);
    expect(mocks.finishRun).toHaveBeenLastCalledWith("project", "run", {
      ok: false,
      rowsWritten: 0,
      note: "Grant revoked.",
    });
  });

  it("waits out GA4's quota for as long as Google asks, then fetches the month again", async () => {
    mocks.fetchPeriod.mockRejectedValueOnce(
      new Ga4ReportError("ga4_quota_exhausted", "quota", 120),
    );
    const engine = engineStep();
    await runSearchArchive(payload, engine.step);

    expect(engine.sleeps).toEqual([["gsc_site-2026-01-pause-0", 120_000]]);
    expect(engine.names).toContain("gsc_site-2026-01-after-quota-1");
    expect(mocks.fetchPeriod).toHaveBeenCalledTimes(3);
  });

  it("waits a full hour, at most, when GA4 names no usable wait", async () => {
    mocks.fetchPeriod
      .mockRejectedValueOnce(new Ga4ReportError("ga4_quota_exhausted", "q", 0))
      .mockRejectedValueOnce(
        new Ga4ReportError("ga4_quota_exhausted", "q", 7_200),
      );
    const engine = engineStep();
    await runSearchArchive(payload, engine.step);

    expect(engine.sleeps.map(([, duration]) => duration)).toEqual([
      3_600_000, 3_600_000,
    ]);
  });

  it("lets an interrupted sleep reach the engine without failing the run", async () => {
    mocks.fetchPeriod.mockResolvedValueOnce({ rows: 5, pauseSeconds: 900 });
    const interrupt = new Error("invocation cancelled");
    const engine = engineStep();
    engine.step.sleep = () => Promise.reject(interrupt);

    await expect(runSearchArchive(payload, engine.step)).rejects.toBe(
      interrupt,
    );
    expect(mocks.finishRun).not.toHaveBeenCalled();
  });
});

describe("search archive error classification", () => {
  it("retries quota, rate limits and outages", () => {
    for (const error of [
      new GscApiError(429, "quota"),
      new GscApiError(503, "down"),
      new GscApiError(
        403,
        "denied",
        '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}',
      ),
      new GscApiError(403, "denied", '{"reason":"quotaExceeded"}'),
      new Ga4ReportError("ga4_quota_exhausted", "q"),
    ]) {
      expect(isPermanentArchiveError(error), error.message).toBe(false);
    }
  });

  it("stops at once on a revoked grant or a lost property", () => {
    for (const error of [
      new GscTokenError("revoked"),
      new GscApiError(403, "denied", '{"reason":"forbidden"}'),
      new Ga4ReportError("ga4_property_inaccessible", "gone"),
    ]) {
      expect(isPermanentArchiveError(error), error.message).toBe(true);
    }
  });
});
