PRAGMA legacy_alter_table = ON;
--> statement-breakpoint
ALTER TABLE `orders` RENAME TO `orders_stage4`;
--> statement-breakpoint
CREATE TABLE `orders` (
  `id` text PRIMARY KEY NOT NULL,
  `order_number` text NOT NULL,
  `status` text NOT NULL DEFAULT 'OPEN' CHECK (`status` IN ('OPEN', 'CANCELLED', 'PAID')),
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
INSERT INTO `orders` SELECT * FROM `orders_stage4`;
--> statement-breakpoint
CREATE TABLE `order_items_new` (
  `id` text PRIMARY KEY NOT NULL, `order_id` text NOT NULL, `menu_item_id` text NOT NULL, `item_name_snapshot` text NOT NULL,
  `unit_price_minor` integer NOT NULL CHECK (`unit_price_minor` > 0), `quantity` integer NOT NULL CHECK (`quantity` >= 1 AND `quantity` <= 99),
  `line_total_minor` integer NOT NULL CHECK (`line_total_minor` > 0), `notes` text, `created_at` integer NOT NULL, `updated_at` integer NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`menu_item_id`) REFERENCES `menu_items` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
INSERT INTO `order_items_new` SELECT * FROM `order_items`;
--> statement-breakpoint
CREATE TABLE `order_events_new` (
  `id` text PRIMARY KEY NOT NULL, `order_id` text NOT NULL, `actor_user_id` text NOT NULL, `event_type` text NOT NULL, `metadata_json` text NOT NULL, `created_at` integer NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
INSERT INTO `order_events_new` SELECT * FROM `order_events`;
--> statement-breakpoint
CREATE TABLE `idempotency_records_new` (
  `id` text PRIMARY KEY NOT NULL, `operation_type` text NOT NULL, `idempotency_key` text NOT NULL, `order_id` text NOT NULL,
  `created_at` integer NOT NULL, `request_fingerprint` text,
  FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
INSERT INTO `idempotency_records_new` (`id`,`operation_type`,`idempotency_key`,`order_id`,`created_at`,`request_fingerprint`)
SELECT `id`,`operation_type`,`idempotency_key`,`order_id`,`created_at`,NULL FROM `idempotency_records`;
--> statement-breakpoint
DROP TABLE `order_items`;
--> statement-breakpoint
DROP TABLE `order_events`;
--> statement-breakpoint
DROP TABLE `idempotency_records`;
--> statement-breakpoint
DROP TABLE `orders_stage4`;
--> statement-breakpoint
ALTER TABLE `order_items_new` RENAME TO `order_items`;
--> statement-breakpoint
ALTER TABLE `order_events_new` RENAME TO `order_events`;
--> statement-breakpoint
ALTER TABLE `idempotency_records_new` RENAME TO `idempotency_records`;
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_order_number_unique` ON `orders` (`order_number`);
--> statement-breakpoint
CREATE INDEX `orders_status_updated_idx` ON `orders` (`status`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `order_items_order_id_idx` ON `order_items` (`order_id`);
--> statement-breakpoint
CREATE INDEX `order_events_order_created_idx` ON `order_events` (`order_id`, `created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idempotency_operation_key_unique` ON `idempotency_records` (`operation_type`, `idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idempotency_created_at_idx` ON `idempotency_records` (`created_at`);
--> statement-breakpoint
PRAGMA legacy_alter_table = OFF;
--> statement-breakpoint
CREATE TABLE `receipt_number_sequence` (`singleton` integer PRIMARY KEY NOT NULL CHECK (`singleton` = 1), `next_value` integer NOT NULL CHECK (`next_value` > 0));
--> statement-breakpoint
INSERT INTO `receipt_number_sequence` (`singleton`, `next_value`) VALUES (1, 1);
--> statement-breakpoint
CREATE TABLE `payments` (
  `id` text PRIMARY KEY NOT NULL, `order_id` text NOT NULL, `method` text NOT NULL CHECK (`method` = 'CASH'),
  `amount_due_minor` integer NOT NULL CHECK (`amount_due_minor` > 0), `cash_tendered_minor` integer NOT NULL CHECK (`cash_tendered_minor` > 0),
  `change_minor` integer NOT NULL CHECK (`change_minor` >= 0), `processed_by_user_id` text NOT NULL, `created_at` integer NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`processed_by_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_order_unique` ON `payments` (`order_id`);
--> statement-breakpoint
CREATE TABLE `receipts` (
  `id` text PRIMARY KEY NOT NULL, `receipt_number` text NOT NULL, `order_id` text NOT NULL, `payment_id` text NOT NULL,
  `snapshot_json` text NOT NULL, `created_at` integer NOT NULL,
  FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`payment_id`) REFERENCES `payments` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_receipt_number_unique` ON `receipts` (`receipt_number`);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_order_unique` ON `receipts` (`order_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_payment_unique` ON `receipts` (`payment_id`);
--> statement-breakpoint
CREATE TABLE `print_attempts` (
  `id` text PRIMARY KEY NOT NULL, `receipt_id` text NOT NULL, `actor_user_id` text NOT NULL,
  `outcome` text NOT NULL CHECK (`outcome` IN ('DIALOG_OPENED', 'ERROR')), `error_message` text, `created_at` integer NOT NULL,
  FOREIGN KEY (`receipt_id`) REFERENCES `receipts` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`actor_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX `print_attempts_receipt_created_idx` ON `print_attempts` (`receipt_id`, `created_at`);
