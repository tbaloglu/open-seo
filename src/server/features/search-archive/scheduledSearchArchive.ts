import { AppError, describeError } from "@/server/lib/errors";
import { STUCK_RUN_AFTER_MS } from "@/server/lib/startWorkflow";
import { SearchArchiveScheduleRepository } from "./SearchArchiveScheduleRepository";
import {
  ACTIVE_RUN_LIMIT_MS,
  SearchArchiveService,
} from "./SearchArchiveService";

// The daily archive: once a day, an archive run for every project with Search
// Console or Analytics connected: a backfill (16 months) the first time, an
// incremental run (the latest three months) after that. It runs from the
// every-5-minutes cron tick (server.ts `scheduled`, the same handler on
// Cloudflare and in the standalone celld image) and keeps only a few runs
// going at once, so Google's quotas are not crowded. Each run ends with the
// daily pulse (searchArchiveRun.ts).

/** Runs start from this hour of the day, Istanbul time, onwards. */
const DAILY_ARCHIVE_HOUR = 6;
const DAILY_ARCHIVE_TIME_ZONE = "Europe/Istanbul";
/** Runs going at once, across all projects. */
const MAX_ACTIVE_RUNS = 3;
/** Of those, backfills (hours of GA4 quota each) at most. */
const MAX_ACTIVE_BACKFILLS = 2;
/** A run that completed this recently counts as today's. */
const FRESH_FOR_MS = 20 * 60 * 60_000;
/** A failed run is tried again after this long, not every tick. */
const FAILED_RETRY_AFTER_MS = 6 * 60 * 60_000;
/** Candidates read per tick; more than the free slots, as some may fail. */
const CANDIDATES_PER_TICK = 20;
/** Runs marked running past the usual stuck limit, checked per tick. */
const STALE_RUNS_PER_TICK = 10;
/**
 * Wall-clock guard for the loop, like the rank scheduler's: stopping early is
 * safe, the projects left stay due for the next tick.
 */
const TICK_DEADLINE_MS = 60_000;

function hourIn(now: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  );
}

/**
 * Settles runs whose workflow died: such a run stays "running" in the table
 * and would hold its project (and a slot) for up to 48 hours. Long healthy
 * runs are only read, never started again.
 */
async function settleStaleRuns(now: Date) {
  let settled = 0;
  const stale = await SearchArchiveScheduleRepository.listStaleRunning(
    new Date(now.getTime() - STUCK_RUN_AFTER_MS).toISOString(),
    STALE_RUNS_PER_TICK,
  );
  for (const projectId of stale) {
    try {
      if (!(await SearchArchiveService.settle(projectId))) settled++;
    } catch (error) {
      console.error(
        `[cron] Could not check archive run of project ${projectId}: ${describeError(error)}`,
        error,
      );
    }
  }
  return settled;
}

/** Cron body: start today's archive runs while slots are free. */
export async function runScheduledSearchArchive() {
  const now = new Date();
  if (hourIn(now, DAILY_ARCHIVE_TIME_ZONE) < DAILY_ARCHIVE_HOUR) return;
  const deadline = Date.now() + TICK_DEADLINE_MS;

  const settled = await settleStaleRuns(now);
  const running = await SearchArchiveScheduleRepository.countRunning(
    new Date(now.getTime() - ACTIVE_RUN_LIMIT_MS).toISOString(),
  );
  let active = running.backfill + running.incremental;
  let activeBackfills = running.backfill;
  if (active >= MAX_ACTIVE_RUNS) return;

  const candidates =
    await SearchArchiveScheduleRepository.listScheduleCandidates({
      completedBefore: new Date(now.getTime() - FRESH_FOR_MS).toISOString(),
      failedBefore: new Date(
        now.getTime() - FAILED_RETRY_AFTER_MS,
      ).toISOString(),
      limit: CANDIDATES_PER_TICK,
    });

  let started = 0;
  let waitingForBackfillSlot = 0;
  let alreadyRunning = 0;
  let errors = 0;
  let stoppedByDeadline = false;
  for (const { projectId, lastMode, lastStatus } of candidates) {
    if (active >= MAX_ACTIVE_RUNS) break;
    if (Date.now() >= deadline) {
      stoppedByDeadline = true;
      break;
    }
    // A project's first run copies everything Google still has; a failed
    // backfill is resumed as one (it skips the months already complete).
    // After that, the latest three months a day are enough.
    const mode =
      lastMode === null ||
      (lastMode === "backfill" && lastStatus !== "completed")
        ? "backfill"
        : "incremental";
    if (mode === "backfill" && activeBackfills >= MAX_ACTIVE_BACKFILLS) {
      waitingForBackfillSlot++;
      continue;
    }
    try {
      const result = await SearchArchiveService.start(projectId, mode);
      if (result.started) {
        started++;
        active++;
        if (mode === "backfill") activeBackfills++;
      } else {
        alreadyRunning++;
      }
    } catch (error) {
      errors++;
      console.error(
        `[cron] Daily archive start failed for project ${projectId}: ${describeError(error)}`,
        error,
      );
      // Nothing connected any more: record it, so the project waits out the
      // failed-run back-off instead of being tried every tick. (A failed
      // workflow start is already recorded by start().)
      if (error instanceof AppError && error.code === "VALIDATION_ERROR") {
        await SearchArchiveService.recordStartFailure(
          projectId,
          mode,
          error.message,
        ).catch((recordError: unknown) => {
          console.error(
            `[cron] Could not record the failed start of project ${projectId}:`,
            recordError,
          );
        });
      }
    }
  }

  if (candidates.length === 0 && settled === 0) return;
  (errors > 0 ? console.error : console.log)({
    event: "search_archive_scheduler_summary",
    candidates: candidates.length,
    started,
    activeBefore: running.backfill + running.incremental,
    maxActiveRuns: MAX_ACTIVE_RUNS,
    waitingForBackfillSlot,
    alreadyRunning,
    settledDeadRuns: settled,
    stoppedByDeadline,
    errors,
  });
}
