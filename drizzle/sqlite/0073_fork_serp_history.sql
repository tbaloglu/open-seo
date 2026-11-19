CREATE TABLE `serp_snapshot_features` (
	`run_id` text NOT NULL,
	`tracking_keyword_id` text NOT NULL,
	`device` text NOT NULL,
	`feature_type` text NOT NULL,
	`sort_order` integer NOT NULL,
	`value` text,
	`domain` text,
	PRIMARY KEY(`run_id`, `tracking_keyword_id`, `device`, `feature_type`, `sort_order`),
	FOREIGN KEY (`run_id`) REFERENCES `rank_check_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `serp_snapshot_results` (
	`run_id` text NOT NULL,
	`tracking_keyword_id` text NOT NULL,
	`device` text NOT NULL,
	`rank` integer NOT NULL,
	`domain` text,
	`url` text,
	`title` text,
	PRIMARY KEY(`run_id`, `tracking_keyword_id`, `device`, `rank`),
	FOREIGN KEY (`run_id`) REFERENCES `rank_check_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `default_device` text DEFAULT 'mobile' NOT NULL;