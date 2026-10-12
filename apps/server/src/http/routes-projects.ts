import { z } from "@hono/zod-openapi";
import { HttpError } from "../auth/guard.js";
import type { Operations } from "../ops.js";
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
      body: S.CreateProject,
      response: S.Project,
    }),
    async (c) => c.json(await ops.createProject(c.var.principal, c.req.valid("json"))),
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
    async (c) => c.json(await ops.getProject(c.var.principal, c.req.valid("param").projectId)),
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
