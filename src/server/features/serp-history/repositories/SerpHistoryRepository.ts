import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  rankCheckRuns,
  rankSnapshots,
  serpSnapshotFeatures,
  serpSnapshotResults,
} from "@/db/schema";
import { runBatch } from "@/db/runBatch";

type Device = "desktop" | "mobile";

export type SerpPageRows = {
  trackingKeywordId: string;
  device: Device;
  results: Array<{
    rank: number;
    domain: string | null;
    url: string | null;
    title: string | null;
  }>;
  features: Array<{
    featureType: string;
    sortOrder: number;
    value: string | null;
    domain: string | null;
  }>;
};

// D1 binds at most 100 parameters per statement and both tables have 7
// columns, so one insert carries at most 14 rows.
const ROWS_PER_INSERT = 14;
// A page is at most ~6 statements, so this keeps a batch well under 100.
const PAGES_PER_BATCH = 10;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function pairFilter(
  table: typeof serpSnapshotResults | typeof serpSnapshotFeatures,
  runId: string,
  pair: { trackingKeywordId: string; device: Device },
) {
  return and(
    eq(table.runId, runId),
    eq(table.trackingKeywordId, pair.trackingKeywordId),
    eq(table.device, pair.device),
  );
}

/**
 * Replace the saved page of each keyword/device pair in the run. Each batch
 * deletes and inserts together, so a pair never shows half of two reads.
 */
async function replacePages(runId: string, pages: SerpPageRows[]) {
  for (const group of chunk(pages, PAGES_PER_BATCH)) {
    await runBatch((tx) =>
      group.flatMap((page) => {
        const key = {
          runId,
          trackingKeywordId: page.trackingKeywordId,
          device: page.device,
        };
        return [
          tx
            .delete(serpSnapshotResults)
            .where(pairFilter(serpSnapshotResults, runId, page)),
          tx
            .delete(serpSnapshotFeatures)
            .where(pairFilter(serpSnapshotFeatures, runId, page)),
          ...chunk(page.results, ROWS_PER_INSERT).map((rows) =>
            tx
              .insert(serpSnapshotResults)
              .values(rows.map((row) => ({ ...key, ...row }))),
          ),
          ...chunk(page.features, ROWS_PER_INSERT).map((rows) =>
            tx
              .insert(serpSnapshotFeatures)
              .values(rows.map((row) => ({ ...key, ...row }))),
          ),
        ];
      }),
    );
  }
}

async function deletePages(
  runId: string,
  pairs: Array<{ trackingKeywordId: string; device: Device }>,
) {
  for (const group of chunk(pairs, PAGES_PER_BATCH * 4)) {
    await runBatch((tx) =>
      group.flatMap((pair) => [
        tx
          .delete(serpSnapshotResults)
          .where(pairFilter(serpSnapshotResults, runId, pair)),
        tx
          .delete(serpSnapshotFeatures)
          .where(pairFilter(serpSnapshotFeatures, runId, pair)),
      ]),
    );
  }
}

/** The run's saved rank snapshots: which pairs have a result, and where. */
async function getSnapshotPositions(runId: string) {
  return db
    .select({
      trackingKeywordId: rankSnapshots.trackingKeywordId,
      device: rankSnapshots.device,
      position: rankSnapshots.position,
    })
    .from(rankSnapshots)
    .where(eq(rankSnapshots.runId, runId));
}

/** A config's completed full runs, newest first. */
async function getCompletedRuns(configId: string) {
  return db
    .select({ id: rankCheckRuns.id, startedAt: rankCheckRuns.startedAt })
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.configId, configId),
        eq(rankCheckRuns.status, "completed"),
        eq(rankCheckRuns.isSubsetRun, false),
      ),
    )
    .orderBy(desc(rankCheckRuns.startedAt));
}

/** One keyword's latest completed checks on a device, newest first. */
async function getKeywordChecks(input: {
  configId: string;
  trackingKeywordId: string;
  device: Device;
  limit: number;
}) {
  return db
    .select({
      runId: rankCheckRuns.id,
      startedAt: rankCheckRuns.startedAt,
      position: rankSnapshots.position,
    })
    .from(rankSnapshots)
    .innerJoin(rankCheckRuns, eq(rankSnapshots.runId, rankCheckRuns.id))
    .where(
      and(
        eq(rankCheckRuns.configId, input.configId),
        eq(rankCheckRuns.status, "completed"),
        eq(rankSnapshots.trackingKeywordId, input.trackingKeywordId),
        eq(rankSnapshots.device, input.device),
      ),
    )
    .orderBy(desc(rankCheckRuns.startedAt))
    .limit(input.limit);
}

/** Rank snapshots of the runs on one device. */
async function getSnapshots(runIds: string[], device: Device) {
  if (runIds.length === 0) return [];
  return db
    .select({
      runId: rankSnapshots.runId,
      trackingKeywordId: rankSnapshots.trackingKeywordId,
      keyword: rankSnapshots.keyword,
      position: rankSnapshots.position,
    })
    .from(rankSnapshots)
    .where(
      and(
        inArray(rankSnapshots.runId, runIds),
        eq(rankSnapshots.device, device),
      ),
    );
}

/** Saved pages of the runs on one device, optionally for one keyword. */
async function getPages(input: {
  runIds: string[];
  device: Device;
  trackingKeywordId?: string;
}) {
  if (input.runIds.length === 0) return { results: [], features: [] };
  const scope = <
    T extends typeof serpSnapshotResults | typeof serpSnapshotFeatures,
  >(
    table: T,
  ) =>
    and(
      inArray(table.runId, input.runIds),
      eq(table.device, input.device),
      input.trackingKeywordId
        ? eq(table.trackingKeywordId, input.trackingKeywordId)
        : undefined,
    );
  const [results, features] = await Promise.all([
    db
      .select()
      .from(serpSnapshotResults)
      .where(scope(serpSnapshotResults))
      .orderBy(asc(serpSnapshotResults.rank)),
    db
      .select()
      .from(serpSnapshotFeatures)
      .where(scope(serpSnapshotFeatures))
      .orderBy(
        asc(serpSnapshotFeatures.featureType),
        asc(serpSnapshotFeatures.sortOrder),
      ),
  ]);
  return { results, features };
}

export const SerpHistoryRepository = {
  replacePages,
  deletePages,
  getSnapshotPositions,
  getCompletedRuns,
  getKeywordChecks,
  getSnapshots,
  getPages,
};
