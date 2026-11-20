CREATE TABLE "project_topic_words" (
	"project_id" text NOT NULL,
	"word" text NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "project_topic_words_project_id_word_pk" PRIMARY KEY("project_id","word")
);
--> statement-breakpoint
ALTER TABLE "project_topic_words" ADD CONSTRAINT "project_topic_words_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;