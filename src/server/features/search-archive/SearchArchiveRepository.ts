import { and, eq, max, min, sql } from "drizzle-orm";
import { db } from "@/db";
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

type BatchExecutor = Parameters<Parameters<typeof runBatch>[0]>[0];

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Upserts rows in D1-safe statements: at most 100 bound parameters each, and
 * at most DB_BATCH_SIZE statements per atomic batch. Each batch is safe on its
 * own, since a re-run writes the same keys again.
 */
async function upsertRows<T>(
  rows: T[],
  columnsPerRow: number,
  build: (tx: BatchExecutor, rows: T[]) => Promise<unknown>,
) {
  const perStatement = Math.floor(100 / columnsPerRow);
  const statements = chunk(rows, perStatement);
  for (const group of chunk(statements, DB_BATCH_SIZE)) {
    await runBatch((tx) => group.map((part) => build(tx, part)));
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
) {
  await upsertRows(rows, 7, (tx, part) =>
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
  );
}

async function upsertGscDailyPage(
  projectId: string,
  rows: Array<GscMetricsRow & { date: string; page: string }>,
) {
  await upsertRows(rows, 7, (tx, part) =>
    tx
      .insert(gscDailyPage)
      .values(part.map((row) => ({ projectId, ...row })))
      .onConflictDoUpdate({
        target: [gscDailyPage.projectId, gscDailyPage.date, gscDailyPage.page],
        set: excludedMetrics,
      }),
  );
}

async function upsertGscMonthlyQueryPage(
  projectId: string,
  rows: Array<GscMetricsRow & { month: string; query: string; page: string }>,
) {
  await upsertRows(rows, 8, (tx, part) =>
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
) {
  await upsertRows(rows, 6, (tx, part) =>
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
  );
}

async function upsertGa4DailyPage(
  projectId: string,
  rows: Array<{ date: string; pagePath: string; organicSessions: number }>,
) {
  await upsertRows(rows, 4, (tx, part) =>
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

async function startRun(row: {
  projectId: string;
  runId: string;
  mode: ArchiveMode;
  startedAt: string;
}) {
  const values = {
    ...row,
    status: "running" as const,
    finishedAt: null,
    rowsWritten: 0,
    note: null,
  };
  await db
    .insert(searchArchiveRuns)
    .values(values)
    .onConflictDoUpdate({ target: searchArchiveRuns.projectId, set: values });
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
  startRun,
  updateRun,
};
