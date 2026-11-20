import { env } from "cloudflare:workers";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { ga4DateInTimeZone } from "@/server/features/ga4/services/Ga4Dates";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import { AppError, describeError } from "@/server/lib/errors";
import {
  isWorkflowActive,
  readWorkflowStatus,
  startWorkflow,
  STUCK_RUN_AFTER_MS,
  terminateStuckWorkflow,
} from "@/server/lib/startWorkflow";
import {
  GSC_TIME_ZONE,
  planDailyFetches,
  planMonthlyFetches,
  type ArchiveFetch,
  type ArchiveMode,
} from "./archivePlan";
import { fetchPeriod } from "./archiveFetch";
import { SearchArchiveReadRepository } from "./SearchArchiveReadRepository";
import { SearchArchiveRepository } from "./SearchArchiveRepository";

// The search archive job: copies a project's Search Console and Google
// Analytics history into our own tables before Google drops it. This module
// plans and tracks runs and reads the archive; archiveFetch.ts fetches.

const STARTUP_GRACE_MS = 60_000;
/**
 * How long a run whose workflow still reports itself active may go on. A
 * backfill that waits out GA4's quota month after month can pass the usual
 * 12-hour stuck limit while healthy.
 */
const ACTIVE_RUN_LIMIT_MS = 48 * 60 * 60_000;

export type ArchiveJobPayload = {
  projectId: string;
  runId: string;
  mode: ArchiveMode;
};

/** The fetches a run makes, oldest month first, and the sources it skips. */
async function plan(
  projectId: string,
  mode: ArchiveMode,
  now: Date = new Date(),
): Promise<{ fetches: ArchiveFetch[]; notes: string[] }> {
  const [gsc, ga4] = await Promise.all([
    GscConnectionRepository.getByProjectId(projectId),
    Ga4ConnectionRepository.getByProjectId(projectId),
  ]);
  const notes: string[] = [];
  const fetches: ArchiveFetch[] = [];
  if (gsc) {
    const today = ga4DateInTimeZone(now, GSC_TIME_ZONE);
    for (const source of ["gsc_site", "gsc_page"] as const) {
      fetches.push(
        ...planDailyFetches({
          source,
          mode,
          today,
          timeZone: GSC_TIME_ZONE,
          periods: await SearchArchiveRepository.listPeriods(projectId, source),
        }),
      );
    }
    fetches.push(
      ...planMonthlyFetches({
        mode,
        today,
        periods: await SearchArchiveRepository.listPeriods(
          projectId,
          "gsc_query_page",
        ),
      }),
    );
  } else {
    notes.push("Search Console is not connected; skipped.");
  }
  if (ga4) {
    const today = ga4DateInTimeZone(now, ga4.propertyTimeZone);
    for (const source of ["ga4_site", "ga4_page"] as const) {
      fetches.push(
        ...planDailyFetches({
          source,
          mode,
          today,
          timeZone: ga4.propertyTimeZone,
          periods: await SearchArchiveRepository.listPeriods(projectId, source),
        }),
      );
    }
  } else {
    notes.push("Google Analytics is not connected; skipped.");
  }
  // Oldest month first across sources: those days leave Google soonest.
  fetches.sort((a, b) => a.month.localeCompare(b.month));
  return { fetches, notes };
}

type Run = NonNullable<
  Awaited<ReturnType<typeof SearchArchiveRepository.getRun>>
>;

/** Whether the project's last run is still going. */
async function isRunActive(run: Run) {
  if (run.status !== "running") return false;
  const ageMs = Date.now() - Date.parse(run.startedAt);
  const status = await readWorkflowStatus(
    env.SEARCH_ARCHIVE_WORKFLOW,
    run.runId,
  );
  // A failed lookup says nothing about the workflow.
  if (status === null) return ageMs < STUCK_RUN_AFTER_MS;
  if (status === "missing") return ageMs < STARTUP_GRACE_MS;
  if (!isWorkflowActive(status)) return false;
  // A run waiting out GA4's quota sleeps for hours, so a live workflow gets
  // far longer than the usual stuck limit before it counts as stuck.
  return ageMs < ACTIVE_RUN_LIMIT_MS;
}

/**
 * A run still marked running whose workflow stopped, or that has run past
 * its limit: its workflow is terminated, so it can write no more,
 * and the run is marked failed. Returns the run as it now stands.
 */
async function settleDeadRun(projectId: string, run: Run): Promise<Run> {
  if (run.status !== "running" || (await isRunActive(run))) return run;
  await terminateStuckWorkflow(env.SEARCH_ARCHIVE_WORKFLOW, run.runId);
  const note = "The run stopped without finishing.";
  const finishedAt = new Date().toISOString();
  await SearchArchiveRepository.updateRun(projectId, run.runId, {
    status: "failed",
    finishedAt,
    note,
  });
  return { ...run, status: "failed", finishedAt, note };
}

/**
 * Starts an archive run for the project unless one is already going. Backfill
 * covers Google's whole 16 months; incremental the latest three months. Both
 * skip months already complete, so a backfill after a failed one resumes.
 */
