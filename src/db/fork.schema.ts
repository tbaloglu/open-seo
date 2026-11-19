import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { rankCheckRuns } from "./app.schema";

// ============================================================================
// Tables only this fork (tbaloglu/open-seo) adds. They live in their own file
// so upstream schema changes merge without conflicts.
// ============================================================================

// The SERP a rank check read, kept beside its rank snapshot: the top organic
// results and what each SERP feature showed. One set per keyword per device
// per run, from the same read as the run's rank snapshot. Like rank_snapshots,
// there is no FK to rank_tracking_keywords, so history outlives a removed
// keyword.

/** The top 10 organic results, one row per position. */
export const serpSnapshotResults = sqliteTable(
  "serp_snapshot_results",
  {
    runId: text("run_id")
      .notNull()
      .references(() => rankCheckRuns.id, { onDelete: "cascade" }),
    trackingKeywordId: text("tracking_keyword_id").notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    // Position among organic results (DataForSEO rank_group).
    rank: integer("rank").notNull(),
    // Bare host, lowercase, no www. Null when Google hid the site behind a
    // redirect and nothing on the page named it; never google.*.
    domain: text("domain"),
    url: text("url"),
    title: text("title"),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.trackingKeywordId, table.device, table.rank],
    }),
  ],
);

/**
 * One row per value a SERP feature showed: a People Also Ask question, an AI
 * Overview source, a related search, a local pack business. A feature with
 * nothing to read keeps one row with a null value, so its presence is kept.
 */
export const serpSnapshotFeatures = sqliteTable(
  "serp_snapshot_features",
  {
    runId: text("run_id")
      .notNull()
      .references(() => rankCheckRuns.id, { onDelete: "cascade" }),
    trackingKeywordId: text("tracking_keyword_id").notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    // DataForSEO item type: people_also_ask, ai_overview, local_pack, ...
    featureType: text("feature_type").notNull(),
    // Page order within the feature, from 0.
    sortOrder: integer("sort_order").notNull(),
    value: text("value"),
    // The site the value belongs to, when known (AI Overview and video
    // sources, compare sites, local pack businesses). Same form as
    // serp_snapshot_results.domain.
    domain: text("domain"),
  },
  (table) => [
    primaryKey({
      columns: [
        table.runId,
        table.trackingKeywordId,
        table.device,
        table.featureType,
        table.sortOrder,
      ],
    }),
  ],
);
