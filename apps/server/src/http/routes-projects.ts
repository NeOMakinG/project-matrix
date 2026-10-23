import { z } from "@hono/zod-openapi";
import { HttpError } from "../auth/guard.js";
import type { Operations } from "../ops.js";
import { autonomyEtag } from "../settings-etag.js";
import { type App, ProjectParam, route } from "./route.js";
import * as S from "./schemas.js";

const TicketParam = z.object({ projectId: z.string().min(1), ticketId: z.string().min(1) });
const TicketListQuery = z.object({
  status: z.string().optional().openapi({ description: "Comma-separated statuses" }),
  labels: z.string().optional().openapi({ description: "Comma-separated labels (all must match)" }),
});

const csv = (value?: string) =>
  value
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export function projectRoutes(app: App, ops: Operations) {
  app.openapi(
    route({
      method: "get",
      path: "/v1/projects",
      tag: "projects",
      summary: "List projects",
      response: z.array(S.Project),
    }),
    async (c) => c.json(await ops.listProjects(c.var.principal)),
  );

  app.openapi(
    route({
      method: "post",
      path: "/v1/projects",
      tag: "projects",
      summary: "Create a project",
      unavailable: true,
      body: S.CreateProject,
      response: S.Project,
    }),
    async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await ops.createProject(c.var.principal, {
          name: body.name,
          description: body.description,
          workspace: body.workspace,
          ...(body.tickets
            ? {
                tickets: {
                  kind: body.tickets.kind,
                  ...(body.tickets.repo ? { repo: body.tickets.repo } : {}),
                  ...(body.tickets.linear ? { linear: linearSettings(body.tickets.linear) } : {}),
                },
              }
            : {}),
          ...(body.checks ? { checks: body.checks } : {}),
          ...(body.repo
            ? {
                repo: {
                  path: body.repo.path,
                  baseBranch: body.repo.baseBranch,
                  remote: body.repo.remote,
                  ...(body.repo.editablePaths ? { editablePaths: body.repo.editablePaths } : {}),
                  ...(body.repo.setup ? { setup: setupSteps(body.repo.setup) } : {}),
                  ...(body.repo.setupScripts ? { setupScripts: true } : {}),
                },
              }
            : {}),
          ...(body.models ? { models: modelPlan(body.models) } : {}),
          ...(body.timeouts ? { timeouts: body.timeouts } : {}),
          ...(body.idleTimeoutMs !== undefined ? { idleTimeoutMs: body.idleTimeoutMs } : {}),
          ...(body.implementGuidance !== undefined
            ? { implementGuidance: body.implementGuidance }
            : {}),
        }),
      );
    },
  );

  app.openapi(
    route({
      method: "patch",
      path: "/v1/projects/{projectId}",
      tag: "projects",
      summary:
        "Update a project's tracker, checks, per-phase model plan, run timeouts or implement guidance (host-side config)",
      params: ProjectParam,
      body: S.UpdateProject,
      response: S.Project,
    }),
    async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await ops.updateProject(c.var.principal, c.req.valid("param").projectId, {
          ...(body.repo ? { repo: repoPatch(body.repo) } : {}),
          ...(body.tickets ? { tickets: ticketSettings(body.tickets) } : {}),
          ...(body.checks ? { checks: body.checks } : {}),
          ...(body.models ? { models: modelPlan(body.models) } : {}),
          ...(body.timeouts !== undefined ? { timeouts: body.timeouts } : {}),
          ...(body.idleTimeoutMs !== undefined ? { idleTimeoutMs: body.idleTimeoutMs } : {}),
          ...(body.implementGuidance !== undefined
            ? { implementGuidance: body.implementGuidance }
            : {}),
        }),
      );
    },
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/projects/{projectId}/tracker/failures",
      tag: "projects",
      summary: "Recent ticket-tracker write failures (newest first); workflows never fail on them",
      params: ProjectParam,
      response: z.array(S.TrackerFailure),
    }),
    async (c) =>
      c.json(await ops.getTrackerFailures(c.var.principal, c.req.valid("param").projectId)),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/projects/{projectId}",
      tag: "projects",
      summary: "Get a project",
      params: ProjectParam,
      response: S.Project,
    }),
    async (c) => {
      const snapshot = await ops.getProjectPolicy(c.var.principal, c.req.valid("param").projectId);
      c.header("etag", autonomyEtag(snapshot));
      return c.json(snapshot.project);
    },
  );

  app.openapi(
    route({
      method: "put",
      path: "/v1/projects/{projectId}/autonomy",
      tag: "projects",
      summary: "Set the autonomy mode of one loop phase",
      params: ProjectParam,
      body: S.SetAutonomy,
      response: S.Project,
    }),
    async (c) => {
      const { phase, mode } = c.req.valid("json");
      return c.json(
        await ops.setAutonomy(c.var.principal, c.req.valid("param").projectId, phase, mode),
      );
    },
  );

  app.openapi(
    route({
      method: "put",
      path: "/v1/projects/{projectId}/autonomy-policy",
      tag: "projects",
      summary: "Set the autonomy of several phases in one atomic write (If-Match: project ETag)",
      params: ProjectParam,
      body: z.object({ autonomy: z.partialRecord(S.Phase, S.Autonomy) }),
      response: S.Project,
    }),
    async (c) => {
      const snapshot = await ops.setAutonomyPolicy(
        c.var.principal,
        c.req.valid("param").projectId,
        c.req.valid("json").autonomy,
        c.req.header("if-match"),
      );
      if (!snapshot) throw new Error("project disappeared after policy save");
      c.header("etag", autonomyEtag(snapshot));
      return c.json(snapshot.project);
    },
  );

  app.openapi(
    route({
      method: "patch",
      path: "/v1/init/{id}/answers/{questionId}",
      tag: "init",
      summary: "Revise one answer; dependent answers that no longer apply are dropped",
      params: z.object({ id: z.string().min(1), questionId: z.string().min(1).max(200) }),
      body: z.object({
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
      }),
      response: z.object({
        session: S.InitSession,
        dropped: z.array(z.string()),
        progress: S.InitProgress,
      }),
    }),
    async (c) => {
      const { id, questionId } = c.req.valid("param");
      return c.json(
        await ops.reviseInitAnswer(c.var.principal, id, questionId, c.req.valid("json").value),
      );
    },
  );

  app.openapi(
    route({
      method: "post",
      path: "/v1/projects/{projectId}/deploy",
      tag: "projects",
      summary: "Deploy a project",
      params: ProjectParam,
      response: S.Deployment,
    }),
    async (c) => c.json(await ops.deploy(c.var.principal, c.req.valid("param").projectId)),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/projects/{projectId}/tickets",
      tag: "tickets",
      summary: "List tickets",
      params: ProjectParam,
      query: TicketListQuery,
      response: z.array(S.Ticket),
    }),
    async (c) => {
      const q = c.req.valid("query");
      const status = csv(q.status);
      const parsed = status ? S.TicketStatus.array().safeParse(status) : undefined;
      if (parsed && !parsed.success) {
        throw new HttpError(400, "invalid_request", "unknown ticket status");
      }
      const labels = csv(q.labels);
      return c.json(
        await ops.listTickets(c.var.principal, c.req.valid("param").projectId, {
          ...(parsed?.success ? { status: parsed.data } : {}),
          ...(labels ? { labels } : {}),
        }),
      );
    },
  );

  app.openapi(
    route({
      method: "post",
      path: "/v1/projects/{projectId}/tickets",
      tag: "tickets",
      summary: "Create a ticket",
      params: ProjectParam,
      body: S.CreateTicket,
      response: S.Ticket,
    }),
    async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await ops.createTicket(c.var.principal, c.req.valid("param").projectId, {
          title: body.title,
          body: body.body,
          ...(body.labels ? { labels: body.labels } : {}),
          ...(body.priority === undefined ? {} : { priority: body.priority }),
          ...(body.parent ? { parent: body.parent } : {}),
          ...(body.deps ? { deps: body.deps } : {}),
        }),
      );
    },
  );

  app.openapi(
    route({
      method: "patch",
      path: "/v1/projects/{projectId}/tickets/{ticketId}",
      tag: "tickets",
      summary: "Update a ticket",
      params: TicketParam,
      body: S.UpdateTicket,
      response: S.Ticket,
    }),
    async (c) => {
      const { projectId, ticketId } = c.req.valid("param");
      const patch = Object.fromEntries(
        Object.entries(c.req.valid("json")).filter(([, v]) => v !== undefined),
      );
      return c.json(await ops.updateTicket(c.var.principal, projectId, ticketId, patch));
    },
  );

  app.openapi(
    route({
      method: "post",
      path: "/v1/projects/{projectId}/tickets/{ticketId}/cancel",
      tag: "tickets",
      summary: "Stop a ticket's workflow (cancels its run; move to Ready or start again to resume)",
      params: TicketParam,
      response: S.CancelResult,
    }),
    async (c) => {
      const { projectId, ticketId } = c.req.valid("param");
      return c.json(await ops.cancelTicket(c.var.principal, projectId, ticketId));
    },
  );

  app.openapi(
    route({
      method: "post",
      path: "/v1/projects/{projectId}/cancel",
      tag: "projects",
      summary: "Stop every active workflow of a project",
      params: ProjectParam,
      response: z.array(S.CancelResult),
    }),
    async (c) => c.json(await ops.cancelProject(c.var.principal, c.req.valid("param").projectId)),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/projects/{projectId}/adrs",
      tag: "knowledge",
      summary: "List ADRs",
      params: ProjectParam,
      response: z.array(S.Adr),
    }),
    async (c) => c.json(await ops.listAdrs(c.var.principal, c.req.valid("param").projectId)),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/projects/{projectId}/graph",
      tag: "knowledge",
      summary: "Get the product graph",
      params: ProjectParam,
      response: S.ProductGraph,
    }),
    async (c) => c.json(await ops.getGraph(c.var.principal, c.req.valid("param").projectId)),
  );

  app.openapi(
    route({
      method: "post",
      path: "/v1/projects/{projectId}/init",
      tag: "init",
      summary: "Start an init interview session",
      params: ProjectParam,
      response: S.InitSession,
    }),
    async (c) => c.json(await ops.startInit(c.var.principal, c.req.valid("param").projectId)),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/init/{id}",
      tag: "init",
      summary: "Get an init interview session",
      params: z.object({ id: z.string() }),
      response: S.InitSession,
    }),
    async (c) => c.json(await ops.getInit(c.var.principal, c.req.valid("param").id)),
  );

  app.openapi(
    route({
      method: "post",
      path: "/v1/init/{id}/answers",
      tag: "init",
      summary: "Submit init interview answers",
      params: z.object({ id: z.string() }),
      body: S.InitAnswers,
      response: S.InitSession,
    }),
    async (c) =>
      c.json(
        await ops.answerInit(c.var.principal, c.req.valid("param").id, c.req.valid("json").answers),
      ),
  );
}

