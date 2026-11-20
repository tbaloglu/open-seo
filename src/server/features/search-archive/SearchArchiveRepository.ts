import { and, eq, gte, lte, max, min, ne, or, sql } from "drizzle-orm";
import { omit } from "remeda";
import { db } from "@/db";
import { getDatabaseProvider } from "@/db/provider";
import {
  ga4DailyPage,
  ga4DailySite,
  gscDailyPage,
  gscDailySite,
  gscMonthlyQueryPage,
  searchArchivePeriods,
  searchArchiveRuns,
} from "@/db/schema";
import { DB_BATCH_SIZE, runBatch } from "@/db/runBatch";
import type { ArchiveMode, ArchiveSource } from "./archivePlan";

// Writes and job bookkeeping of the search archive, keyed by project_id. The
// archive job runs in a Workflow started for an already-authorized project.

type GscMetricsRow = {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

/** Days (or, for monthly rows, months) a fetch covers, inclusive. */
type Window = { from: string; to: string };

type BatchExecutor = Parameters<Parameters<typeof runBatch>[0]>[0];

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Upserts rows in batches. D1 binds at most 100 parameters per statement;
 * Postgres takes far more, so it gets 1,000 rows per statement. With `clear`,
 * the window's old rows are deleted in the same atomic batch as the first
 * rows, so rows Google no longer reports disappear. Every batch is safe to
 * repeat: a retried fetch clears the window again and rewrites it.
 */
async function writeRows<T>(
  rows: T[],
  columnsPerRow: number,
  build: (tx: BatchExecutor, rows: T[]) => Promise<unknown>,
  clear?: (tx: BatchExecutor) => Promise<unknown>,
) {
  const perStatement =
    getDatabaseProvider() === "postgres"
      ? 1_000
      : // A few parameters short of D1's 100, as a margin.
        Math.floor(96 / columnsPerRow);
  const groups = chunk(chunk(rows, perStatement), DB_BATCH_SIZE - 1);
  if (groups.length === 0 && clear) {
    await runBatch((tx) => [clear(tx)]);
    return;
  }
  for (const [index, group] of groups.entries()) {
    await runBatch((tx) => [
      ...(index === 0 && clear ? [clear(tx)] : []),
      ...group.map((part) => build(tx, part)),
    ]);
  }
}

const excludedMetrics = {
  clicks: sql`excluded.clicks`,
  impressions: sql`excluded.impressions`,
  ctr: sql`excluded.ctr`,
  position: sql`excluded.position`,
};

async function upsertGscDailySite(
  projectId: string,
  rows: Array<GscMetricsRow & { date: string; device: string }>,
  clear?: Window,
) {
  await writeRows(
    rows,
    7,
    (tx, part) =>
      tx
        .insert(gscDailySite)
        .values(part.map((row) => ({ projectId, ...row })))
        .onConflictDoUpdate({
          target: [
            gscDailySite.projectId,
            gscDailySite.date,
            gscDailySite.device,
          ],
          set: excludedMetrics,
        }),
    clear &&
      ((tx) =>
        tx
          .delete(gscDailySite)
          .where(
            and(
              eq(gscDailySite.projectId, projectId),
              gte(gscDailySite.date, clear.from),
              lte(gscDailySite.date, clear.to),
            ),
          )),
  );
}

async function upsertGscDailyPage(
  projectId: string,
  rows: Array<GscMetricsRow & { date: string; page: string }>,
  clear?: Window,
) {
  await writeRows(
    rows,
    7,
    (tx, part) =>
      tx
        .insert(gscDailyPage)
        .values(part.map((row) => ({ projectId, ...row })))
        .onConflictDoUpdate({
          target: [
            gscDailyPage.projectId,
            gscDailyPage.date,
            gscDailyPage.page,
          ],
          set: excludedMetrics,
        }),
    clear &&
      ((tx) =>
        tx
          .delete(gscDailyPage)
          .where(
            and(
              eq(gscDailyPage.projectId, projectId),
              gte(gscDailyPage.date, clear.from),
              lte(gscDailyPage.date, clear.to),
            ),
          )),
  );
}

async function upsertGscMonthlyQueryPage(
  projectId: string,
  rows: Array<GscMetricsRow & { month: string; query: string; page: string }>,
  clear?: Window,
) {
  await writeRows(
    rows,
    8,
    (tx, part) =>
      tx
        .insert(gscMonthlyQueryPage)
        .values(part.map((row) => ({ projectId, ...row })))
        .onConflictDoUpdate({
          target: [
            gscMonthlyQueryPage.projectId,
            gscMonthlyQueryPage.month,
            gscMonthlyQueryPage.query,
            gscMonthlyQueryPage.page,
          ],
          set: excludedMetrics,
        }),
    clear &&
      ((tx) =>
        tx
          .delete(gscMonthlyQueryPage)
          .where(
            and(
              eq(gscMonthlyQueryPage.projectId, projectId),
              gte(gscMonthlyQueryPage.month, clear.from),
              lte(gscMonthlyQueryPage.month, clear.to),
            ),
          )),
  );
}

async function upsertGa4DailySite(
  projectId: string,
  rows: Array<{
    date: string;
    sessions: number;
    organicSessions: number;
    keyEvents: number;
    organicKeyEvents: number;
  }>,
  clear?: Window,
) {
  await writeRows(
    rows,
    6,
    (tx, part) =>
      tx
        .insert(ga4DailySite)
        .values(part.map((row) => ({ projectId, ...row })))
        .onConflictDoUpdate({
          target: [ga4DailySite.projectId, ga4DailySite.date],
          set: {
            sessions: sql`excluded.sessions`,
            organicSessions: sql`excluded.organic_sessions`,
            keyEvents: sql`excluded.key_events`,
            organicKeyEvents: sql`excluded.organic_key_events`,
          },
        }),
    clear &&
      ((tx) =>
        tx
          .delete(ga4DailySite)
          .where(
            and(
              eq(ga4DailySite.projectId, projectId),
              gte(ga4DailySite.date, clear.from),
              lte(ga4DailySite.date, clear.to),
            ),
          )),
  );
}

async function upsertGa4DailyPage(
  projectId: string,
  rows: Array<{ date: string; pagePath: string; organicSessions: number }>,
  clear?: Window,
) {
  await writeRows(
    rows,
    4,
    (tx, part) =>
      tx
        .insert(ga4DailyPage)
        .values(part.map((row) => ({ projectId, ...row })))
        .onConflictDoUpdate({
          target: [
            ga4DailyPage.projectId,
            ga4DailyPage.date,
            ga4DailyPage.pagePath,
          ],
          set: { organicSessions: sql`excluded.organic_sessions` },
        }),
    clear &&
      ((tx) =>
        tx
          .delete(ga4DailyPage)
          .where(
            and(
              eq(ga4DailyPage.projectId, projectId),
              gte(ga4DailyPage.date, clear.from),
              lte(ga4DailyPage.date, clear.to),
            ),
          )),
  );
}

// ----------------------------------------------------------- job bookkeeping

async function listPeriods(projectId: string, source: ArchiveSource) {
  return db
    .select({
      month: searchArchivePeriods.month,
      fetchedThrough: searchArchivePeriods.fetchedThrough,
      complete: searchArchivePeriods.complete,
      fetchedAt: searchArchivePeriods.fetchedAt,
    })
    .from(searchArchivePeriods)
    .where(
      and(
        eq(searchArchivePeriods.projectId, projectId),
        eq(searchArchivePeriods.source, source),
      ),
    );
}

async function recordPeriod(row: typeof searchArchivePeriods.$inferInsert) {
  await db
    .insert(searchArchivePeriods)
    .values(row)
    .onConflictDoUpdate({
      target: [
        searchArchivePeriods.projectId,
        searchArchivePeriods.source,
        searchArchivePeriods.month,
      ],
      set: {
        fetchedThrough: row.fetchedThrough,
        complete: row.complete,
        rowCount: row.rowCount,
        fetchedAt: row.fetchedAt,
      },
    });
}

/** Per source: the archived months' range and the last fetch. */
async function coverage(projectId: string) {
  return db
    .select({
      source: searchArchivePeriods.source,
      firstMonth: min(searchArchivePeriods.month),
      lastDate: max(searchArchivePeriods.fetchedThrough),
      lastFetchedAt: max(searchArchivePeriods.fetchedAt),
    })
    .from(searchArchivePeriods)
    .where(eq(searchArchivePeriods.projectId, projectId))
    .groupBy(searchArchivePeriods.source);
}

async function getRun(projectId: string) {
  const [row] = await db
    .select()
    .from(searchArchiveRuns)
    .where(eq(searchArchiveRuns.projectId, projectId))
    .limit(1);
  return row ?? null;
}

/**
 * Makes this run the project's running run, unless another one is running.
 * The condition is in the write itself, so of two starts racing only one
 * claims the slot. `replacing` is the stopped run the caller saw still marked
 * running; only that run, not a newer one, may be taken over.
 */
async function claimRun(
  row: {
    projectId: string;
    runId: string;
    mode: ArchiveMode;
    startedAt: string;
  },
  replacing: string | null,
): Promise<boolean> {
  const values = {
    ...row,
    status: "running" as const,
    finishedAt: null,
    rowsWritten: 0,
    note: null,
  };
  const claimed = await db
    .insert(searchArchiveRuns)
    .values(values)
    .onConflictDoUpdate({
      target: searchArchiveRuns.projectId,
      set: omit(values, ["projectId"]),
      setWhere: replacing
        ? or(
            ne(searchArchiveRuns.status, "running"),
            eq(searchArchiveRuns.runId, replacing),
          )
        : ne(searchArchiveRuns.status, "running"),
    })
    .returning({ runId: searchArchiveRuns.runId });
  return claimed.length > 0;
}

/** Updates the run only while it is still the project's latest run. */
async function updateRun(
  projectId: string,
  runId: string,
  fields: Partial<
    Pick<
      typeof searchArchiveRuns.$inferInsert,
      "status" | "finishedAt" | "rowsWritten" | "note"
    >
  >,
) {
  await db
    .update(searchArchiveRuns)
    .set(fields)
    .where(
      and(
        eq(searchArchiveRuns.projectId, projectId),
        eq(searchArchiveRuns.runId, runId),
      ),
    );
}

export const SearchArchiveRepository = {
  upsertGscDailySite,
  upsertGscDailyPage,
  upsertGscMonthlyQueryPage,
  upsertGa4DailySite,
  upsertGa4DailyPage,
  listPeriods,
  recordPeriod,
  coverage,
  getRun,
  claimRun,
  updateRun,
};
