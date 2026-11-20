import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  rankCheckRuns,
  rankSnapshots,
  serpSnapshotFeatures,
  serpSnapshotResults,
} from "@/db/schema";
import { DB_BATCH_SIZE, runBatch } from "@/db/runBatch";

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
// Statements per batch, like executeInBatches. A page's statements always go
// in the same batch, so it closes once the next page would pass this.
const STATEMENTS_PER_BATCH = DB_BATCH_SIZE;
// Completed checks a comparison looks through: years of daily checks.
const MAX_RUNS = 1000;

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

type BatchExecutor = Parameters<Parameters<typeof runBatch>[0]>[0];

/** Clears one pair's page: its results and features. */
function deleteStatements(
  tx: BatchExecutor,
  runId: string,
  pair: { trackingKeywordId: string; device: Device },
) {
  return [
    tx
      .delete(serpSnapshotResults)
      .where(pairFilter(serpSnapshotResults, runId, pair)),
    tx
      .delete(serpSnapshotFeatures)
      .where(pairFilter(serpSnapshotFeatures, runId, pair)),
  ];
}

/**
 * Run each item's statements, grouping items into batches of at most
 * STATEMENTS_PER_BATCH statements. An item never spans two batches, so its
 * delete and inserts are atomic: a pair never shows half of two reads.
 */
async function runGrouped<T>(
  items: T[],
  statementCount: (item: T) => number,
  build: (tx: BatchExecutor, item: T) => Promise<unknown>[],
) {
  let group: T[] = [];
  let count = 0;
  const flush = async () => {
    if (group.length === 0) return;
    const current = group;
    await runBatch((tx) => current.flatMap((item) => build(tx, item)));
    group = [];
    count = 0;
  };
  for (const item of items) {
    const size = statementCount(item);
    if (count + size > STATEMENTS_PER_BATCH) await flush();
    group.push(item);
    count += size;
  }
  await flush();
}

/** Replace the saved page of each keyword/device pair in the run. */
async function replacePages(runId: string, pages: SerpPageRows[]) {
  await runGrouped(
    pages,
    (page) =>
      2 +
      Math.ceil(page.results.length / ROWS_PER_INSERT) +
      Math.ceil(page.features.length / ROWS_PER_INSERT),
    (tx, page) => {
      const key = {
        runId,
        trackingKeywordId: page.trackingKeywordId,
        device: page.device,
      };
      return [
        ...deleteStatements(tx, runId, page),
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
    },
  );
}

async function deletePages(
  runId: string,
  pairs: Array<{ trackingKeywordId: string; device: Device }>,
) {
  await runGrouped(
    pairs,
    () => 2,
    (tx, pair) => deleteStatements(tx, runId, pair),
  );
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

/** A config's latest completed full runs, newest first. */
async function getCompletedRuns(configId: string, limit = MAX_RUNS) {
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
    .orderBy(desc(rankCheckRuns.startedAt), desc(rankCheckRuns.id))
    .limit(limit);
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
    .orderBy(desc(rankCheckRuns.startedAt), desc(rankCheckRuns.id))
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

// A run or keyword counts as saved when either table has a row for it.

/** Which of the runs have any saved page on the device, one EXISTS per run. */
async function getSavedRunIds(runIds: string[], device: Device) {
  if (runIds.length === 0) return [];
  const savedIn = (
    table: typeof serpSnapshotResults | typeof serpSnapshotFeatures,
  ) =>
    exists(
      db
        .select({ one: sql`1` })
        .from(table)
        .where(
          and(eq(table.runId, rankCheckRuns.id), eq(table.device, device)),
        ),
    );
  const rows = await db
    .select({ id: rankCheckRuns.id })
    .from(rankCheckRuns)
    .where(
      and(
        inArray(rankCheckRuns.id, runIds),
        or(savedIn(serpSnapshotResults), savedIn(serpSnapshotFeatures)),
      ),
    );
  return rows.map((row) => row.id);
}

/** The keywords each run saved a page for on the device. */
async function getSavedKeywords(runIds: string[], device: Device) {
  if (runIds.length === 0) return [];
  const pairs = (
    table: typeof serpSnapshotResults | typeof serpSnapshotFeatures,
  ) =>
    db
      .selectDistinct({
        runId: table.runId,
        trackingKeywordId: table.trackingKeywordId,
      })
      .from(table)
      .where(and(inArray(table.runId, runIds), eq(table.device, device)));
  const [results, features] = await Promise.all([
    pairs(serpSnapshotResults),
    pairs(serpSnapshotFeatures),
  ]);
  return [...results, ...features];
}

/** The top-10 domains of the runs' saved pages, without urls or titles. */
async function getTop10Domains(runIds: string[], device: Device) {
  if (runIds.length === 0) return [];
  return db
    .select({
      runId: serpSnapshotResults.runId,
      trackingKeywordId: serpSnapshotResults.trackingKeywordId,
      domain: serpSnapshotResults.domain,
    })
    .from(serpSnapshotResults)
    .where(
      and(
        inArray(serpSnapshotResults.runId, runIds),
        eq(serpSnapshotResults.device, device),
        isNotNull(serpSnapshotResults.domain),
      ),
    );
}

/** One run's values of the given feature types on the device. */
async function getFeatureValues(input: {
  runId: string;
  device: Device;
  featureTypes: string[];
}) {
  return db
    .select({
      trackingKeywordId: serpSnapshotFeatures.trackingKeywordId,
      featureType: serpSnapshotFeatures.featureType,
      value: serpSnapshotFeatures.value,
      domain: serpSnapshotFeatures.domain,
    })
    .from(serpSnapshotFeatures)
    .where(
      and(
        eq(serpSnapshotFeatures.runId, input.runId),
        eq(serpSnapshotFeatures.device, input.device),
        inArray(serpSnapshotFeatures.featureType, input.featureTypes),
      ),
    );
}

export const SerpHistoryRepository = {
  replacePages,
  deletePages,
  getSnapshotPositions,
  getCompletedRuns,
  getKeywordChecks,
  getSnapshots,
  getPages,
  getSavedRunIds,
  getSavedKeywords,
  getTop10Domains,
  getFeatureValues,
};
