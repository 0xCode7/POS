CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `username` text NOT NULL COLLATE NOCASE,
  `display_name` text NOT NULL,
  `password_hash` text NOT NULL,
  `role` text NOT NULL CHECK (`role` IN ('admin', 'cashier')),
  `active` integer NOT NULL DEFAULT 1 CHECK (`active` IN (0, 1)),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
--> statement-breakpoint
CREATE INDEX `users_role_active_idx` ON `users` (`role`, `active`);
--> statement-breakpoint
CREATE TABLE `sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `token_hash` text NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON UPDATE no action ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);
