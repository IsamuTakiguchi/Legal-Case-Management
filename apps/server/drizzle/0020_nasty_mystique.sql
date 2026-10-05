CREATE TABLE `client_persons` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`name` text NOT NULL,
	`kana` text,
	`title` text,
	`emails` text DEFAULT '[]' NOT NULL,
	`phones` text DEFAULT '[]' NOT NULL,
	`line_user_id` text,
	`chatwork_account_id` integer,
	`chatwork_room_id` integer,
	`is_primary` integer DEFAULT false NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `client_person_client` ON `client_persons` (`client_id`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `client_person_id` integer REFERENCES client_persons(id);