import { z } from "@hono/zod-openapi";
import type { Operations } from "../ops.js";
import { type App, IdParam, route } from "./route.js";
import * as S from "./schemas.js";

/** Read models the dashboard needs that aren't a single resource. */
export type ConfiguredWebhooks = Record<"sentry" | "github" | "posthog" | "otel" | "orca", boolean>;

export function dashboardRoutes(app: App, ops: Operations, webhooks: ConfiguredWebhooks) {
  app.openapi(
    route({
      method: "get",
      path: "/v1/integrations",
      tag: "dashboard",
      summary: "Integration status (gateway, Orca, webhooks); never includes secrets",
      response: z.array(S.Integration),
    }),
    async (c) => c.json(await ops.getIntegrations(c.var.principal, webhooks)),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/init/{id}/progress",
      tag: "init",
      summary: "Interview progress: packs, current question, config and ADR previews",
      params: IdParam,
      response: S.InitProgress,
    }),
    async (c) => c.json(await ops.getInitProgress(c.var.principal, c.req.valid("param").id)),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/init/{id}/contradictions",
      tag: "init",
      summary: "Contradictions between the current answers (errors block finalize)",
      params: IdParam,
      response: z.array(S.Contradiction),
    }),
    async (c) => c.json(await ops.getInitContradictions(c.var.principal, c.req.valid("param").id)),
  );

  app.openapi(
    route({
      method: "post",
      path: "/v1/init/{id}/finalize",
      tag: "init",
      summary:
        "Generate the project from the answers (config, ADRs, scaffold, backlog); idempotent",
      params: IdParam,
      body: z.object({ acceptRecommended: z.boolean().default(false) }),
      response: S.InitSession,
    }),
    async (c) =>
      c.json(
        await ops.finalizeInit(c.var.principal, c.req.valid("param").id, {
          acceptRecommended: c.req.valid("json").acceptRecommended,
        }),
      ),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/projects/{projectId}/checks",
      tag: "knowledge",
      summary: "Latest `matrix check` result on the default branch",
      params: z.object({ projectId: z.string().min(1) }),
      response: S.CheckResult,
    }),
    async (c) => c.json(await ops.getChecks(c.var.principal, c.req.valid("param").projectId)),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/overview",
      tag: "dashboard",
      summary: "Factory overview for the key's projects",
      response: S.Overview,
    }),
    async (c) => c.json(await ops.getOverview(c.var.principal)),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/gateway/health",
      tag: "dashboard",
      summary: "Model routes behind the gateway and their rate-limit state",
      response: z.array(S.ModelHealth),
    }),
    async (c) => c.json(await ops.getModelHealth(c.var.principal)),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/orca/runtime",
      tag: "dashboard",
      summary: "Orca runtime health as reported by Orca agent hooks",
      response: S.OrcaRuntime,
    }),
    async (c) => c.json(await ops.getOrcaRuntime(c.var.principal)),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/incidents",
      tag: "monitor",
      summary: "Prod incidents grouped by root cause",
      query: z.object({ projectId: z.string().optional(), status: S.IncidentStatus.optional() }),
      response: z.array(S.Incident),
    }),
    async (c) => {
      const q = c.req.valid("query");
      return c.json(
        await ops.listIncidents(c.var.principal, {
          ...(q.projectId ? { projectId: q.projectId } : {}),
          ...(q.status ? { status: q.status } : {}),
        }),
      );
    },
  );

  app.openapi(
    route({
      method: "patch",
      path: "/v1/keys/{id}",
      tag: "admin",
      summary: "Rename a key or change its budget and rate limit",
      params: IdParam,
      body: S.UpdateKey,
      response: S.ApiKey,
    }),
    async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await ops.updateKey(c.var.principal, c.req.valid("param").id, {
          ...(body.name ? { name: body.name } : {}),
          ...(body.budget ? { budget: body.budget } : {}),
          ...(body.ratePerMinute ? { ratePerMinute: body.ratePerMinute } : {}),
        }),
      );
    },
  );
}
