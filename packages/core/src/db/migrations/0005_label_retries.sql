CREATE TABLE "label_retries" (
	"project_id" text NOT NULL,
	"ticket_id" text NOT NULL,
	"id" text NOT NULL,
	"fix" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "label_retries_project_id_ticket_id_pk" PRIMARY KEY("project_id","ticket_id")
);
