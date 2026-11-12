CREATE TABLE `secretary_turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` text NOT NULL,
	`request` text NOT NULL,
	`reply` text DEFAULT '' NOT NULL,
	`context` text,
	`actions` text DEFAULT '[]' NOT NULL,
	`previews` text DEFAULT '[]' NOT NULL,
	`questions` text DEFAULT '[]' NOT NULL,
	`applied` text,
	`applied_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `secretary_thread` ON `secretary_turns` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `secretary_created` ON `secretary_turns` (`created_at`);