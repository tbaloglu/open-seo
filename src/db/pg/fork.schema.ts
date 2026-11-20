import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projects, rankCheckRuns } from "./app.schema";
import { reports } from "./reports.schema";

// See src/db/pg/app.schema.ts for why timestamps are ISO-8601 UTC text.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

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

export const seoTasks = pgTable(
  "seo_tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    code: text("code"),
    title: text("title").notNull(),
    description: text("description"),
    evidence: text("evidence"),
    expectedImpact: text("expected_impact"),
    size: text("size", { enum: ["S", "M", "L"] }),
    priority: text("priority", { enum: ["high", "medium", "low"] })
      .notNull()
      .default("medium"),
    status: text("status", {
      enum: ["proposed", "selected", "in_progress", "done", "dropped"],
    })
      .notNull()
      .default("proposed"),
    sourceReportId: text("source_report_id").references(() => reports.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull().default(isoNow),
    statusChangedAt: text("status_changed_at").notNull().default(isoNow),
    doneAt: text("done_at"),
    outcomeNote: text("outcome_note"),
  },
  (table) => [
    uniqueIndex("seo_tasks_project_code_idx").on(table.projectId, table.code),
    index("seo_tasks_project_status_idx").on(table.projectId, table.status),
  ],
);

export const seoTaskUrls = pgTable(
  "seo_task_urls",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => seoTasks.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    sortOrder: integer("sort_order").notNull(),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.url] })],
);

export const gscDailySite = pgTable(
  "gsc_daily_site",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    device: text("device").notNull(),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    ctr: real("ctr").notNull(),
    position: real("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.date, table.device] }),
  ],
);

export const gscDailyPage = pgTable(
  "gsc_daily_page",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    page: text("page").notNull(),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    ctr: real("ctr").notNull(),
    position: real("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.date, table.page] }),
  ],
);

export const gscMonthlyQueryPage = pgTable(
  "gsc_monthly_query_page",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    query: text("query").notNull(),
    page: text("page").notNull(),
    clicks: integer("clicks").notNull(),
    impressions: integer("impressions").notNull(),
    ctr: real("ctr").notNull(),
    position: real("position").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.projectId, table.month, table.query, table.page],
    }),
  ],
);

export const ga4DailySite = pgTable(
  "ga4_daily_site",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    sessions: integer("sessions").notNull(),
    organicSessions: integer("organic_sessions").notNull(),
    keyEvents: integer("key_events").notNull(),
    organicKeyEvents: integer("organic_key_events").notNull(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.date] })],
);

export const ga4DailyPage = pgTable(
  "ga4_daily_page",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    pagePath: text("page_path").notNull(),
    organicSessions: integer("organic_sessions").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.date, table.pagePath] }),
  ],
);

export const searchArchivePeriods = pgTable(
  "search_archive_periods",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    source: text("source", {
      enum: ["gsc_site", "gsc_page", "gsc_query_page", "ga4_site", "ga4_page"],
    }).notNull(),
    month: text("month").notNull(),
    fetchedThrough: text("fetched_through").notNull(),
    complete: boolean("complete").notNull(),
    rowCount: integer("row_count").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.source, table.month] }),
  ],
);

export const searchArchiveRuns = pgTable("search_archive_runs", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull(),
  mode: text("mode", { enum: ["backfill", "incremental"] }).notNull(),
  status: text("status", {
    enum: ["running", "completed", "failed"],
  }).notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  rowsWritten: integer("rows_written").notNull().default(0),
  note: text("note"),
});
