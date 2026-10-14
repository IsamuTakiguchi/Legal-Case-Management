CREATE TABLE `event_style_examples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`proposed_content` text NOT NULL,
	`final_content` text NOT NULL,
	`proposed_location` text,
	`final_location` text,
	`client_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `drafts` ADD `kind` text;--> statement-breakpoint
-- これまでに作った期日連絡の下書きにも印を付ける（送った文を、次の期日連絡の手本にするため）
UPDATE `drafts` SET `kind` = 'hearing_notice' WHERE `kind` IS NULL AND `instruction` LIKE '%の結果を依頼者に報告する。%';
