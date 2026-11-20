CREATE TABLE "ga4_daily_page" (
	"project_id" text NOT NULL,
	"date" text NOT NULL,
	"page_path" text NOT NULL,
	"organic_sessions" integer NOT NULL,
	CONSTRAINT "ga4_daily_page_project_id_date_page_path_pk" PRIMARY KEY("project_id","date","page_path")
);
--> statement-breakpoint
CREATE TABLE "ga4_daily_site" (
	"project_id" text NOT NULL,
	"date" text NOT NULL,
	"sessions" integer NOT NULL,
	"organic_sessions" integer NOT NULL,
	"key_events" integer NOT NULL,
	"organic_key_events" integer NOT NULL,
	CONSTRAINT "ga4_daily_site_project_id_date_pk" PRIMARY KEY("project_id","date")
);
--> statement-breakpoint
CREATE TABLE "gsc_daily_page" (
	"project_id" text NOT NULL,
	"date" text NOT NULL,
	"page" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" real NOT NULL,
	"position" real NOT NULL,
	CONSTRAINT "gsc_daily_page_project_id_date_page_pk" PRIMARY KEY("project_id","date","page")
);
--> statement-breakpoint
CREATE TABLE "gsc_daily_site" (
	"project_id" text NOT NULL,
	"date" text NOT NULL,
	"device" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" real NOT NULL,
	"position" real NOT NULL,
	CONSTRAINT "gsc_daily_site_project_id_date_device_pk" PRIMARY KEY("project_id","date","device")
);
--> statement-breakpoint
CREATE TABLE "gsc_monthly_query_page" (
	"project_id" text NOT NULL,
	"month" text NOT NULL,
	"query" text NOT NULL,
	"page" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" real NOT NULL,
	"position" real NOT NULL,
	CONSTRAINT "gsc_monthly_query_page_project_id_month_query_page_pk" PRIMARY KEY("project_id","month","query","page")
);
--> statement-breakpoint
CREATE TABLE "search_archive_periods" (
	"project_id" text NOT NULL,
	"source" text NOT NULL,
	"month" text NOT NULL,
	"fetched_through" text NOT NULL,
	"complete" boolean NOT NULL,
	"row_count" integer NOT NULL,
	"fetched_at" text NOT NULL,
	CONSTRAINT "search_archive_periods_project_id_source_month_pk" PRIMARY KEY("project_id","source","month")
);
--> statement-breakpoint
CREATE TABLE "search_archive_runs" (
	"project_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text,
	"rows_written" integer DEFAULT 0 NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "seo_task_urls" (
	"task_id" text NOT NULL,
	"url" text NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "seo_task_urls_task_id_url_pk" PRIMARY KEY("task_id","url")
);
--> statement-breakpoint
CREATE TABLE "seo_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"code" text,
	"title" text NOT NULL,
	"description" text,
	"evidence" text,
	"expected_impact" text,
	"size" text,
	"priority" text DEFAULT 'medium' NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"source_report_id" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"status_changed_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"done_at" text,
	"outcome_note" text
);
--> statement-breakpoint
ALTER TABLE "ga4_daily_page" ADD CONSTRAINT "ga4_daily_page_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ga4_daily_site" ADD CONSTRAINT "ga4_daily_site_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_daily_page" ADD CONSTRAINT "gsc_daily_page_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_daily_site" ADD CONSTRAINT "gsc_daily_site_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_monthly_query_page" ADD CONSTRAINT "gsc_monthly_query_page_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_archive_periods" ADD CONSTRAINT "search_archive_periods_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_archive_runs" ADD CONSTRAINT "search_archive_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_task_urls" ADD CONSTRAINT "seo_task_urls_task_id_seo_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."seo_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_tasks" ADD CONSTRAINT "seo_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_tasks" ADD CONSTRAINT "seo_tasks_source_report_id_reports_id_fk" FOREIGN KEY ("source_report_id") REFERENCES "public"."reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seo_tasks_project_code_idx" ON "seo_tasks" USING btree ("project_id","code");--> statement-breakpoint
CREATE INDEX "seo_tasks_project_status_idx" ON "seo_tasks" USING btree ("project_id","status");