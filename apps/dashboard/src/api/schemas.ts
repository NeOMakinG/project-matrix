import { z } from "zod";

export const PHASES = [
  "spike",
  "implement",
  "checks",
  "review",
  "qa",
  "merge",
  "deploy",
  "verify",
] as const;
export const phaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof phaseSchema>;

export const toneSchema = z.enum(["green", "blue", "amber", "red", "violet", "neutral"]);
export type Tone = z.infer<typeof toneSchema>;

export const statusPillSchema = z.object({ label: z.string(), tone: toneSchema });

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  kind: z.string(),
  openTickets: z.number(),
  summary: z.string(),
  status: statusPillSchema,
  autonomy: z.string(),
  tracker: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

export const activeRunSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  title: z.string(),
  phase: z.string(),
  model: z.string(),
  costUsd: z.number(),
  status: statusPillSchema,
  projectId: z.string(),
});

export const modelHealthSchema = z.object({
  id: z.string(),
  note: z.string(),
  usage: z.number(),
  status: statusPillSchema,
});

export const overviewSchema = z.object({
  host: z.string(),
  stats: z.object({
    activeRuns: z.number(),
    activeBreakdown: z.string(),
    queue: z.number(),
    queueBreakdown: z.string(),
    costToday: z.number(),
    budget: z.number(),
    openIncidents: z.number(),
    incidentBreakdown: z.string(),
  }),
  activeRuns: z.array(activeRunSchema),
  projects: z.array(projectSchema),
  models: z.array(modelHealthSchema),
  orca: z.object({
    status: statusPillSchema,
    host: z.string(),
    version: z.string(),
    worktrees: z.string(),
    decisionGates: z.string(),
  }),
  alerts: z.array(z.object({ kind: statusPillSchema, message: z.string() })),
});
export type Overview = z.infer<typeof overviewSchema>;

export const gatewaySchema = z.object({
  address: z.string(),
  healthy: z.number(),
  total: z.number(),
});
export type Gateway = z.infer<typeof gatewaySchema>;

export const ticketKindSchema = z.enum(["feature", "bug", "prod-fix", "chore"]);
export const ticketSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: ticketKindSchema,
  phase: phaseSchema,
  badge: statusPillSchema,
  meta: z.string(),
  runId: z.string().nullable(),
});
export type Ticket = z.infer<typeof ticketSchema>;
export type TicketKind = z.infer<typeof ticketKindSchema>;

export const receiptSchema = z.object({
  kind: z.enum(["screenshot", "video", "curl", "test", "log"]),
  label: z.string(),
  ok: z.boolean(),
  url: z.string().optional(),
});
export type Receipt = z.infer<typeof receiptSchema>;

export const findingSchema = z.object({
  id: z.string(),
  severity: z.enum(["P1", "P2", "P3"]),
  lane: z.string(),
  text: z.string(),
  resolution: z.string(),
});
export type Finding = z.infer<typeof findingSchema>;

export const runEventSchema = z.object({
  at: z.string(),
  phase: phaseSchema,
  message: z.string(),
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const phaseStateSchema = z.enum(["done", "active", "pending", "failed"]);

export const runSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  ticketId: z.string(),
  title: z.string(),
  startedAt: z.string(),
  status: z.enum(["running", "paused", "done", "failed"]),
  phases: z.array(z.object({ phase: phaseSchema, state: phaseStateSchema })),
  runners: z.array(z.object({ phase: z.string(), runner: z.string(), model: z.string() })),
  workspace: z.object({ kind: z.enum(["orca", "native"]), label: z.string(), url: z.string() }),
  costUsd: z.number(),
  tokens: z.number(),
  log: z.array(runEventSchema),
  findings: z.array(findingSchema),
  receipts: z.array(receiptSchema),
  receiptsExpected: z.number(),
  holdout: z.object({
    satisfied: z.number(),
    total: z.number(),
    score: z.number(),
    judge: z.string(),
    pending: z.string(),
  }),
  merge: z.object({
    mode: z.string(),
    note: z.string(),
    decision: z.enum(["pending", "approved", "changes_requested"]),
  }),
  pullRequest: z.object({ number: z.number(), url: z.string() }),
});
export type Run = z.infer<typeof runSchema>;

