import { z } from "@hono/zod-openapi";
import { PHASES } from "@matrix/core";
import { ACTIONS } from "../auth/keys.js";

export const Phase = z.enum(PHASES).openapi("Phase");
export const Autonomy = z.enum(["human", "gated", "autonomous"]).openapi("AutonomyMode");
export const TicketStatus = z
  .enum(["open", "ready", "in_progress", "blocked", "review", "qa", "done", "closed"])
  .openapi("TicketStatus");

export const ErrorBody = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi("Error");

export const Project = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    workspace: z.enum(["orca", "native"]),
    autonomy: z.record(z.string(), Autonomy),
    createdAt: z.string(),
  })
  .openapi("Project");

export const CreateProject = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(2000).default(""),
    workspace: z.enum(["orca", "native"]).default("orca"),
  })
  .openapi("CreateProject");

export const SetAutonomy = z.object({ phase: Phase, mode: Autonomy }).openapi("SetAutonomy");

export const Ticket = z
  .object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    status: TicketStatus,
    labels: z.array(z.string()),
    priority: z.number().int().min(0).max(4).optional(),
    deps: z.array(z.string()),
    parent: z.string().optional(),
    assignee: z.string().optional(),
    phase: z.string().optional(),
    url: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Ticket");

export const Priority = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);

export const CreateTicket = z
  .object({
    title: z.string().min(1).max(300),
    body: z.string().max(50_000).default(""),
    labels: z.array(z.string().max(100)).max(50).optional(),
    priority: Priority.optional(),
    parent: z.string().max(200).optional(),
    deps: z.array(z.string().max(200)).max(100).optional(),
  })
  .openapi("CreateTicket");

export const UpdateTicket = z
  .object({
    title: z.string().min(1).max(300).optional(),
    body: z.string().max(50_000).optional(),
    status: TicketStatus.optional(),
    labels: z.array(z.string().max(100)).max(50).optional(),
    priority: Priority.optional(),
    assignee: z.string().max(200).optional(),
  })
  .openapi("UpdateTicket");

export const Run = z
  .object({
    id: z.string(),
    projectId: z.string(),
    ticketId: z.string(),
    startedBy: z.string(),
    headSha: z.string().optional(),
    phase: Phase,
    state: z.string(),
    runner: z.string(),
    model: z.string(),
    startedAt: z.string(),
    updatedAt: z.string(),
    costUsd: z.number(),
    workspaceUrl: z.string().optional(),
  })
  .openapi("Run");

export const StartRun = z
  .object({ projectId: z.string(), ticketId: z.string(), phase: Phase })
  .openapi("StartRun");

export const Receipt = z
  .object({
    kind: z.string(),
    ok: z.boolean(),
    summary: z.string(),
    path: z.string().optional(),
    url: z.string().optional(),
    sha256: z.string().optional(),
    data: z.unknown().optional(),
  })
  .openapi("Receipt");

export const ApprovalInput = z
  .object({
    decision: z.enum(["approve", "request_changes"]),
    commitSha: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/)
      .openapi({ description: "Head commit being approved; must match the run's current head" }),
    comment: z.string().max(5000).optional(),
  })
  .openapi("ApprovalInput");

export const Approval = z
  .object({
    runId: z.string(),
    decision: z.enum(["approve", "request_changes"]),
    commitSha: z.string(),
    comment: z.string().optional(),
    by: z.string(),
    byKind: z.enum(["human", "agent"]),
    at: z.string(),
  })
  .openapi("Approval");

export const Deployment = z.object({ id: z.string(), state: z.string() }).openapi("Deployment");

export const Adr = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    path: z.string(),
    rules: z.array(z.string()),
  })
  .openapi("Adr");

export const ProductGraph = z
  .object({
    nodes: z.array(z.object({ id: z.string(), kind: z.string(), label: z.string() })),
    edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string() })),
  })
  .openapi("ProductGraph");

export const InitSession = z
  .object({
    id: z.string(),
    projectId: z.string(),
    answers: z.record(z.string(), z.unknown()),
    state: z.enum(["in_progress", "completed"]),
    createdAt: z.string(),
  })
  .openapi("InitSession");

export const InitAnswers = z
  .object({
    answers: z
      .record(z.string().max(200), z.unknown())
      .refine((a) => Object.keys(a).length <= 200, "at most 200 answers per call")
      .refine((a) => JSON.stringify(a).length <= 100_000, "answers payload too large"),
  })
  .openapi("InitAnswers");

export const Settings = z.record(z.string(), z.unknown()).openapi("Settings");

export const KeyScope = z
  .object({
    projects: z.union([z.literal("*"), z.array(z.string().min(1)).min(1)]),
    actions: z.array(z.enum(ACTIONS)).min(1),
  })
  .openapi("KeyScope");

export const KeyBudget = z
  .object({
    runsPerDay: z.number().int().positive().optional(),
    mutationsPerDay: z.number().int().positive().optional(),
  })
  .openapi("KeyBudget");

export const ApiKey = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["human", "agent"]),
    scope: KeyScope,
    budget: KeyBudget,
    ratePerMinute: z.number(),
    createdAt: z.string(),
    revokedAt: z.string().optional(),
  })
  .openapi("ApiKey");

export const CreateKey = z
  .object({
    name: z.string().min(1).max(100),
    kind: z.enum(["human", "agent"]).optional(),
    scope: KeyScope,
    budget: KeyBudget.optional(),
    ratePerMinute: z.number().int().min(1).max(10_000).optional(),
  })
  .openapi("CreateKey");

export const CreatedKey = z
  .object({
    token: z.string().openapi({ description: "Shown once. Store it securely." }),
    key: ApiKey,
  })
  .openapi("CreatedKey");

export const AuditEntry = z
  .object({
    at: z.string(),
    keyId: z.string(),
    action: z.string(),
    method: z.string(),
    path: z.string(),
    projectId: z.string().optional(),
    status: z.number(),
    detail: z.string().optional(),
  })
  .openapi("AuditEntry");

export const Accepted = z.object({ id: z.string() }).openapi("Accepted");
