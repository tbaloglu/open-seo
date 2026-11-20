CREATE TABLE `ga4_daily_page` (
	`project_id` text NOT NULL,
	`date` text NOT NULL,
	`page_path` text NOT NULL,
	`organic_sessions` integer NOT NULL,
	PRIMARY KEY(`project_id`, `date`, `page_path`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ga4_daily_page_page_idx` ON `ga4_daily_page` (`project_id`,`page_path`,`date`);--> statement-breakpoint
CREATE TABLE `ga4_daily_site` (
	`project_id` text NOT NULL,
	`date` text NOT NULL,
	`sessions` integer NOT NULL,
	`organic_sessions` integer NOT NULL,
	`key_events` integer NOT NULL,
	`organic_key_events` integer NOT NULL,
	PRIMARY KEY(`project_id`, `date`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gsc_daily_page` (
	`project_id` text NOT NULL,
	`date` text NOT NULL,
	`page` text NOT NULL,
	`clicks` integer NOT NULL,
	`impressions` integer NOT NULL,
	`ctr` real NOT NULL,
	`position` real NOT NULL,
	PRIMARY KEY(`project_id`, `date`, `page`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gsc_daily_page_page_idx` ON `gsc_daily_page` (`project_id`,`page`,`date`);--> statement-breakpoint
CREATE TABLE `gsc_daily_site` (
	`project_id` text NOT NULL,
	`date` text NOT NULL,
	`device` text NOT NULL,
	`clicks` integer NOT NULL,
	`impressions` integer NOT NULL,
	`ctr` real NOT NULL,
	`position` real NOT NULL,
	PRIMARY KEY(`project_id`, `date`, `device`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `gsc_monthly_query_page` (
	`project_id` text NOT NULL,
	`month` text NOT NULL,
	`query` text NOT NULL,
	`page` text NOT NULL,
	`clicks` integer NOT NULL,
	`impressions` integer NOT NULL,
	`ctr` real NOT NULL,
	`position` real NOT NULL,
	PRIMARY KEY(`project_id`, `month`, `query`, `page`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `gsc_monthly_query_page_page_idx` ON `gsc_monthly_query_page` (`project_id`,`page`,`month`);--> statement-breakpoint
CREATE INDEX `gsc_monthly_query_page_query_idx` ON `gsc_monthly_query_page` (`project_id`,`query`,`month`);--> statement-breakpoint
CREATE TABLE `search_archive_periods` (
	`project_id` text NOT NULL,
	`source` text NOT NULL,
	`month` text NOT NULL,
	`fetched_through` text NOT NULL,
	`complete` integer NOT NULL,
	`row_count` integer NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `source`, `month`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `search_archive_runs` (
	`project_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`rows_written` integer DEFAULT 0 NOT NULL,
	`note` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `seo_task_urls` (
	`task_id` text NOT NULL,
	`url` text NOT NULL,
	`sort_order` integer NOT NULL,
	PRIMARY KEY(`task_id`, `url`),
	FOREIGN KEY (`task_id`) REFERENCES `seo_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `seo_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`code` text,
	`title` text NOT NULL,
	`description` text,
	`evidence` text,
	`expected_impact` text,
	`size` text,
	`priority` text DEFAULT 'medium' NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`source_report_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`status_changed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`done_at` text,
	`outcome_note` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seo_tasks_project_code_idx` ON `seo_tasks` (`project_id`,`code`);--> statement-breakpoint
CREATE INDEX `seo_tasks_project_status_idx` ON `seo_tasks` (`project_id`,`status`);