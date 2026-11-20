CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`role` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`issue_id` text,
	`attempt_id` text,
	`state` text NOT NULL,
	`until` integer,
	`last_activity` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agents_product` ON `agents` (`product_id`);--> statement-breakpoint
CREATE TABLE `attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`product_id` text NOT NULL,
	`n` integer NOT NULL,
	`issue_rev` integer NOT NULL,
	`base_sha` text NOT NULL,
	`branch` text NOT NULL,
	`head_sha` text,
	`status` text NOT NULL,
	`counted` integer NOT NULL,
	`step` text NOT NULL,
	`feedback` text,
	`review` text,
	`check_exit` integer,
	`interrupt_reason` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attempts_issue` ON `attempts` (`issue_id`,`n`);--> statement-breakpoint
CREATE TABLE `backend_limits` (
	`backend` text PRIMARY KEY NOT NULL,
	`until` integer,
	`needs_login` integer NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`product_id` text,
	`entity_id` text,
	`v` integer NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_product_seq` ON `events` (`product_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_entity_seq` ON `events` (`entity_id`,`seq`);--> statement-breakpoint
CREATE TABLE `inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`link` text,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `issue_deps` (
	`issue_id` text NOT NULL,
	`depends_on_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `depends_on_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`rev` integer NOT NULL,
	`priority` integer NOT NULL,
	`origin` text NOT NULL,
	`prd_version` integer NOT NULL,
	`attempt_count` integer NOT NULL,
	`held_question_id` text,
	`run_after` integer NOT NULL,
	`merged_order` integer,
	`merge_sha` text,
	`failure_reason` text,
	`cancel_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `issues_product` ON `issues` (`product_id`,`number`);--> statement-breakpoint
CREATE TABLE `prd_drafts` (
	`product_id` text PRIMARY KEY NOT NULL,
	`markdown` text NOT NULL,
	`base_version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `prd_versions` (
	`product_id` text NOT NULL,
	`version` integer NOT NULL,
	`markdown` text NOT NULL,
	`summary` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`product_id`, `version`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `previews` (
	`product_id` text PRIMARY KEY NOT NULL,
	`container` text NOT NULL,
	`url` text NOT NULL,
	`started_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`idea` text NOT NULL,
	`phase` text NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`pause_reason` text,
	`budget_usd` real,
	`budget_warned` integer DEFAULT false NOT NULL,
	`max_parallel` integer DEFAULT 3 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`models` text NOT NULL,
	`git_remote` text,
	`prd_version` integer DEFAULT 0 NOT NULL,
	`orchestrator_cursor` integer DEFAULT 0 NOT NULL,
	`project` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`issue_id` text,
	`agent_id` text,
	`target` text NOT NULL,
	`text` text NOT NULL,
	`answer` text,
	`created_at` integer NOT NULL,
	`answered_at` integer,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `secrets` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `spar_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	`seq` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `spar_messages_product_seq` ON `spar_messages` (`product_id`,`seq`);--> statement-breakpoint
CREATE TABLE `usage` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`issue_id` text,
	`attempt_id` text,
	`agent_id` text NOT NULL,
	`role` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`billing` text NOT NULL,
	`input` integer NOT NULL,
	`output` integer NOT NULL,
	`cache_read` integer NOT NULL,
	`cache_write` integer NOT NULL,
	`reasoning` integer NOT NULL,
	`web_searches` integer NOT NULL,
	`calls` integer NOT NULL,
	`cost_usd` real,
	`unpriced` integer NOT NULL,
	`est_cost_usd` real,
	`source` text NOT NULL,
	`ts` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `usage_product` ON `usage` (`product_id`);--> statement-breakpoint
CREATE INDEX `usage_issue` ON `usage` (`issue_id`);--> statement-breakpoint
CREATE TABLE `usage_totals` (
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`api_usd` real NOT NULL,
	`api_unpriced` integer NOT NULL,
	`sub_input` integer NOT NULL,
	`sub_output` integer NOT NULL,
	`sub_cache_read` integer NOT NULL,
	`sub_cache_write` integer NOT NULL,
	`sub_reasoning` integer NOT NULL,
	`sub_calls` integer NOT NULL,
	PRIMARY KEY(`scope`, `scope_id`)
);
