import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Guard, HttpError } from "../auth/guard.js";
import { KeyStore } from "../auth/keys.js";
import { AuditLog, BudgetTracker, type Clock, RateLimiter } from "../auth/limits.js";
import { ReplayLog } from "../auth/replay-log.js";
import { SessionStore } from "../auth/sessions.js";
import { WebhookSecretStore } from "../auth/webhook-secrets.js";
import type { CorePort } from "../core-port.js";
import { handleMcp } from "../mcp.js";
import { Operations } from "../ops.js";
import { RunEventLog } from "../run-event-log.js";
import { PrivateStateOwner } from "../state-owner.js";
import type { WebhookSecrets } from "../webhooks.js";
import { dashboardRoutes as serveDashboard } from "./dashboard-static.js";
import type { AppEnv } from "./route.js";
import { adminRoutes, webhookSecretRoutes } from "./routes-admin.js";
import { dashboardRoutes } from "./routes-dashboard.js";
import { hookRoutes } from "./routes-hooks.js";
import { projectRoutes } from "./routes-projects.js";
import { runRoutes } from "./routes-runs.js";
import { authMiddleware, type SessionOptions, sessionRoutes } from "./routes-session.js";

export interface ServerOptions {
  stateDir?: string;
  core: CorePort;
  keys?: KeyStore;
  secrets?: WebhookSecrets;
  auditFile?: string;
  clock?: Clock;
  sessions?: SessionOptions;
  /** Persists webhook/Orca replay protection across restarts. */
  replayLogFile?: string;
  /** Built dashboard (apps/dashboard/dist) served same-origin; omit to serve the API only. */
  dashboardDir?: string;
  /** Per-project webhook secrets issued through the API (JSON, mode 600). */
  webhookSecretsFile?: string;
  /** Extra health details (store, runtime, loop state) for /healthz. */
  health?: () => Promise<Record<string, unknown>>;
}

export function createServer(options: ServerOptions) {
  const sharedOwner = options.core.stateOwner;
  const stateOwner =
    sharedOwner ?? (options.stateDir ? new PrivateStateOwner(options.stateDir) : undefined);
  let claimed = false;
  try {
    stateOwner?.claimServer(options.stateDir ?? stateOwner.directory);
    claimed = true;
    const stateFile = (name: string) => (stateOwner ? join(stateOwner.directory, name) : undefined);
    if (stateOwner && options.keys && options.keys.stateOwner !== stateOwner)
      throw new Error("keys must share exclusive lifetime ownership");
    const keys = options.keys ?? new KeyStore(stateFile("keys.json"), stateOwner);
    const audit = new AuditLog(options.auditFile, 10_000, stateOwner);
    const guard = new Guard(
      keys,
      new RateLimiter(options.clock),
      new BudgetTracker(options.clock, stateFile("budgets.json"), stateOwner),
      audit,
      options.clock,
      stateFile("idempotency.json"),
      stateOwner,
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
        return c.json(
          {
            error: {
              code: error.code,
              message: error.message,
              ...(error.details === undefined ? {} : { details: error.details }),
            },
          },
          error.status,
        );
      }
      console.error(error);
      return c.json({ error: { code: "internal", message: "internal error" } }, 500);
    });
    let closing = false;
    let closed: Promise<void> | undefined;
    let inFlight = 0;
    let drained: (() => void) | undefined;
    const ownershipLost = () => {
      closing = true;
      drained?.();
    };
    stateOwner?.signal.addEventListener("abort", ownershipLost, { once: true });
    app.use("*", async (context, next) => {
      if (closing)
        return context.json({ error: { code: "unavailable", message: "server is closing" } }, 503);
      stateOwner?.assertOwned();
      inFlight += 1;
      try {
        if (stateOwner) await stateOwner.guard(next);
        else await next();
      } finally {
        inFlight -= 1;
        if (inFlight === 0) drained?.();
      }
    });

    app.get("/healthz", async (c) => {
      const details =
        (await options.health?.().catch((e: unknown) => ({ ok: false, error: String(e) }))) ?? {};
      const ok = details.ok !== false;
      return c.json({ ...details, ok }, ok ? 200 : 503);
    });

    const webhookSecrets = new WebhookSecretStore(options.webhookSecretsFile, stateOwner);
    // Statically configured per-project secrets (env/file) are merged into the live store.
    Object.assign(webhookSecrets.projects, options.secrets?.projects ?? {});
    const liveSecrets = { ...(options.secrets ?? {}), projects: webhookSecrets.projects };
    hookRoutes(
      app,
      options.core,
      liveSecrets,
      new ReplayLog({
        owner: stateOwner,
        ...(options.replayLogFile ? { file: options.replayLogFile } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
      }),
      options.clock,
    );

    const sessions = new SessionStore(options.clock, stateFile("sessions.json"), stateOwner);
    const sessionOptions = options.sessions ?? {};
    sessionRoutes(app, keys, sessions, sessionOptions);
    app.use("/v1/*", authMiddleware(guard, keys, sessions, sessionOptions));

    app.all("/mcp", async (c) =>
      handleMcp(ops, guard.authenticate(c.req.header("authorization")), c.req.raw),
    );

    projectRoutes(app, ops);
    runRoutes(app, ops, keys, new RunEventLog(options.core));
    adminRoutes(app, ops);
    webhookSecretRoutes(app, ops, webhookSecrets);
    const secrets = liveSecrets;
    const configured = (source: "sentry" | "github" | "posthog" | "otel" | "orca") =>
      Boolean(secrets[source]) ||
      Object.values(secrets.projects ?? {}).some((project) => Boolean(project[source]));
    dashboardRoutes(app, ops, {
      sentry: configured("sentry"),
      github: configured("github"),
      posthog: configured("posthog"),
      otel: configured("otel"),
      orca: configured("orca"),
    });

    app.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
      type: "http",
      scheme: "bearer",
      description: "Project Matrix API key (mx_…)",
    });
    app.doc31("/openapi.json", {
      openapi: "3.1.0",
      info: { title: "Project Matrix API", version: "0.1.0" },
    });

    if (options.dashboardDir) serveDashboard(app, options.dashboardDir);

    return {
      app,
      ops,
      keys,
      audit,
      sessions,
      close() {
        closed ??= (async () => {
          closing = true;
          if (inFlight > 0 && !stateOwner?.signal.aborted)
            await new Promise<void>((resolve) => {
              drained = resolve;
            });
          stateOwner?.releaseServer();
          stateOwner?.signal.removeEventListener("abort", ownershipLost);
          if (!sharedOwner) await stateOwner?.close();
        })();
        return closed;
      },
    };
  } catch (error) {
    if (claimed) stateOwner?.releaseServer();
    if (!sharedOwner) void stateOwner?.close();
    throw error;
  }
}
