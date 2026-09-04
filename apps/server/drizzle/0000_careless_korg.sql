CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`dedupe_key` text,
	`title` text NOT NULL,
	`body` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`notified_at` text,
	`resolved_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_dedupe` ON `alerts` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `alert_status` ON `alerts` (`status`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` integer NOT NULL,
	`client_id` integer,
	`filename` text NOT NULL,
	`mime` text,
	`size` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`channel_ref` text DEFAULT '{}' NOT NULL,
	`stored_path` text,
	`drive_item_id` text,
	`share_url` text,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `att_status` ON `attachments` (`status`);--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`google_event_id` text NOT NULL,
	`client_id` integer,
	`case_id` integer,
	`kind` text DEFAULT 'other' NOT NULL,
	`title` text NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`location` text,
	`description` text,
	`status` text,
	`processed_post_event` integer DEFAULT false NOT NULL,
	`synced_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cal_google_id` ON `calendar_events` (`google_event_id`);--> statement-breakpoint
CREATE INDEX `cal_start` ON `calendar_events` (`start_at`);--> statement-breakpoint
CREATE TABLE `case_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`case_id` integer NOT NULL,
	`client_id` integer,
	`kind` text DEFAULT 'memo' NOT NULL,
	`occurred_at` text NOT NULL,
	`counterpart` text,
	`raw_text` text,
	`gist` text,
	`decisions` text DEFAULT '[]' NOT NULL,
	`next_actions` text DEFAULT '[]' NOT NULL,
	`waiting_for` text,
	`attachments` text DEFAULT '[]' NOT NULL,
	`created_by` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `note_case` ON `case_notes` (`case_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `case_types` (
	`key` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`has_creditors` integer DEFAULT false NOT NULL,
	`creditor_stages` text DEFAULT '[]' NOT NULL,
	`doc_type_keywords` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer NOT NULL,
	`case_type` text DEFAULT 'general_civil' NOT NULL,
	`title` text NOT NULL,
	`court_name` text,
	`case_number` text,
	`status` text DEFAULT 'active' NOT NULL,
	`stage` text,
	`policy` text,
	`policy_updated_at` text,
	`summary` text,
	`summary_generated_at` text,
	`next_hearing_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kana` text,
	`aliases` text DEFAULT '[]' NOT NULL,
	`emails` text DEFAULT '[]' NOT NULL,
	`line_user_id` text,
	`chatwork_room_id` integer,
	`chatwork_account_id` integer,
	`onedrive_folder_path` text,
	`preferred_channel` text,
	`notes` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`external_thread_id` text NOT NULL,
	`client_id` integer,
	`subject` text,
	`counterpart_name` text,
	`counterpart_address` text,
	`last_message_at` text,
	`last_inbound_at` text,
	`last_outbound_at` text,
	`unread` integer DEFAULT 0 NOT NULL,
	`needs_reply` integer DEFAULT false NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conv_channel_thread` ON `conversations` (`channel`,`external_thread_id`);--> statement-breakpoint
CREATE INDEX `conv_client` ON `conversations` (`client_id`);--> statement-breakpoint
CREATE TABLE `creditor_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`creditor_id` integer NOT NULL,
	`occurred_at` text NOT NULL,
	`channel` text DEFAULT 'memo' NOT NULL,
	`direction` text,
	`summary` text DEFAULT '' NOT NULL,
	`conversation_id` integer,
	`message_id` integer,
	`attachments` text DEFAULT '[]' NOT NULL,
	`stage_after` text,
	`created_by` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`creditor_id`) REFERENCES `creditors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cev_creditor` ON `creditor_events` (`creditor_id`,`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `cev_message` ON `creditor_events` (`creditor_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `creditors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`case_id` integer NOT NULL,
	`name` text NOT NULL,
	`kana` text,
	`kind` text,
	`address` text,
	`phone` text,
	`fax` text,
	`emails` text DEFAULT '[]' NOT NULL,
	`contact_person` text,
	`claim_amount` integer,
	`claim_kind` text,
	`stage` text,
	`last_contact_at` text,
	`next_action` text,
	`next_action_due` text,
	`note` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`external_key` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `creditor_case` ON `creditors` (`case_id`);--> statement-breakpoint
CREATE INDEX `creditor_stage` ON `creditors` (`case_id`,`stage`);--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`instruction` text,
	`generated_text` text NOT NULL,
	`final_text` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `form_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`drive_item_id` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`web_url` text,
	`ext` text,
	`modified_at` text,
	`etag` text,
	`size` integer,
	`case_type` text,
	`doc_type` text,
	`source` text DEFAULT 'library' NOT NULL,
	`client_id` integer,
	`extracted_text` text,
	`extract_error` text,
	`manual_override` integer DEFAULT false NOT NULL,
	`indexed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `form_drive_item` ON `form_templates` (`drive_item_id`);--> statement-breakpoint
CREATE INDEX `form_type` ON `form_templates` (`case_type`,`doc_type`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text,
	`ok` integer,
	`error` text,
	`summary` text
);
--> statement-breakpoint
CREATE TABLE `line_quota` (
	`month` text PRIMARY KEY NOT NULL,
	`push_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`channel` text NOT NULL,
	`external_id` text NOT NULL,
	`direction` text NOT NULL,
	`sender_name` text,
	`sender_address` text,
	`body` text DEFAULT '' NOT NULL,
	`sent_at` text NOT NULL,
	`raw` text,
	`reply_token` text,
	`reply_token_at` text,
	`draft_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `msg_channel_ext` ON `messages` (`channel`,`external_id`);--> statement-breakpoint
CREATE INDEX `msg_conv` ON `messages` (`conversation_id`,`sent_at`);--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`provider` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`account` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scheduling_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` integer,
	`conversation_id` integer,
	`kind` text NOT NULL,
	`state` text DEFAULT 'proposing' NOT NULL,
	`candidates` text DEFAULT '[]' NOT NULL,
	`confirmed_event_id` text,
	`confirmed_start_at` text,
	`zoom` text,
	`proposed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `style_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`profile_markdown` text NOT NULL,
	`generated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `style_profiles_channel_unique` ON `style_profiles` (`channel`);--> statement-breakpoint
CREATE TABLE `style_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`client_id` integer,
	`text` text NOT NULL,
	`context_text` text,
	`source` text NOT NULL,
	`external_id` text,
	`sent_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `style_ext` ON `style_samples` (`channel`,`external_id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`note` text,
	`client_id` integer,
	`case_id` integer,
	`conversation_id` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`waiting_since` text,
	`follow_up_at` text,
	`last_nudged_at` text,
	`chatwork_room_id` integer,
	`chatwork_task_id` integer,
	`due_at` text,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `task_cw` ON `tasks` (`chatwork_task_id`);