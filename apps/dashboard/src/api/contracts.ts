/**
 * Contracts for endpoints the dashboard needs but the server (PR #2) does not
 * expose yet. They are validated at runtime and listed in the PR so the server
 * can implement them with these exact shapes.
 */
import { z } from "zod";

export const toneSchema = z.enum(["green", "blue", "amber", "red", "violet", "neutral"]);
export type Tone = z.infer<typeof toneSchema>;
const pill = z.object({ label: z.string(), tone: toneSchema });
export type PillData = z.infer<typeof pill>;

/** GET /v1/overview */
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
  activeRuns: z.array(
    z.object({
      id: z.string(),
      projectId: z.string(),
      ticketId: z.string(),
      title: z.string(),
      phase: z.string(),
      model: z.string(),
      costUsd: z.number(),
      status: pill,
    }),
  ),
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      summary: z.string(),
      status: pill,
    }),
  ),
  models: z.array(
    z.object({ id: z.string(), note: z.string(), usage: z.number().min(0).max(1), status: pill }),
  ),
  orca: z.object({
    status: pill,
    host: z.string(),
    worktrees: z.string(),
    decisionGates: z.string(),
  }),
  alerts: z.array(z.object({ kind: pill, message: z.string() })),
});
export type Overview = z.infer<typeof overviewSchema>;

/** GET /v1/gateway */
export const gatewaySchema = z.object({
  address: z.string(),
  healthy: z.number(),
  total: z.number(),
});
export type Gateway = z.infer<typeof gatewaySchema>;

/** GET /v1/projects/{projectId}/checks — latest `matrix check` result on the default branch. */
export const checksSchema = z.object({
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
});
export type Checks = z.infer<typeof checksSchema>;

/** GET /v1/init/{id}/progress — question bank state for an interview session. */
export const initProgressSchema = z.object({
  packs: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      answered: z.number(),
      total: z.number(),
      state: z.enum(["done", "active", "todo"]),
    }),
  ),
  answered: z.array(z.object({ questionId: z.string(), label: z.string(), value: z.string() })),
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
  adrs: z.array(z.object({ id: z.string(), title: z.string(), status: pill })),
});
export type InitProgress = z.infer<typeof initProgressSchema>;

/** GET /v1/projects/{projectId}/monitor */
export const monitorSchema = z.object({
  environment: z.string(),
  connected: pill,
  stats: z.array(z.object({ label: z.string(), value: z.string(), note: z.string() })),
  incidents: z.array(
    z.object({
      id: z.string(),
      severity: pill,
      title: z.string(),
      cause: z.string(),
      events: z.number(),
      users: z.number(),
      fixability: z.number().min(0).max(1),
      ticket: pill,
    }),
  ),
  verification: z.object({
    deploy: z.string(),
    ago: z.string(),
    series: z.array(z.number()),
    deployIndex: z.number(),
    rows: z.array(z.object({ label: z.string(), value: pill })),
  }),
});
export type Monitor = z.infer<typeof monitorSchema>;

/** GET /v1/integrations */
export const integrationsSchema = z.array(
  z.object({ name: z.string(), detail: z.string(), status: pill }),
);
export type Integrations = z.infer<typeof integrationsSchema>;

/** POST /v1/session (exchange) and GET /v1/session — cookie session + CSRF token. */
export const sessionSchema = z.object({
  user: z.string(),
  csrfToken: z.string(),
  expiresAt: z.string(),
});
export type Session = z.infer<typeof sessionSchema>;

/** Settings keys the dashboard reads inside the free-form `Settings` object. */
export const dashboardSettingsSchema = z.object({
  runners: z
    .array(z.object({ phase: z.string(), runner: z.string(), model: z.string() }))
    .default([]),
  runnerOptions: z.array(z.string()).default([]),
  modelOptions: z.array(z.string()).default([]),
});
export type DashboardSettings = z.infer<typeof dashboardSettingsSchema>;
