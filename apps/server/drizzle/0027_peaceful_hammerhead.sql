ALTER TABLE `form_templates` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `form_templates` ADD `detected_at` text;--> statement-breakpoint
CREATE INDEX `form_status` ON `form_templates` (`status`);