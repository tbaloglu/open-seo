import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects, rankCheckRuns } from "./app.schema";
import { reports } from "./reports.schema";

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

// ============================================================================
// SEO tasks ("Yapılacaklar"): the to-do list agents write from reports and the
// owner works through. Project-scoped; deleted with the project.
// ============================================================================

export const seoTasks = sqliteTable(
  "seo_tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // The report's own label ("A1"), unique within a project when set, so an
    // agent can update a task by code instead of remembering its id.
    code: text("code"),
    title: text("title").notNull(),
    description: text("description"),
    // The data the task is based on (GSC numbers, SERP findings, ...).
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
    // The report the task came from. Deleting the report keeps the task.
    sourceReportId: text("source_report_id").references(() => reports.id, {
      onDelete: "set null",
    }),
    // ISO-8601 UTC text, stamped by the repository.
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    statusChangedAt: text("status_changed_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    // Set when the status becomes done, cleared when it leaves done.
    doneAt: text("done_at"),
    // The measured effect once done.
    outcomeNote: text("outcome_note"),
  },
  (table) => [
    // Nulls never collide, so tasks without a code are unconstrained.
    uniqueIndex("seo_tasks_project_code_idx").on(table.projectId, table.code),
    index("seo_tasks_project_status_idx").on(table.projectId, table.status),
  ],
);

/** The pages a task touches, in the order the agent listed them. */
export const seoTaskUrls = sqliteTable(
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

// ============================================================================
// Search data archive: Google keeps Search Console data for 16 months; these
// tables keep it longer. Each row is keyed by its natural key and upserted, so
// fetching a period again overwrites it. Dates are YYYY-MM-DD as Google
// reports them (Pacific Time for GSC, the property's time zone for GA4).
// ============================================================================

/** GSC totals per day and device ("DESKTOP", "MOBILE", "TABLET"). */
export const gscDailySite = sqliteTable(
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

/** GSC totals per day and page (Google's page-level aggregation). */
export const gscDailyPage = sqliteTable(
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

/** GSC totals per complete calendar month, query and page. */
export const gscMonthlyQueryPage = sqliteTable(
  "gsc_monthly_query_page",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // YYYY-MM
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

/** GA4 totals per day: all and organic-search sessions and key events. */
export const ga4DailySite = sqliteTable(
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

/** GA4 organic-search sessions per day and landing page path. */
export const ga4DailyPage = sqliteTable(
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

/**
 * What the archive job has fetched, one row per source and calendar month.
 * It makes the job resumable: a complete month is not fetched again, and an
 * incomplete one continues from `fetched_through`, re-reading the last days
 * Google may still revise.
 */
export const searchArchivePeriods = sqliteTable(
  "search_archive_periods",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    source: text("source", {
      enum: ["gsc_site", "gsc_page", "gsc_query_page", "ga4_site", "ga4_page"],
    }).notNull(),
    // YYYY-MM
    month: text("month").notNull(),
    // Last date (YYYY-MM-DD) the stored rows cover.
    fetchedThrough: text("fetched_through").notNull(),
    // True once the whole month was read at least 4 days after it ended, so
    // Google no longer revises it.
    complete: integer("complete", { mode: "boolean" }).notNull(),
    // Rows the last fetch of this month wrote.
    rowCount: integer("row_count").notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.source, table.month] }),
  ],
);

/** The latest archive job per project: its status and what it wrote. */
export const searchArchiveRuns = sqliteTable("search_archive_runs", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  // The Workflow instance id.
  runId: text("run_id").notNull(),
  mode: text("mode", { enum: ["backfill", "incremental"] }).notNull(),
  status: text("status", {
    enum: ["running", "completed", "failed"],
  }).notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  rowsWritten: integer("rows_written").notNull().default(0),
  // Sources skipped (not connected) or the failure, for the status read.
  note: text("note"),
});
