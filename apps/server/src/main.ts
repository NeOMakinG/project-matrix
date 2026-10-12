import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { hashToken, KeyStore } from "./auth/keys.js";
import { createServer } from "./http/app.js";
import { createFactory } from "./integration/factory.js";
import { parseRuntimeKind } from "./integration/runtime.js";

const env = process.env;
// Comma-separated bind addresses, e.g. "127.0.0.1,100.x.y.z" (loopback + Tailscale only).
const hosts = (env.MATRIX_HOSTS ?? env.MATRIX_HOST ?? "127.0.0.1").split(",").map((h) => h.trim());
const port = Number(env.MATRIX_PORT ?? 8740);

const keys = new KeyStore();
// The bootstrap admin token is hashed in memory and never written anywhere.
const bootstrap = env.MATRIX_BOOTSTRAP_TOKEN ? hashToken(env.MATRIX_BOOTSTRAP_TOKEN) : null;
if (env.MATRIX_BOOTSTRAP_TOKEN && !bootstrap) {
  console.error("MATRIX_BOOTSTRAP_TOKEN must look like mx_<12 chars>_<43 chars>");
  process.exit(1);
}
if (bootstrap) {
  keys.importHashed({
    ...bootstrap,
    name: "bootstrap-admin",
    kind: "human",
    scope: { projects: "*", actions: ["admin"] },
    budget: {},
    ratePerMinute: 600,
    createdAt: new Date().toISOString(),
  });
}

const factory = await createFactory({
  runtime: parseRuntimeKind(env.MATRIX_RUNTIME),
  ...(env.MATRIX_DATABASE_URL ? { databaseUrl: env.MATRIX_DATABASE_URL } : {}),
  dataDir: env.MATRIX_DATA_DIR ?? `${env.HOME ?? "."}/.matrix`,
  host: env.MATRIX_NODE_NAME ?? "localhost",
  ...(env.MATRIX_GATEWAY_URL && env.MATRIX_GATEWAY_KEY
    ? { gateway: { baseUrl: env.MATRIX_GATEWAY_URL, apiKey: env.MATRIX_GATEWAY_KEY } }
    : {}),
  ...(env.MATRIX_TICK_MS ? { tickMs: Number(env.MATRIX_TICK_MS) } : {}),
  watch: env.MATRIX_WATCH === "1",
});
if (!env.MATRIX_DATABASE_URL) {
  console.warn("MATRIX_DATABASE_URL not set: using the in-memory store (state is lost on restart)");
}

const { app } = createServer({
  core: factory.core,
  keys,
  ...(env.MATRIX_AUDIT_FILE ? { auditFile: env.MATRIX_AUDIT_FILE } : {}),
  replayLogFile: env.MATRIX_REPLAY_LOG ?? `${env.HOME ?? "."}/.matrix/replay.log`,
  sessions: {
    ...(env.MATRIX_DASHBOARD_ORIGINS
      ? { allowedOrigins: env.MATRIX_DASHBOARD_ORIGINS.split(",") }
      : {}),
    secureCookies: env.MATRIX_INSECURE_COOKIES !== "1",
  },
  secrets: {
    ...(env.MATRIX_SENTRY_SECRET ? { sentry: env.MATRIX_SENTRY_SECRET } : {}),
    ...(env.MATRIX_GITHUB_SECRET ? { github: env.MATRIX_GITHUB_SECRET } : {}),
    ...(env.MATRIX_POSTHOG_SECRET ? { posthog: env.MATRIX_POSTHOG_SECRET } : {}),
    ...(env.MATRIX_OTEL_SECRET ? { otel: env.MATRIX_OTEL_SECRET } : {}),
    ...(env.MATRIX_ORCA_SECRET ? { orca: env.MATRIX_ORCA_SECRET } : {}),
    // Per-project webhook secrets (JSON file, mode 600): { "<projectId>": { "sentry": "…" } }.
    ...(env.MATRIX_PROJECT_SECRETS_FILE
      ? { projects: JSON.parse(readFileSync(env.MATRIX_PROJECT_SECRETS_FILE, "utf8")) }
      : {}),
  },
});

for (const hostname of hosts) {
  serve({ fetch: app.fetch, hostname, port }, (info) => {
    console.log(
      `matrix-server listening on http://${info.address}:${info.port} (runtime ${factory.runtime})`,
    );
  });
}
factory.start();

const shutdown = async () => {
  await factory.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
