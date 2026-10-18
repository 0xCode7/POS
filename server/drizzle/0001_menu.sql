CREATE TABLE `menu_categories` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL COLLATE NOCASE,
  `sort_order` integer NOT NULL DEFAULT 0 CHECK (`sort_order` >= 0 AND `sort_order` <= 1000000),
  `is_active` integer NOT NULL DEFAULT 1 CHECK (`is_active` IN (0, 1)),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `menu_categories_name_unique` ON `menu_categories` (`name`);
--> statement-breakpoint
CREATE INDEX `menu_categories_active_sort_idx` ON `menu_categories` (`is_active`, `sort_order`);
--> statement-breakpoint
CREATE TABLE `menu_items` (
  `id` text PRIMARY KEY NOT NULL,
  `category_id` text NOT NULL,
  `name` text NOT NULL COLLATE NOCASE,
  `description` text,
  `price_minor` integer NOT NULL CHECK (`price_minor` > 0 AND `price_minor` <= 100000000),
  `is_available` integer NOT NULL DEFAULT 1 CHECK (`is_available` IN (0, 1)),
  `is_archived` integer NOT NULL DEFAULT 0 CHECK (`is_archived` IN (0, 1)),
  `sort_order` integer NOT NULL DEFAULT 0 CHECK (`sort_order` >= 0 AND `sort_order` <= 1000000),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`category_id`) REFERENCES `menu_categories` (`id`) ON UPDATE no action ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX `menu_items_category_name_unique` ON `menu_items` (`category_id`, `name`);
--> statement-breakpoint
CREATE INDEX `menu_items_category_state_sort_idx` ON `menu_items` (`category_id`, `is_archived`, `is_available`, `sort_order`);
--> statement-breakpoint
CREATE INDEX `menu_items_name_idx` ON `menu_items` (`name`);
