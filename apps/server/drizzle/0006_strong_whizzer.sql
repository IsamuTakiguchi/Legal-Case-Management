CREATE TABLE `line_friends` (
	`user_id` text PRIMARY KEY NOT NULL,
	`display_name` text,
	`picture_url` text,
	`followed_at` text,
	`unfollowed_at` text,
	`last_seen_at` text,
	`source` text DEFAULT 'follow' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
