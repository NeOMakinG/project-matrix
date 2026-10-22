ALTER TABLE "workflows" ADD COLUMN "generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "requeued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "requeue_count" integer DEFAULT 0 NOT NULL;