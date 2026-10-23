import type { Ticket } from "@matrix/tickets";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull(),
  baseBranch: text("base_branch").notNull().default("main"),
  config: jsonb("config").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ticketIndex = pgTable(
  "ticket_index",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ticketId: text("ticket_id").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    priority: integer("priority"),
    labels: jsonb("labels").notNull().default([]),
    url: text("url"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    snapshot: jsonb("snapshot").$type<Ticket>(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.ticketId] })],
);

export const workflows = pgTable(
  "workflows",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ticketId: text("ticket_id").notNull(),
    phase: text("phase").notNull(),
    status: text("status").notNull(),
    attempt: integer("attempt").notNull().default(0),
    loops: integer("loops").notNull().default(0),
    priority: integer("priority").notNull().default(2),
    implementerModel: text("implementer_model"),
    workspaceRef: text("workspace_ref"),
    workdir: text("workdir"),
    currentRunId: text("current_run_id"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    reviewedTree: text("reviewed_tree"),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    generation: integer("generation").notNull().default(0),
    requeuedAt: timestamp("requeued_at", { withTimezone: true }),
    requeueCount: integer("requeue_count").notNull().default(0),
    stoppedBy: text("stopped_by"),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.ticketId] }),
    index("workflows_status_idx").on(t.status, t.nextAttemptAt),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    ticketId: text("ticket_id").notNull(),
    phase: text("phase").notNull(),
    attempt: integer("attempt").notNull(),
    stepKey: text("step_key").notNull(),
    runner: text("runner"),
    model: text("model"),
    host: text("host").notNull(),
    ownerId: text("owner_id").notNull(),
    /** Clean commit the run validated (checks/review/qa) or acted on (merge/deploy). */
    headSha: text("head_sha"),
    status: text("status").notNull(),
    summary: text("summary"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: doublePrecision("cost_usd"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("runs_active_idx").on(t.status),
    index("runs_ticket_idx").on(t.projectId, t.ticketId),
  ],
);

export const steps = pgTable("steps", {
  key: text("key").primaryKey(),
  runId: text("run_id").notNull(),
  phase: text("phase").notNull(),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  ok: boolean("ok"),
  model: text("model"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: doublePrecision("cost_usd"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    runId: text("run_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
    data: jsonb("data"),
  },
  (t) => [index("events_run_idx").on(t.runId, t.id)],
);

export const receipts = pgTable(
  "receipts",
  {
    id: serial("id").primaryKey(),
    runId: text("run_id").notNull(),
    kind: text("kind").notNull(),
    ok: boolean("ok").notNull(),
    summary: text("summary").notNull(),
    path: text("path"),
    url: text("url"),
    sha256: text("sha256"),
    data: jsonb("data"),
  },
  (t) => [index("receipts_run_idx").on(t.runId)],
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    ticketId: text("ticket_id").notNull(),
    phase: text("phase").notNull(),
    runId: text("run_id").notNull(),
    headSha: text("head_sha").notNull(),
    requestedBy: text("requested_by").notNull(),
    status: text("status").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by"),
    decidedByKind: text("decided_by_kind"),
    note: text("note"),
  },
  (t) => [index("approvals_ticket_idx").on(t.projectId, t.ticketId, t.phase)],
);

export const autonomySettings = pgTable(
  "autonomy_settings",
  {
    projectId: text("project_id").notNull(),
    phase: text("phase").notNull(),
    mode: text("mode").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.phase] })],
);

export const autonomyHistory = pgTable("autonomy_history", {
  id: serial("id").primaryKey(),
  projectId: text("project_id").notNull(),
  phase: text("phase").notNull(),
  mode: text("mode").notNull(),
  actor: text("actor").notNull(),
  reason: text("reason"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const budgets = pgTable(
  "budgets",
  {
    projectId: text("project_id").notNull(),
    day: text("day").notNull(),
    limitUsd: doublePrecision("limit_usd"),
    spentUsd: doublePrecision("spent_usd").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.day] })],
);

export const concurrencyLimits = pgTable(
  "concurrency_limits",
  {
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    maxRunning: integer("max_running").notNull(),
  },
  (t) => [uniqueIndex("concurrency_scope_key").on(t.scope, t.key)],
);

export const lessons = pgTable("lessons", {
  id: serial("id").primaryKey(),
  projectId: text("project_id").notNull(),
  ticketId: text("ticket_id").notNull(),
  source: text("source").notNull(),
  lesson: text("lesson").notNull(),
  status: text("status").notNull().default("candidate"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});
