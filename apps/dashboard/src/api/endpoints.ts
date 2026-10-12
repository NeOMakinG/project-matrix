import type { z } from "zod";
import {
  adaptAdrs,
  adaptGraph,
  adaptOverview,
  adaptProject,
  adaptRun,
  adaptRunSummaries,
  adaptTickets,
} from "./adapters";
import { dashboardSettingsSchema, sessionSchema, verificationSchema } from "./contracts";
import {
  ApiError,
  apiUrl,
  currentSessionGeneration,
  nextSessionGeneration,
  pathOf,
  setCsrfTokenFor,
  toApiError,
  unwrap,
  v1,
  withCsrf,
} from "./http";
import {
  ALL_PHASES,
  type AutonomyMode,
  type KeyAction,
  type ServerPhase,
  type SettingsView,
} from "./view";

/** Fetch + runtime validation for endpoints not in the server's OpenAPI yet. */
async function contract<T extends z.ZodType>(
  schema: T,
  path: string,
  init?: RequestInit,
): Promise<z.infer<T>> {
  const res = await fetch(
    apiUrl(path),
    withCsrf({ ...init, headers: { "content-type": "application/json", ...init?.headers } }),
  );
  if (!res.ok) throw await toApiError(res);
  return schema.parse(await res.json());
}

