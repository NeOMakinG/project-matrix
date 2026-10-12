import { OpenAPIHono } from "@hono/zod-openapi";
import { Guard, HttpError } from "../auth/guard.js";
import { KeyStore } from "../auth/keys.js";
import { AuditLog, BudgetTracker, type Clock, RateLimiter } from "../auth/limits.js";
import type { CorePort } from "../core-port.js";
import { handleMcp } from "../mcp.js";
import { Operations } from "../ops.js";
import type { WebhookSecrets } from "../webhooks.js";
import type { AppEnv } from "./route.js";
import { adminRoutes } from "./routes-admin.js";
import { hookRoutes } from "./routes-hooks.js";
import { projectRoutes } from "./routes-projects.js";
import { runRoutes } from "./routes-runs.js";

export interface ServerOptions {
  core: CorePort;
  keys?: KeyStore;
  secrets?: WebhookSecrets;
  auditFile?: string;
  clock?: Clock;
}

export function createServer(options: ServerOptions) {
  const keys = options.keys ?? new KeyStore();
  const audit = new AuditLog(options.auditFile);
  const guard = new Guard(
    keys,
    new RateLimiter(options.clock),
    new BudgetTracker(options.clock),
    audit,
  );
  const ops = new Operations(options.core, guard, keys, audit);

  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        throw new HttpError(
          400,
          "invalid_request",
          result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      }
    },
  });

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      if (error.retryAfterSec) c.header("retry-after", String(error.retryAfterSec));
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    console.error(error);
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  hookRoutes(app, options.core, options.secrets ?? {});

  app.use("/v1/*", async (c, next) => {
    c.set("principal", guard.authenticate(c.req.header("authorization")));
    await next();
  });

  app.all("/mcp", async (c) =>
    handleMcp(ops, guard.authenticate(c.req.header("authorization")), c.req.raw),
  );

  projectRoutes(app, ops);
  runRoutes(app, ops);
  adminRoutes(app, ops);

  app.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
    type: "http",
    scheme: "bearer",
    description: "Project Matrix API key (mx_…)",
  });
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Project Matrix API", version: "0.1.0" },
  });

  return { app, ops, keys, audit };
}
