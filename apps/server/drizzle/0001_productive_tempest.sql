ALTER TABLE `case_notes` ADD `phone` text;--> statement-breakpoint
ALTER TABLE `case_notes` ADD `their_said` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `case_notes` ADD `our_said` text DEFAULT '[]' NOT NULL;