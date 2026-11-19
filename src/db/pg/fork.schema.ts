import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { rankCheckRuns } from "./app.schema";

// Postgres mirror of the fork's own tables. Column notes: see ../fork.schema.ts.

export const serpSnapshotResults = pgTable(
  "serp_snapshot_results",
  {
    runId: text("run_id")
      .notNull()
      .references(() => rankCheckRuns.id, { onDelete: "cascade" }),
    trackingKeywordId: text("tracking_keyword_id").notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    rank: integer("rank").notNull(),
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

export const serpSnapshotFeatures = pgTable(
  "serp_snapshot_features",
  {
    runId: text("run_id")
      .notNull()
      .references(() => rankCheckRuns.id, { onDelete: "cascade" }),
    trackingKeywordId: text("tracking_keyword_id").notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    featureType: text("feature_type").notNull(),
    sortOrder: integer("sort_order").notNull(),
    value: text("value"),
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
