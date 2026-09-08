CREATE TABLE `case_contacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`case_id` integer NOT NULL,
	`role` text DEFAULT 'other' NOT NULL,
	`name` text NOT NULL,
	`kana` text,
	`organization` text,
	`emails` text DEFAULT '[]' NOT NULL,
	`line_user_id` text,
	`chatwork_account_id` integer,
	`phone` text,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contact_case` ON `case_contacts` (`case_id`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `case_id` integer REFERENCES cases(id);--> statement-breakpoint
ALTER TABLE `conversations` ADD `contact_id` integer REFERENCES case_contacts(id);