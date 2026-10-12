import { z } from "@hono/zod-openapi";
import type { Operations } from "../ops.js";
import { type App, IdParam, route } from "./route.js";
import * as S from "./schemas.js";

export function adminRoutes(app: App, ops: Operations) {
  app.openapi(
    route({
      method: "get",
      path: "/v1/settings",
      tag: "admin",
      summary: "Get factory settings",
      response: S.Settings,
    }),
    async (c) => c.json(await ops.getSettings(c.var.principal)),
  );

  app.openapi(
    route({
      method: "patch",
      path: "/v1/settings",
      tag: "admin",
      summary: "Update factory settings",
      body: S.Settings,
      response: S.Settings,
    }),
    async (c) => c.json(await ops.updateSettings(c.var.principal, c.req.valid("json"))),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/keys",
      tag: "admin",
      summary: "List API keys",
      response: z.array(S.ApiKey),
    }),
    async (c) => c.json(await ops.listKeys(c.var.principal)),
  );

  app.openapi(
    route({
      method: "post",
      path: "/v1/keys",
      tag: "admin",
      summary: "Create an API key (token shown once)",
      body: S.CreateKey,
      response: S.CreatedKey,
    }),
    async (c) => {
      const body = c.req.valid("json");
      return c.json(
        await ops.createKey(c.var.principal, {
          name: body.name,
          scope: body.scope,
          ...(body.kind ? { kind: body.kind } : {}),
          ...(body.budget ? { budget: body.budget } : {}),
          ...(body.ratePerMinute ? { ratePerMinute: body.ratePerMinute } : {}),
        }),
      );
    },
  );

  app.openapi(
    route({
      method: "delete",
      path: "/v1/keys/{id}",
      tag: "admin",
      summary: "Revoke an API key",
      params: IdParam,
      response: z.object({ id: z.string(), revoked: z.boolean() }),
    }),
    async (c) => c.json(await ops.revokeKey(c.var.principal, c.req.valid("param").id)),
  );

  app.openapi(
    route({
      method: "get",
      path: "/v1/audit",
      tag: "admin",
      summary: "Read the audit log",
      query: z.object({ keyId: z.string().optional(), projectId: z.string().optional() }),
      response: z.array(S.AuditEntry),
    }),
    async (c) => {
      const q = c.req.valid("query");
      return c.json(
        await ops.listAudit(c.var.principal, {
          ...(q.keyId ? { keyId: q.keyId } : {}),
          ...(q.projectId ? { projectId: q.projectId } : {}),
        }),
      );
    },
  );
}
