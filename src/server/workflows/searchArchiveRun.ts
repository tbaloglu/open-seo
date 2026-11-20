import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { DailyPulseService } from "@/server/features/daily-pulse/DailyPulseService";
import { isPermanentArchiveError } from "@/server/features/search-archive/archiveFetch";
import type { ArchiveFetch } from "@/server/features/search-archive/archivePlan";
import {
  SearchArchiveService,
  type ArchiveJobPayload,
} from "@/server/features/search-archive/SearchArchiveService";
import { describeError } from "@/server/lib/errors";
import { Ga4ReportError } from "@/server/lib/ga4Errors";
import { pgStep } from "./pgStep";

// Google calls are free but rate limited: one month of one source per step,
// one step at a time. A quota error retries the step after a pause; a step
// that still fails ends the run, and the next run resumes from the months
// already recorded.
const FETCH_STEP = {
  retries: {
    limit: 4,
    delay: "2 minutes" as const,
    backoff: "exponential" as const,
  },
  timeout: "10 minutes" as const,
};

/** How often one month may wait out GA4's quota before the run fails. */
const MAX_QUOTA_WAITS = 3;
/** The longest single pause; GA4's hourly quota refills within it. */
const MAX_PAUSE_SECONDS = 60 * 60;

/** The plain message for the status note, without the engine's prefixes. */
const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^(Error: )?(NonRetryableError: )?/,
    "",
  );

type MonthOutcome = { rows: number; pauseSeconds: number; quotaWait: boolean };

/** One month of one source as a step: fetched, or a quota wait to sleep out. */
function fetchStep(
  step: WorkflowStep,
  payload: ArchiveJobPayload,
  fetch: ArchiveFetch,
  wait: number,
  rowsBefore: number,
): Promise<MonthOutcome> {
  const name = `${fetch.source}-${fetch.month}`;
  return pgStep(
    step,
    wait === 0 ? name : `${name}-after-quota-${wait}`,
    FETCH_STEP,
    async () => {
      try {
        const result = await SearchArchiveService.fetchPeriod(
          payload.projectId,
          fetch,
        );
        await SearchArchiveService.recordProgress(
          payload.projectId,
          payload.runId,
          rowsBefore + result.rows,
        );
        return { ...result, quotaWait: false };
      } catch (error) {
        // GA4 says how long its quota needs; wait that out between steps
        // instead of burning the step's retries.
        if (
          error instanceof Ga4ReportError &&
          error.code === "ga4_quota_exhausted" &&
          wait < MAX_QUOTA_WAITS
        ) {
          return {
            rows: 0,
            // A missing or zero Retry-After gets the full hour.
            pauseSeconds: error.retryAfterSeconds || MAX_PAUSE_SECONDS,
            quotaWait: true,
          };
        }
        // A revoked grant or lost property fails the run at once instead of
        // waiting out the retries.
        throw isPermanentArchiveError(error)
          ? new NonRetryableError(errorMessage(error))
          : error;
      }
    },
  );
}

/**
 * One archive run: plans the months, fetches them one step each, and records
 * the outcome on the run. The SearchArchiveWorkflow body, kept apart so its
 * retry and replay behaviour is testable with a plain step.
 *
 * Only step failures fail the run. Sleeps stay outside the error handling:
 * the engine interrupts an invocation idling in a long sleep and resumes it
 * on wake, and that interrupt must reach the engine untouched rather than
 * mark a healthy run failed.
 */
export async function runSearchArchive(
  payload: ArchiveJobPayload,
  step: WorkflowStep,
) {
  const { projectId, runId, mode } = payload;
  let rowsWritten = 0;
  const fail = async (error: unknown): Promise<never> => {
    console.error(
      `[search-archive] run ${runId} failed: ${describeError(error)}`,
      error,
    );
    await pgStep(step, "fail", undefined, () =>
      SearchArchiveService.finishRun(projectId, runId, {
        ok: false,
        rowsWritten,
        note: errorMessage(error),
      }),
    );
    throw error;
  };

  let planned: Awaited<ReturnType<typeof SearchArchiveService.plan>>;
  try {
    planned = await pgStep(step, "plan", undefined, () =>
      SearchArchiveService.plan(projectId, mode),
    );
  } catch (error) {
    return fail(error);
  }
  for (const fetch of planned.fetches) {
    for (let wait = 0; ; wait++) {
      let outcome: MonthOutcome;
      try {
        outcome = await fetchStep(step, payload, fetch, wait, rowsWritten);
      } catch (error) {
        return fail(error);
      }
      rowsWritten += outcome.rows;
      if (outcome.pauseSeconds > 0) {
        await step.sleep(
          `${fetch.source}-${fetch.month}-pause-${wait}`,
          Math.min(outcome.pauseSeconds, MAX_PAUSE_SECONDS) * 1000,
        );
      }
      if (!outcome.quotaWait) break;
    }
  }
  try {
    await pgStep(step, "finish", undefined, () =>
      SearchArchiveService.finishRun(projectId, runId, {
        ok: true,
        rowsWritten,
        note: planned.notes.length > 0 ? planned.notes.join(" ") : null,
      }),
    );
  } catch (error) {
    return fail(error);
  }
  // The archive is fresh: write the daily pulse's alerts to the project's
  // tasks. It only reads the archive, and a failure leaves the run completed.
  try {
    const pulse = await pgStep(step, "pulse", undefined, () =>
      DailyPulseService.recordAlerts(projectId),
    );
    console.log({ event: "daily_pulse_recorded", projectId, ...pulse });
  } catch (error) {
    console.error(
      `[search-archive] run ${runId}: daily pulse failed: ${describeError(error)}`,
      error,
    );
  }
}
