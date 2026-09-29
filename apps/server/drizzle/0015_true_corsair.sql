ALTER TABLE `clients` ADD `entity_type` text DEFAULT 'individual' NOT NULL;--> statement-breakpoint
ALTER TABLE `clients` ADD `representative_title` text;--> statement-breakpoint
ALTER TABLE `clients` ADD `representative_name` text;--> statement-breakpoint
ALTER TABLE `clients` ADD `representative_kana` text;