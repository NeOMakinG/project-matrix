import { z } from "@hono/zod-openapi";
import { PHASES } from "@matrix/core";
import { ACTIONS } from "../auth/keys.js";

export const Phase = z.enum(PHASES).openapi("Phase");
export const Autonomy = z.enum(["human", "gated", "autonomous"]).openapi("AutonomyMode");
export const TicketStatus = z
  .enum(["open", "ready", "in_progress", "blocked", "review", "qa", "done", "closed"])
  .openapi("TicketStatus");

export const ErrorBody = z
  .object({
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
  })
  .openapi("Error");

export const Project = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    workspace: z.enum(["orca", "native"]),
    autonomy: z.record(z.string(), Autonomy),
    createdAt: z.string(),
    repo: z
      .object({
        external: z.literal(true),
        baseBranch: z.string(),
        remote: z.string(),
        github: z.string(),
      })
      .optional()
      .openapi({ description: "Set for an existing repo registered on the host" }),
    models: z
      .object(
        Object.fromEntries(
          (["spike", "design", "implement", "review", "qa"] as const).map((phase) => [
            phase,
            z.object({ runner: z.string(), model: z.string() }).optional(),
          ]),
        ) as Record<
          "spike" | "design" | "implement" | "review" | "qa",
          z.ZodOptional<z.ZodObject<{ runner: z.ZodString; model: z.ZodString }>>
        >,
      )
      .optional()
      .openapi({ description: "Effective model per model-driven phase" }),
    checks: z.array(z.object({ kind: z.string(), cmd: z.array(z.string()) })).optional(),
  })
  .openapi("Project");

export const PhaseModel = z
  .object({
    runner: z.enum(["claude-code", "codex", "opencode"]),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/, "invalid model id"),
  })
  .strict()
  .openapi("PhaseModel");

/** Per-phase model plan; review must differ from implement (independent review). */
export const ModelPlan = z
  .object({
    spike: PhaseModel.optional(),
    design: PhaseModel.optional(),
    implement: PhaseModel.optional(),
    review: PhaseModel.optional(),
    qa: PhaseModel.optional(),
    reviewerFallbacks: z.array(PhaseModel).max(5).optional(),
  })
  .strict()
  .openapi("ModelPlan");

export const ExistingRepo = z
  .object({
    path: z
      .string()
      .min(2)
      .max(500)
      .regex(/^\/[^\u0000-\u001f\u007f]*$/, "must be an absolute path")
      .openapi({ description: "Absolute host path under MATRIX_REPO_ROOTS" }),
    baseBranch: z.string().min(1).max(200).default("main"),
    remote: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      .default("origin")
      .openapi({ description: "GitHub remote draft PRs are opened on" }),
  })
  .strict()
  .openapi("ExistingRepo");

/** Linear settings. The API key itself is never accepted: only the host env var NAME holding it. */
export const LinearTickets = z
  .object({
    teamKey: z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/),
    projectLabel: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    readyState: z.string().min(1).max(80).optional(),
    apiKeyEnv: z
      .string()
      .max(64)
      .regex(/^([A-Z0-9]+_)*LINEAR(_[A-Z0-9]+)*$/, "must be an env var name containing LINEAR")
      .optional()
      .openapi({ description: "Host env var NAME holding the key; default LINEAR_API_KEY" }),
  })
  .strict()
  .openapi("LinearTickets");

export const TrackerFailure = z
  .object({
    ticketId: z.string().optional(),
    operation: z.string(),
    message: z.string(),
    at: z.string(),
  })
  .openapi("TrackerFailure");

export const QuotaStatus = z
  .object({
    provider: z.string(),
    limits: z.object({
      maxConcurrent: z.number(),
      maxRunsPerHour: z.number(),
      maxRunnerMinutesPer5h: z.number(),
    }),
    active: z.number(),
    runsLastHour: z.number(),
    runnerMinutes5h: z.number(),
    cooldown: z
      .object({ until: z.string(), failures: z.number(), reason: z.string(), at: z.string() })
      .optional(),
  })
  .openapi("QuotaStatus");

