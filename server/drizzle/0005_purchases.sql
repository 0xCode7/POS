CREATE TABLE `purchases` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `quantity_milli` integer NOT NULL CHECK (`quantity_milli` > 0 AND `quantity_milli` <= 10000000),
  `unit` text,
  `unit_price_minor` integer NOT NULL CHECK (`unit_price_minor` >= 0 AND `unit_price_minor` <= 100000000),
  `total_minor` integer NOT NULL CHECK (`total_minor` >= 0),
  `purchase_date` text NOT NULL,
  `created_by_user_id` text NOT NULL,
  `updated_by_user_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `deleted_at` integer,
  `deleted_by_user_id` text,
  FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`updated_by_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`deleted_by_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX `purchases_active_date_idx` ON `purchases` (`deleted_at`, `purchase_date`);
--> statement-breakpoint
CREATE INDEX `purchases_name_idx` ON `purchases` (`name`);
