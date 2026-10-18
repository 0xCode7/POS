CREATE INDEX `payments_created_at_idx` ON `payments` (`created_at`);
--> statement-breakpoint
CREATE INDEX `payments_actor_created_idx` ON `payments` (`processed_by_user_id`,`created_at`);
