CREATE TABLE `order_number_sequence` (
  `singleton` integer PRIMARY KEY NOT NULL CHECK (`singleton` = 1),
  `next_value` integer NOT NULL CHECK (`next_value` > 0)
);
--> statement-breakpoint
INSERT INTO `order_number_sequence` (`singleton`, `next_value`) VALUES (1, 1);
--> statement-breakpoint
CREATE TABLE `orders` (
  `id` text PRIMARY KEY NOT NULL,
  `order_number` text NOT NULL,
  `status` text NOT NULL DEFAULT 'OPEN' CHECK (`status` IN ('OPEN', 'CANCELLED')),
  `created_by_user_id` text NOT NULL,
  `subtotal_minor` integer NOT NULL DEFAULT 0 CHECK (`subtotal_minor` >= 0),
  `total_minor` integer NOT NULL DEFAULT 0 CHECK (`total_minor` >= 0),
  `version` integer NOT NULL DEFAULT 1 CHECK (`version` > 0),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `cancelled_at` integer,
  `cancelled_by_user_id` text,
  `cancellation_reason` text,
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_order_number_unique` ON `orders` (`order_number`);
--> statement-breakpoint
CREATE INDEX `orders_status_updated_idx` ON `orders` (`status`, `updated_at`);
--> statement-breakpoint
CREATE TABLE `order_items` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `menu_item_id` text NOT NULL,
  `item_name_snapshot` text NOT NULL,
  `unit_price_minor` integer NOT NULL CHECK (`unit_price_minor` > 0),
  `quantity` integer NOT NULL CHECK (`quantity` >= 1 AND `quantity` <= 99),
  `line_total_minor` integer NOT NULL CHECK (`line_total_minor` > 0),
  `notes` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`menu_item_id`) REFERENCES `menu_items` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX `order_items_order_id_idx` ON `order_items` (`order_id`);
--> statement-breakpoint
CREATE TABLE `order_events` (
  `id` text PRIMARY KEY NOT NULL,
  `order_id` text NOT NULL,
  `actor_user_id` text NOT NULL,
  `event_type` text NOT NULL,
  `metadata_json` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX `order_events_order_created_idx` ON `order_events` (`order_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `idempotency_records` (
  `id` text PRIMARY KEY NOT NULL,
  `operation_type` text NOT NULL,
  `idempotency_key` text NOT NULL,
  `order_id` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_operation_key_unique` ON `idempotency_records` (`operation_type`, `idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idempotency_created_at_idx` ON `idempotency_records` (`created_at`);
