ALTER TABLE `cases` ADD `referrer` text;--> statement-breakpoint
ALTER TABLE `clients` ADD `provisional` integer DEFAULT false NOT NULL;