import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  SearchArchiveService,
  type ArchiveJobPayload,
} from "@/server/features/search-archive/SearchArchiveService";
import { describeError } from "@/server/lib/errors";
import { pgStep } from "./pgStep";
import { yieldingStep } from "./yieldingStep";

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

/**
 * Copies a project's Search Console and Google Analytics history into the
 * archive tables. Started by SearchArchiveService.start for a project the
 * caller was authorized for; the payload's project is trusted from there.
 */
export class SearchArchiveWorkflow extends WorkflowEntrypoint<
  Env,
  ArchiveJobPayload
> {
  async run(event: WorkflowEvent<ArchiveJobPayload>, engineStep: WorkflowStep) {
    const step = yieldingStep(engineStep);
    const { projectId, runId, mode } = event.payload;
    let rowsWritten = 0;
    try {
      const { fetches, notes } = await pgStep(step, "plan", undefined, () =>
        SearchArchiveService.plan(projectId, mode),
      );
      for (const fetch of fetches) {
        const before = rowsWritten;
        rowsWritten += await pgStep(
          step,
          `${fetch.source}-${fetch.month}`,
          FETCH_STEP,
          async () => {
            const rows = await SearchArchiveService.fetchPeriod(
              projectId,
              fetch,
            );
            await SearchArchiveService.recordProgress(
              projectId,
              runId,
              before + rows,
            );
            return rows;
          },
        );
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
          note: describeError(error),
        }),
      );
    }
  }
}
