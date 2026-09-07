CREATE TABLE `staff_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kana` text,
	`chatwork_account_id` integer,
	`note` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `cases` ADD `staff_id` integer;--> statement-breakpoint
ALTER TABLE `cases` ADD `chatwork_room_id` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `client_id` integer REFERENCES clients(id);--> statement-breakpoint
ALTER TABLE `messages` ADD `case_id` integer REFERENCES cases(id);