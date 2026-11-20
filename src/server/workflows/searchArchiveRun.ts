import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { isPermanentArchiveError } from "@/server/features/search-archive/archiveFetch";
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
const DEFAULT_QUOTA_WAIT_SECONDS = 60 * 60;

/** The plain message for the status note, without the engine's prefixes. */
const errorMessage = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^(Error: )?(NonRetryableError: )?/,
    "",
  );

/**
 * One archive run: plans the months, fetches them one step each, and records
 * the outcome on the run. The SearchArchiveWorkflow body, kept apart so its
 * retry and replay behaviour is testable with a plain step.
 */
export async function runSearchArchive(
  payload: ArchiveJobPayload,
  step: WorkflowStep,
) {
  const { projectId, runId, mode } = payload;
  let rowsWritten = 0;
  try {
    const { fetches, notes } = await pgStep(step, "plan", undefined, () =>
      SearchArchiveService.plan(projectId, mode),
    );
    for (const fetch of fetches) {
      const name = `${fetch.source}-${fetch.month}`;
      for (let wait = 0; ; wait++) {
        const before = rowsWritten;
        const outcome = await pgStep(
          step,
          wait === 0 ? name : `${name}-after-quota-${wait}`,
          FETCH_STEP,
          async () => {
            try {
              const result = await SearchArchiveService.fetchPeriod(
                projectId,
                fetch,
              );
              await SearchArchiveService.recordProgress(
                projectId,
                runId,
                before + result.rows,
              );
              return { ...result, quotaWait: false };
            } catch (error) {
              // GA4 says how long its quota needs; wait that out between
              // steps instead of burning the step's retries.
              if (
                error instanceof Ga4ReportError &&
                error.code === "ga4_quota_exhausted" &&
                wait < MAX_QUOTA_WAITS
              ) {
                return {
                  rows: 0,
                  pauseSeconds:
                    error.retryAfterSeconds ?? DEFAULT_QUOTA_WAIT_SECONDS,
                  quotaWait: true,
                };
              }
              // A revoked grant or lost property fails the run at once
              // instead of waiting out the retries.
              throw isPermanentArchiveError(error)
                ? new NonRetryableError(errorMessage(error))
                : error;
            }
          },
        );
        rowsWritten += outcome.rows;
        if (outcome.pauseSeconds > 0) {
          await step.sleep(
            `${name}-pause-${wait}`,
            outcome.pauseSeconds * 1000,
          );
        }
        if (!outcome.quotaWait) break;
      }
    }
    await pgStep(step, "finish", undefined, () =>
      SearchArchiveService.finishRun(projectId, runId, {
        ok: true,
        rowsWritten,
        note: notes.length > 0 ? notes.join(" ") : null,
      }),
    );
  } catch (error) {
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
  }
}