export const endpoints = {
  // --- dashboard session (server /auth/*) ---
  async session() {
    const generation = currentSessionGeneration();
    const session = await contract(sessionSchema, "/auth/session");
    if (!setCsrfTokenFor(generation, session.csrfToken))
      throw new ApiError(409, "stale_session", "Session changed");
    return session;
  },
  async signIn(token: string) {
    const generation = nextSessionGeneration();
    const session = await contract(sessionSchema, "/auth/login", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    if (!setCsrfTokenFor(generation, session.csrfToken))
      throw new ApiError(409, "stale_session", "Session changed");
    return session;
  },
  /** Resolves only once the server confirmed the logout (or the session was already gone). */
  async signOut() {
    const res = await fetch(apiUrl("/auth/logout"), withCsrf({ method: "POST" }));
    if (!res.ok && res.status !== 401) throw await toApiError(res);
    setCsrfTokenFor(nextSessionGeneration(), null);
  },

  // --- read models ---
  async overview() {
    const [overview, runs, models, orca, approvals, incidents] = await Promise.all([
      unwrap(v1.GET("/v1/overview")),
      unwrap(v1.GET("/v1/runs", {})),
      unwrap(v1.GET("/v1/gateway/health")),
      unwrap(v1.GET("/v1/orca/runtime")),
      unwrap(v1.GET("/v1/approvals", { params: { query: { status: "pending" } } })),
      unwrap(v1.GET("/v1/incidents", { params: { query: { status: "open" } } })),
    ]);
    return adaptOverview({ overview, runs, models, orca, approvals, incidents });
  },
  async gateway() {
    const models = await unwrap(v1.GET("/v1/gateway/health"));
    return { healthy: models.filter((m) => m.status === "ok").length, total: models.length };
  },
  async monitor(projectId: string) {
    const [incidents, verification] = await Promise.all([
      unwrap(v1.GET("/v1/incidents", { params: { query: { projectId } } })),
      contract(
        verificationSchema,
        pathOf("/v1/projects/{projectId}/verification", { projectId }),
      ).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }),
    ]);
    return { incidents, verification };
  },
  integrations: () => unwrap(v1.GET("/v1/integrations")),

  // --- server v1 ---
  async projects() {
    return (await unwrap(v1.GET("/v1/projects"))).map(adaptProject);
  },
  async project(projectId: string) {
    return adaptProject(
      await unwrap(v1.GET("/v1/projects/{projectId}", { params: { path: { projectId } } })),
    );
  },
  async board(projectId: string) {
    const [tickets, runs] = await Promise.all([
      unwrap(v1.GET("/v1/projects/{projectId}/tickets", { params: { path: { projectId } } })),
      unwrap(v1.GET("/v1/runs", { params: { query: { projectId } } })),
    ]);
    return adaptTickets(tickets, runs);
  },
  async runs(projectId: string) {
    const [runs, tickets] = await Promise.all([
      unwrap(v1.GET("/v1/runs", { params: { query: { projectId } } })),
      unwrap(v1.GET("/v1/projects/{projectId}/tickets", { params: { path: { projectId } } })),
    ]);
    return adaptRunSummaries(runs, tickets).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  },
  async run(runId: string) {
    const [run, receipts] = await Promise.all([
      unwrap(v1.GET("/v1/runs/{id}", { params: { path: { id: runId } } })),
      unwrap(v1.GET("/v1/runs/{id}/receipts", { params: { path: { id: runId } } })),
    ]);
    const project = await unwrap(
      v1.GET("/v1/projects/{projectId}", { params: { path: { projectId: run.projectId } } }),
    );
    return adaptRun(
      run,
      receipts,
      project.autonomy.merge ? { mergeMode: project.autonomy.merge } : {},
    );
  },
  pauseRun: (runId: string) =>
    unwrap(v1.POST("/v1/runs/{id}/pause", { params: { path: { id: runId } } })),
  decide: (approvalId: string, decision: "approved" | "rejected", note?: string) =>
    unwrap(
      v1.POST("/v1/approvals/{id}/decision", {
        params: { path: { id: approvalId } },
        body: { decision, ...(note ? { note } : {}) },
      }),
    ),

  async knowledge(projectId: string) {
    const [adrs, graph, checks] = await Promise.all([
      unwrap(v1.GET("/v1/projects/{projectId}/adrs", { params: { path: { projectId } } })),
      unwrap(v1.GET("/v1/projects/{projectId}/graph", { params: { path: { projectId } } })),
      unwrap(v1.GET("/v1/projects/{projectId}/checks", { params: { path: { projectId } } })),
    ]);
    const byAdr = new Map<string, { errors: number; warnings: number }>();
    for (const v of checks.violations) {
      const key = v.adr.replace(/^ADR-/, "");
      const entry = byAdr.get(key) ?? { errors: 0, warnings: 0 };
      if (v.level === "error") entry.errors += 1;
      else entry.warnings += 1;
      byAdr.set(key, entry);
    }
    return { adrs: adaptAdrs(adrs, byAdr), graph: adaptGraph(graph), checks };
  },

  startInit: (projectId: string) =>
    unwrap(v1.POST("/v1/projects/{projectId}/init", { params: { path: { projectId } } })),
  async init(sessionId: string) {
    const [session, progress] = await Promise.all([
      unwrap(v1.GET("/v1/init/{id}", { params: { path: { id: sessionId } } })),
      unwrap(v1.GET("/v1/init/{id}/progress", { params: { path: { id: sessionId } } })),
    ]);
    return { session, progress };
  },
  answerInit: (sessionId: string, questionId: string, optionId: string) =>
    unwrap(
      v1.POST("/v1/init/{id}/answers", {
        params: { path: { id: sessionId } },
        body: { answers: { [questionId]: optionId } },
      }),
    ),

  async settings(projectId: string): Promise<SettingsView> {
    const [project, res] = await Promise.all([
      unwrap(v1.GET("/v1/projects/{projectId}", { params: { path: { projectId } } })),
      v1.GET("/v1/settings"),
    ]);
    if (!res.response.ok || !res.data) throw await toApiError(res.response);
    const extra = dashboardSettingsSchema.parse(res.data);
    return {
      autonomy: ALL_PHASES.map((phase) => ({ phase, mode: project.autonomy[phase] ?? "human" })),
      runners: extra.runners,
      runnerOptions: extra.runnerOptions,
      modelOptions: extra.modelOptions,
      raw: res.data,
      etag: res.response.headers.get("etag"),
    };
  },
  setAutonomy: (projectId: string, phase: ServerPhase, mode: AutonomyMode) =>
    unwrap(
      v1.PUT("/v1/projects/{projectId}/autonomy", {
        params: { path: { projectId } },
        body: { phase, mode },
      }),
    ),
  async saveRunners(runners: SettingsView["runners"], etag: string | null) {
    const res = await v1.PATCH("/v1/settings", {
      body: { runners },
      headers: etag ? { "if-match": etag } : {},
    });
    if (!res.response.ok) throw await toApiError(res.response);
    return { etag: res.response.headers.get("etag") };
  },

  keys: () => unwrap(v1.GET("/v1/keys")),
  createKey: (input: {
    name: string;
    actions: KeyAction[];
    projectId: string;
    runsPerDay: number | null;
  }) =>
    unwrap(
      v1.POST("/v1/keys", {
        body: {
          name: input.name,
          kind: "agent",
          scope: { projects: [input.projectId], actions: input.actions },
          ...(input.runsPerDay ? { budget: { runsPerDay: input.runsPerDay } } : {}),
        },
      }),
    ),
  revokeKey: (id: string) => unwrap(v1.DELETE("/v1/keys/{id}", { params: { path: { id } } })),
};
