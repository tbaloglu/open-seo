import { describeError } from "@/server/lib/errors";
import { STUCK_RUN_AFTER_MS } from "@/server/lib/startWorkflow";
import { SearchArchiveScheduleRepository } from "./SearchArchiveScheduleRepository";
import { SearchArchiveService } from "./SearchArchiveService";

// The daily archive: once a day, an archive run for every project with Search
// Console or Analytics connected: a backfill (16 months) the first time, an
// incremental run (the latest three months) after that. It runs from the every-5-minutes
// cron tick (server.ts `scheduled`, the same handler on Cloudflare and in the
// standalone celld image) and starts a few projects per tick, so 14 sites are
// all started within half an hour without crowding Google's quotas. Each run
// ends with the daily pulse (searchArchiveRun.ts).

/** Runs start from this hour of the day, Istanbul time, onwards. */
const DAILY_ARCHIVE_HOUR = 6;
const DAILY_ARCHIVE_TIME_ZONE = "Europe/Istanbul";
/** Projects started per tick at most; the rest wait for later ticks. */
const MAX_STARTS_PER_TICK = 3;
/** A run that completed this recently counts as today's. */
const FRESH_FOR_MS = 20 * 60 * 60_000;
/** A failed run is tried again after this long, not every tick. */
const FAILED_RETRY_AFTER_MS = 6 * 60 * 60_000;
/** Candidates read per tick; some may turn out to be running already. */
const CANDIDATES_PER_TICK = 20;

function hourIn(now: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  );
}

/** Cron body: start today's incremental archive runs, a few per tick. */
export async function runScheduledSearchArchive() {
  const now = new Date();
  if (hourIn(now, DAILY_ARCHIVE_TIME_ZONE) < DAILY_ARCHIVE_HOUR) return;

  const candidates =
    await SearchArchiveScheduleRepository.listScheduleCandidates({
      completedBefore: new Date(now.getTime() - FRESH_FOR_MS).toISOString(),
      failedBefore: new Date(
        now.getTime() - FAILED_RETRY_AFTER_MS,
      ).toISOString(),
      // A run still marked running this long is checked by start(), which
      // settles it if its workflow died.
      runningBefore: new Date(now.getTime() - STUCK_RUN_AFTER_MS).toISOString(),
      limit: CANDIDATES_PER_TICK,
    });

  let started = 0;
  let alreadyRunning = 0;
  let errors = 0;
  for (const { projectId, lastMode, lastStatus } of candidates) {
    if (started >= MAX_STARTS_PER_TICK) break;
    // A project's first run copies everything Google still has; a failed
    // backfill is resumed as one (it skips the months already complete).
    // After that, the latest three months a day are enough.
    const mode =
      lastMode === null ||
      (lastMode === "backfill" && lastStatus !== "completed")
        ? "backfill"
        : "incremental";
    try {
      const result = await SearchArchiveService.start(projectId, mode);
      if (result.started) started++;
      else alreadyRunning++;
    } catch (error) {
      errors++;
      console.error(
        `[cron] Daily archive start failed for project ${projectId}: ${describeError(error)}`,
        error,
      );
    }
  }

  if (candidates.length === 0) return;
  (errors > 0 ? console.error : console.log)({
    event: "search_archive_scheduler_summary",
    candidates: candidates.length,
    started,
    maxStartsPerTick: MAX_STARTS_PER_TICK,
    alreadyRunning,
    errors,
  });
}
