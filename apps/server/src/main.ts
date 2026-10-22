import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { type CredentialSource, resolveCredential } from "@matrix/sandbox";
import { hashToken, KeyStore } from "./auth/keys.js";
import { createServer } from "./http/app.js";
import { parseRepoRoots } from "./integration/existing-repo.js";
import { createFactory } from "./integration/factory.js";
import { parseQuotaEnv } from "./integration/quota-config.js";
import { parseRuntimeKind } from "./integration/runtime.js";
import { PrivateStateOwner } from "./state-owner.js";

const env = process.env;
// Comma-separated bind addresses, e.g. "127.0.0.1,100.x.y.z" (loopback + Tailscale only).
const hosts = (env.MATRIX_HOSTS ?? env.MATRIX_HOST ?? "127.0.0.1").split(",").map((h) => h.trim());
const port = Number(env.MATRIX_PORT ?? 8740);

const dataDir = env.MATRIX_DATA_DIR ?? `${env.HOME ?? "."}/.matrix`;
const stateOwner = new PrivateStateOwner(dataDir);
const keys = new KeyStore(join(stateOwner.directory, "keys.json"), stateOwner);
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

const runtime = parseRuntimeKind(env.MATRIX_RUNTIME);
if (runtime !== "fake" && !env.MATRIX_DATABASE_URL)
  throw new Error("MATRIX_DATABASE_URL is required for a persistent native/orca server");
// The gateway key is read from a file (e.g. the Hermes config) or the environment; containers never see it.
const gatewayKey: CredentialSource | undefined = env.MATRIX_GATEWAY_KEY_FILE
  ? {
      file: env.MATRIX_GATEWAY_KEY_FILE,
      ...(env.MATRIX_GATEWAY_KEY_PATTERN
        ? { pattern: new RegExp(env.MATRIX_GATEWAY_KEY_PATTERN, "m") }
        : {}),
    }
  : env.MATRIX_GATEWAY_KEY
    ? { env: "MATRIX_GATEWAY_KEY" }
    : undefined;
const gatewayKeyValue = gatewayKey ? await resolveCredential(gatewayKey) : undefined;

const factory = await createFactory({
  stateOwner,
  runtime,
  ...(runtime !== "fake" && env.MATRIX_GATEWAY_URL && gatewayKey
    ? {
        native: {
          gatewayUrl: env.MATRIX_GATEWAY_URL,
          gatewayKey,
          image: env.MATRIX_RUNNER_IMAGE ?? "matrix-runner:dev",
          ...(env.MATRIX_PODMAN ? { podmanBinary: env.MATRIX_PODMAN } : {}),
          ...(env.MATRIX_GITLEAKS ? { gitleaksBinary: env.MATRIX_GITLEAKS } : {}),
          ...(env.MATRIX_ORCA_ENVIRONMENT ? { orcaEnvironment: env.MATRIX_ORCA_ENVIRONMENT } : {}),
          ...(env.MATRIX_ORCA_BINARY ? { orcaBinary: env.MATRIX_ORCA_BINARY } : {}),
        },
      }
    : {}),
  binaries: {
    ...(env.MATRIX_BD ? { bd: env.MATRIX_BD } : {}),
    ...(env.MATRIX_GH ? { gh: env.MATRIX_GH } : {}),
  },
  ...(env.MATRIX_DATABASE_URL ? { databaseUrl: env.MATRIX_DATABASE_URL } : {}),
  repoRoots: parseRepoRoots(env.MATRIX_REPO_ROOTS),
  dataDir,
  host: env.MATRIX_NODE_NAME ?? "localhost",
  ...(env.MATRIX_QUOTA ? { quota: parseQuotaEnv(env.MATRIX_QUOTA) } : {}),
  ...(env.MATRIX_GATEWAY_URL && gatewayKeyValue
    ? {
        gateway: {
          baseUrl: `${env.MATRIX_GATEWAY_URL.replace(/\/$/, "")}/v1`,
          apiKey: gatewayKeyValue,
        },
      }
    : {}),
  ...(env.MATRIX_TICK_MS ? { tickMs: Number(env.MATRIX_TICK_MS) } : {}),
  ...(env.MATRIX_MONITOR_MS ? { monitorMs: Number(env.MATRIX_MONITOR_MS) } : {}),
  watch: env.MATRIX_WATCH === "1",
});
if (!env.MATRIX_DATABASE_URL) {
  console.warn("MATRIX_DATABASE_URL not set: using the in-memory store (state is lost on restart)");
}

const control = createServer({
  core: factory.core,
  keys,
  stateDir: dataDir,
  ...(env.MATRIX_AUDIT_FILE ? { auditFile: env.MATRIX_AUDIT_FILE } : {}),
  replayLogFile: env.MATRIX_REPLAY_LOG ?? join(stateOwner.directory, "replay.log"),
  ...(env.MATRIX_DASHBOARD_DIR ? { dashboardDir: env.MATRIX_DASHBOARD_DIR } : {}),
  webhookSecretsFile:
    env.MATRIX_WEBHOOK_SECRETS_FILE ?? join(stateOwner.directory, "webhook-secrets.json"),
  health: () => factory.health(),
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
  serve({ fetch: control.app.fetch, hostname, port }, (info) => {
    console.log(
      `matrix-server listening on http://${info.address}:${info.port} (runtime ${factory.runtime})`,
    );
  });
}
factory.start();

const shutdown = async () => {
  await control.close();
  await factory.stop();
  await stateOwner.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