async function start(projectId: string, mode: ArchiveMode) {
  const [gsc, ga4] = await Promise.all([
    GscConnectionRepository.getByProjectId(projectId),
    Ga4ConnectionRepository.getByProjectId(projectId),
  ]);
  if (!gsc && !ga4) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Connect Search Console or Google Analytics to this project first.",
    );
  }
  const existing = await SearchArchiveRepository.getRun(projectId);
  const current = existing && (await settleDeadRun(projectId, existing));
  if (current?.status === "running") return { started: false, run: current };

  const runId = crypto.randomUUID();
  // Conditional on the row the check above saw: of two starts racing, one
  // claims the slot and the other reports the run already going.
  const claimed = await SearchArchiveRepository.claimRun(
    { projectId, runId, mode, startedAt: new Date().toISOString() },
    current?.runId ?? null,
  );
  if (!claimed) {
    return {
      started: false,
      run: await SearchArchiveRepository.getRun(projectId),
    };
  }
  try {
    await startWorkflow(
      env.SEARCH_ARCHIVE_WORKFLOW,
      { id: runId, params: { projectId, runId, mode } },
      "search-archive",
    );
  } catch (error) {
    await finishRun(projectId, runId, {
      ok: false,
      note: `Could not start: ${describeError(error)}`,
    });
    throw new AppError("UPSTREAM_UNAVAILABLE", "Could not start the archive.");
  }
  return {
    started: true,
    run: await SearchArchiveRepository.getRun(projectId),
  };
}

async function finishRun(
  projectId: string,
  runId: string,
  result: { ok: boolean; rowsWritten?: number; note: string | null },
) {
  await SearchArchiveRepository.updateRun(projectId, runId, {
    status: result.ok ? "completed" : "failed",
    finishedAt: new Date().toISOString(),
    ...(result.rowsWritten === undefined
      ? {}
      : { rowsWritten: result.rowsWritten }),
    note: result.note,
  });
}

async function recordProgress(
  projectId: string,
  runId: string,
  rowsWritten: number,
) {
  await SearchArchiveRepository.updateRun(projectId, runId, { rowsWritten });
}

/** The latest run and what the archive holds, per source. */
async function getStatus(projectId: string) {
  const [latest, scanned, gsc, ga4] = await Promise.all([
    SearchArchiveRepository.getRun(projectId),
    SearchArchiveRepository.coverage(projectId),
    GscConnectionRepository.getByProjectId(projectId),
    Ga4ConnectionRepository.getByProjectId(projectId),
  ]);
  // A run whose workflow died would otherwise read "running" forever and
  // keep the archive button locked.
  const run = latest && (await settleDeadRun(projectId, latest));
  // A scanned month can be empty (the site had no data yet), so each source
  // also says which dates actually hold rows; null when none do. For
  // gsc_query_page they are months (YYYY-MM).
  const coverage = await Promise.all(
    scanned.map(async (row) => {
      const data = await SearchArchiveReadRepository.dataRange(
        projectId,
        row.source,
      );
      return { ...row, firstDataDate: data.first, lastDataDate: data.last };
    }),
  );
  return {
    run,
    coverage,
    connected: { gsc: Boolean(gsc), ga4: Boolean(ga4) },
  };
}

export const ARCHIVE_DATASETS = [
  "gsc_site",
  "gsc_pages",
  "gsc_query_pages",
  "ga4_site",
  "ga4_pages",
] as const;

/** Reads one archived dataset over a date range. */
async function readArchive(params: {
  projectId: string;
  dataset: (typeof ARCHIVE_DATASETS)[number];
  startDate: string;
  endDate: string;
  page?: string;
  query?: string;
  byDevice?: boolean;
  limit: number;
  offset: number;
}): Promise<Array<Record<string, string | number | null>>> {
  const { projectId, startDate, endDate, limit, offset } = params;
  switch (params.dataset) {
    case "gsc_site":
      return SearchArchiveReadRepository.readGscSite(
        projectId,
        { startDate, endDate, limit, offset },
        params.byDevice ?? false,
      );
    case "gsc_pages":
      return SearchArchiveReadRepository.readGscPages(
        projectId,
        { startDate, endDate, limit, offset },
        params.page,
      );
    case "gsc_query_pages":
      return SearchArchiveReadRepository.readGscQueryPages(
        projectId,
        {
          startMonth: startDate.slice(0, 7),
          endMonth: endDate.slice(0, 7),
          limit,
          offset,
        },
        { page: params.page, query: params.query },
      );
    case "ga4_site":
      return SearchArchiveReadRepository.readGa4Site(projectId, {
        startDate,
        endDate,
        limit,
        offset,
      });
    case "ga4_pages":
      return SearchArchiveReadRepository.readGa4Pages(
        projectId,
        { startDate, endDate, limit, offset },
        params.page,
      );
  }
}

export const SearchArchiveService = {
  readArchive,
  plan,
  fetchPeriod,
  start,
  finishRun,
  recordProgress,
  getStatus,
};
