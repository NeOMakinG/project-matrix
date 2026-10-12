CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"phase" text NOT NULL,
	"run_id" text NOT NULL,
	"head_sha" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "autonomy_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"phase" text NOT NULL,
	"mode" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autonomy_settings" (
	"project_id" text NOT NULL,
	"phase" text NOT NULL,
	"mode" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autonomy_settings_project_id_phase_pk" PRIMARY KEY("project_id","phase")
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"project_id" text NOT NULL,
	"day" text NOT NULL,
	"limit_usd" double precision,
	"spent_usd" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "budgets_project_id_day_pk" PRIMARY KEY("project_id","day")
);
--> statement-breakpoint
CREATE TABLE "concurrency_limits" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"max_running" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"source" text NOT NULL,
	"lesson" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"repo_path" text NOT NULL,
	"base_branch" text DEFAULT 'main' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"ok" boolean NOT NULL,
	"summary" text NOT NULL,
	"path" text,
	"url" text,
	"sha256" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"phase" text NOT NULL,
	"attempt" integer NOT NULL,
	"step_key" text NOT NULL,
	"runner" text,
	"model" text,
	"host" text NOT NULL,
	"owner_id" text NOT NULL,
	"status" text NOT NULL,
	"summary" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" double precision,
	"started_at" timestamp with time zone NOT NULL,
	"last_event_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"key" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"phase" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"ok" boolean,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" double precision,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ticket_index" (
	"project_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"priority" integer,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"url" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_index_project_id_ticket_id_pk" PRIMARY KEY("project_id","ticket_id")
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"project_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"phase" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"loops" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 2 NOT NULL,
	"implementer_model" text,
	"workspace_ref" text,
	"workdir" text,
	"current_run_id" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"reviewed_tree" text,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_project_id_ticket_id_pk" PRIMARY KEY("project_id","ticket_id")
);
--> statement-breakpoint
ALTER TABLE "ticket_index" ADD CONSTRAINT "ticket_index_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_ticket_idx" ON "approvals" USING btree ("project_id","ticket_id","phase");--> statement-breakpoint
CREATE UNIQUE INDEX "concurrency_scope_key" ON "concurrency_limits" USING btree ("scope","key");--> statement-breakpoint
CREATE INDEX "events_run_idx" ON "events" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "receipts_run_idx" ON "receipts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_active_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_ticket_idx" ON "runs" USING btree ("project_id","ticket_id");--> statement-breakpoint
CREATE INDEX "workflows_status_idx" ON "workflows" USING btree ("status","next_attempt_at");