const TicketsSettings = z
  .object({
    kind: z.enum(["beads", "markdown", "github", "linear"]),
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/)
      .optional(),
    linear: LinearTickets.optional(),
  })
  .strict()
  .refine((t) => (t.kind === "linear") === (t.linear !== undefined), {
    message: "`linear` is required for, and only allowed with, kind linear",
    path: ["linear"],
  });

const ChecksSettings = z
  .array(
    z.object({
      kind: z.enum(["typecheck", "lint", "test", "adr-check"]),
      cmd: z.array(z.string().min(1).max(200)).min(1).max(20),
    }),
  )
  .max(20);

export const UpdateProject = z
  .object({
    tickets: TicketsSettings.optional(),
    checks: ChecksSettings.optional().openapi({
      description: "Check commands run in the sandbox (argv, no shell)",
    }),
    models: ModelPlan.optional(),
  })
  .strict()
  .openapi("UpdateProject");

export const CreateProject = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(2000).default(""),
    workspace: z.enum(["orca", "native"]).default("orca"),
    tickets: z
      .object({
        kind: z.enum(["beads", "markdown", "github", "linear"]),
        repo: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/)
          .optional(),
        linear: LinearTickets.optional(),
      })
      .strict()
      .refine((t) => (t.kind === "linear") === (t.linear !== undefined), {
        message: "`linear` is required for, and only allowed with, kind linear",
        path: ["linear"],
      })
      .optional()
      .openapi({ description: "Ticket tracker; beads by default" }),
    checks: z
      .array(
        z.object({
          kind: z.enum(["typecheck", "lint", "test", "adr-check"]),
          cmd: z.array(z.string().min(1).max(200)).min(1).max(20),
        }),
      )
      .max(20)
      .optional()
      .openapi({ description: "Check commands run in the sandbox (argv, no shell)" }),
    repo: ExistingRepo.optional().openapi({
      description: "Register an existing host repo instead of creating an empty one",
    }),
    models: ModelPlan.optional(),
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
    ownerId: z.string(),
    title: z.string().optional(),
    prUrl: z.string().optional(),
    approval: z
      .object({
        state: z.enum(["none", "pending", "approved", "rejected"]),
        approvalId: z.string().optional(),
        phase: Phase.optional(),
      })
      .openapi({ description: "Latest approval requested for this run" }),
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

export const ApprovalStatus = z.enum(["pending", "approved", "rejected"]).openapi("ApprovalStatus");

export const ApprovalDecisionInput = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    note: z.string().max(5000).optional(),
  })
  .openapi("ApprovalDecisionInput");

export const Approval = z
  .object({
    id: z.string(),
    projectId: z.string(),
    ticketId: z.string(),
    phase: Phase,
    runId: z.string(),
    headSha: z.string(),
    requestedBy: z.string(),
    status: ApprovalStatus,
    requestedAt: z.string(),
    decidedAt: z.string().optional(),
    decidedBy: z.string().optional(),
    decidedByKind: z.enum(["human", "agent"]).optional(),
    note: z.string().optional(),
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
    nodes: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        label: z.string(),
        data: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string() })),
    context: z.record(z.string(), z.unknown()).optional(),
    architecture: z
      .object({ path: z.string(), readOnly: z.literal(true), graph: z.unknown() })
      .optional(),
  })
  .openapi("ProductGraph");

export const InitSession = z
  .object({
    id: z.string(),
    projectId: z.string(),
    answers: z.record(z.string(), z.unknown()),
    state: z.enum(["in_progress", "completed"]),
    createdAt: z.string(),
    result: z
      .discriminatedUnion("status", [
        z.object({ status: z.literal("missing"), missing: z.array(z.string()) }),
        z.object({
          status: z.literal("contradictions"),
          contradictions: z.array(
            z.object({ id: z.string(), message: z.string(), questions: z.array(z.string()) }),
          ),
        }),
        z.object({
          status: z.literal("invalid"),
          issues: z.array(z.object({ path: z.string(), message: z.string() })),
        }),
        z.object({
          status: z.literal("ok"),
          files: z.array(z.string()),
          tickets: z.array(z.string()),
          warnings: z.array(z.string()),
          commit: z.string().optional(),
        }),
      ])
      .optional(),
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

export const Overview = z
  .object({
    projects: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        workspace: z.enum(["orca", "native"]),
        activeRuns: z.number(),
        openIncidents: z.number(),
      }),
    ),
    activeRuns: z.number(),
    queuedRuns: z.number(),
    costTodayUsd: z.number(),
    pendingApprovals: z.number(),
    openIncidents: z.number(),
  })
  .openapi("Overview");

