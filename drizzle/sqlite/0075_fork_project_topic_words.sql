CREATE TABLE `project_topic_words` (
	`project_id` text NOT NULL,
	`word` text NOT NULL,
	`sort_order` integer NOT NULL,
	PRIMARY KEY(`project_id`, `word`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
