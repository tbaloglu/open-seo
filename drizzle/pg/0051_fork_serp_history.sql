CREATE TABLE "serp_snapshot_features" (
	"run_id" text NOT NULL,
	"tracking_keyword_id" text NOT NULL,
	"device" text NOT NULL,
	"feature_type" text NOT NULL,
	"sort_order" integer NOT NULL,
	"value" text,
	"domain" text,
	CONSTRAINT "serp_snapshot_features_run_id_tracking_keyword_id_device_feature_type_sort_order_pk" PRIMARY KEY("run_id","tracking_keyword_id","device","feature_type","sort_order")
);
--> statement-breakpoint
CREATE TABLE "serp_snapshot_results" (
	"run_id" text NOT NULL,
	"tracking_keyword_id" text NOT NULL,
	"device" text NOT NULL,
	"rank" integer NOT NULL,
	"domain" text,
	"url" text,
	"title" text,
	CONSTRAINT "serp_snapshot_results_run_id_tracking_keyword_id_device_rank_pk" PRIMARY KEY("run_id","tracking_keyword_id","device","rank")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_device" text DEFAULT 'mobile' NOT NULL;--> statement-breakpoint
ALTER TABLE "serp_snapshot_features" ADD CONSTRAINT "serp_snapshot_features_run_id_rank_check_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."rank_check_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serp_snapshot_results" ADD CONSTRAINT "serp_snapshot_results_run_id_rank_check_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."rank_check_runs"("id") ON DELETE cascade ON UPDATE no action;