export const ModelHealth = z
  .object({
    model: z.string(),
    provider: z.string(),
    status: z.enum(["ok", "cooldown", "throttled", "down"]),
    utilization: z.number().min(0).max(1).optional(),
    resetsAt: z.string().optional(),
    detail: z.string().optional(),
  })
  .openapi("ModelHealth");

export const IncidentStatus = z.enum(["open", "fixing", "resolved"]).openapi("IncidentStatus");

export const Incident = z
  .object({
    id: z.string(),
    projectId: z.string().optional(),
    source: z.enum(["sentry", "posthog", "github", "otel"]),
    fingerprint: z.string(),
    title: z.string(),
    count: z.number(),
    firstSeen: z.string(),
    lastSeen: z.string(),
    status: IncidentStatus,
    fixability: z.number().min(0).max(1).optional(),
    ticketId: z.string().optional(),
  })
  .openapi("Incident");

export const OrcaRuntime = z
  .object({
    status: z.enum(["healthy", "degraded", "unknown"]),
    host: z.string().optional(),
    version: z.string().optional(),
    activeWorktrees: z.number(),
    lastSeen: z.string().optional(),
  })
  .openapi("OrcaRuntime");

export const UpdateKey = z
  .object({
    name: z.string().min(1).max(100).optional(),
    budget: KeyBudget.optional(),
    ratePerMinute: z.number().int().min(1).max(10_000).optional(),
  })
  .openapi("UpdateKey");

export const Tone = z.enum(["green", "blue", "amber", "red", "violet", "neutral"]).openapi("Tone");
export const Pill = z.object({ label: z.string(), tone: Tone }).openapi("Pill");

export const Integration = z
  .object({ name: z.string(), detail: z.string(), status: Pill })
  .openapi("Integration");

export const CheckResult = z
  .object({
    ref: z.string(),
    violations: z.array(
      z.object({
        level: z.enum(["error", "warn"]),
        adr: z.string(),
        location: z.string(),
        message: z.string(),
        note: z.string(),
      }),
    ),
  })
  .openapi("CheckResult");

export const Contradiction = z
  .object({
    id: z.string(),
    severity: z.enum(["error", "warning"]),
    message: z.string(),
    questions: z.array(z.string()),
  })
  .openapi("Contradiction");

export const InitProgress = z
  .object({
    packs: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        answered: z.number(),
        total: z.number(),
        state: z.enum(["done", "active", "todo"]),
      }),
    ),
    answered: z.array(
      z.object({
        questionId: z.string(),
        label: z.string(),
        value: z.string(),
        id: z.string(),
        pack: z.string(),
        prompt: z.string(),
        kind: z.enum(["select", "multiselect", "text", "list", "confirm", "number"]),
        rationale: z.string(),
        recommended: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
        options: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            description: z.string(),
            recommended: z.boolean(),
          }),
        ),
        dependsOn: z.array(z.string()),
      }),
    ),
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
        options: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            description: z.string(),
            recommended: z.boolean(),
          }),
        ),
      })
      .nullable(),
    configPreview: z.string(),
    adrs: z.array(z.object({ id: z.string(), title: z.string(), status: Pill })),
    round: z.array(
      z.object({
        id: z.string(),
        pack: z.string(),
        kind: z.enum(["select", "multiselect", "text", "list", "confirm", "number"]),
        prompt: z.string(),
        rationale: z.string(),
        recommended: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
        options: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            description: z.string(),
            recommended: z.boolean(),
          }),
        ),
        dependsOn: z.array(z.string()),
      }),
    ),
    contradictions: z.array(Contradiction),
  })
  .openapi("InitProgress");