function setupSteps(steps: Array<{ cwd?: string | undefined; run: string[] }>) {
  return steps.map((s) => ({ ...(s.cwd === undefined ? {} : { cwd: s.cwd }), run: s.run }));
}

function repoPatch(r: NonNullable<z.infer<typeof S.UpdateProject>["repo"]>) {
  return {
    ...(r.editablePaths ? { editablePaths: r.editablePaths } : {}),
    ...(r.setup !== undefined ? { setup: r.setup && setupSteps(r.setup) } : {}),
    ...(r.setupScripts !== undefined ? { setupScripts: r.setupScripts } : {}),
  };
}

function linearSettings(l: z.infer<typeof S.LinearTickets>) {
  return {
    teamKey: l.teamKey,
    projectLabel: l.projectLabel,
    ...(l.readyState ? { readyState: l.readyState } : {}),
    ...(l.apiKeyEnv ? { apiKeyEnv: l.apiKeyEnv } : {}),
    ...(l.app
      ? { app: { clientIdEnv: l.app.clientIdEnv, clientSecretEnv: l.app.clientSecretEnv } }
      : {}),
  };
}

function ticketSettings(t: NonNullable<z.infer<typeof S.UpdateProject>["tickets"]>) {
  return {
    kind: t.kind,
    ...(t.repo ? { repo: t.repo } : {}),
    ...(t.linear ? { linear: linearSettings(t.linear) } : {}),
  };
}

function modelPlan(plan: z.infer<typeof S.ModelPlan>) {
  return Object.fromEntries(Object.entries(plan).filter(([, v]) => v !== undefined));
}