export const runSummarySchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  title: z.string(),
  phase: phaseSchema,
  model: z.string(),
  costUsd: z.number(),
  status: z.enum(["running", "paused", "done", "failed"]),
  startedAt: z.string(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export const graphNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["goal", "feature", "adr", "ticket", "module"]),
  highlighted: z.boolean(),
});
export const graphEdgeSchema = z.object({ id: z.string(), source: z.string(), target: z.string() });
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const knowledgeSchema = z.object({
  summary: z.string(),
  highlight: z.string(),
  graph: z.object({ nodes: z.array(graphNodeSchema), edges: z.array(graphEdgeSchema) }),
  adrs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      area: z.string(),
      rules: z.string(),
      status: statusPillSchema,
    }),
  ),
  violations: z.array(
    z.object({
      level: z.enum(["error", "warn"]),
      adr: z.string(),
      location: z.string(),
      message: z.string(),
      note: z.string(),
    }),
  ),
  checkRef: z.string(),
});
export type Knowledge = z.infer<typeof knowledgeSchema>;

export const initOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  recommended: z.boolean(),
});

export const initSessionSchema = z.object({
  id: z.string(),
  projectName: z.string(),
  answersCount: z.number(),
  packs: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      answered: z.number(),
      total: z.number(),
      state: z.enum(["done", "active", "todo"]),
    }),
  ),
  currentPack: z.string(),
  answered: z.array(z.object({ label: z.string(), value: z.string() })),
  question: z
    .object({
      id: z.string(),
      pack: z.string(),
      index: z.number(),
      total: z.number(),
      context: z.string(),
      prompt: z.string(),
      rationale: z.string(),
      facts: z.string(),
      options: z.array(initOptionSchema),
    })
    .nullable(),
  configPreview: z.string(),
  adrs: z.array(z.object({ id: z.string(), title: z.string(), status: statusPillSchema })),
});
export type InitSession = z.infer<typeof initSessionSchema>;

export const initAnswerSchema = z.object({ questionId: z.string(), optionId: z.string() });
export type InitAnswer = z.infer<typeof initAnswerSchema>;

export const monitorSchema = z.object({
  environment: z.string(),
  connected: statusPillSchema,
  stats: z.array(z.object({ label: z.string(), value: z.string(), note: z.string() })),
  incidents: z.array(
    z.object({
      id: z.string(),
      severity: statusPillSchema,
      title: z.string(),
      cause: z.string(),
      events: z.number(),
      users: z.number(),
      fixability: z.number(),
      ticket: statusPillSchema,
    }),
  ),
  verification: z.object({
    deploy: z.string(),
    ago: z.string(),
    series: z.array(z.number()),
    deployIndex: z.number(),
    rows: z.array(z.object({ label: z.string(), value: statusPillSchema })),
  }),
});
export type Monitor = z.infer<typeof monitorSchema>;

export const AUTONOMY_PHASES = [
  "spike",
  "implement",
  "review",
  "qa",
  "merge",
  "deploy",
  "prod fixes",
] as const;
export const autonomyValueSchema = z.enum([
  "auto",
  "human approval",
  "auto-merge if holdout ≥ 0.9",
]);

export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  budget: z.string(),
  status: z.enum(["active", "revoked"]),
});
export type ApiKey = z.infer<typeof apiKeySchema>;

export const settingsSchema = z.object({
  autonomy: z.array(z.object({ phase: z.string(), value: autonomyValueSchema })),
  autonomyNote: z.string(),
  runners: z.array(z.object({ phase: z.string(), runner: z.string(), model: z.string() })),
  runnerOptions: z.array(z.string()),
  modelOptions: z.array(z.string()),
  apiKeys: z.array(apiKeySchema),
  integrations: z.array(
    z.object({ name: z.string(), detail: z.string(), status: statusPillSchema }),
  ),
});
export type Settings = z.infer<typeof settingsSchema>;

export const newApiKeySchema = z.object({
  name: z.string().trim().min(2, "Name needs at least 2 characters").max(48),
  scopes: z.array(z.string()).min(1, "Pick at least one scope"),
  budget: z.string().regex(/^(\d+(\.\d{1,2})?)?$/, "Budget is a dollar amount per day"),
});
export type NewApiKey = z.infer<typeof newApiKeySchema>;

export const createdApiKeySchema = z.object({ key: apiKeySchema, secret: z.string() });

export const API_SCOPES = [
  "read",
  "tickets:write",
  "runs:start",
  "runs:approve",
  "merge",
  "deploy",
  "admin",
] as const;
