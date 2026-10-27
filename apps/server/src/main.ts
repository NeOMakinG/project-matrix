import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { type CredentialSource, resolveCredential } from "@matrix/sandbox";
import { hashToken, KeyStore } from "./auth/keys.js";
import { createServer } from "./http/app.js";
import { type DeckConfig, DeckLifecycle } from "./integration/deck-lifecycle.js";
import { parseDeployHosts } from "./integration/deploy-plan.js";
import { parseRepoRoots } from "./integration/existing-repo.js";
import { createFactory } from "./integration/factory.js";
import { parseLimitsEnv } from "./integration/host-limits.js";
import { parseQuotaEnv } from "./integration/quota-config.js";
import { parseRunnerHosts } from "./integration/remote-runner.js";
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

// Deck note before coordinated deploys (EagleRay activity log); key read from a 0600 file.
const deckKey = env.MATRIX_DECK_KEY_FILE
  ? readFileSync(env.MATRIX_DECK_KEY_FILE, "utf8").trim()
  : undefined;
const deckNote =
  env.MATRIX_DECK_URL && deckKey
    ? async (summary: string) => {
        const res = await fetch(`${env.MATRIX_DECK_URL?.replace(/\/$/, "")}/activities`, {
          method: "POST",
          headers: { Authorization: `Bearer ${deckKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ scope: "dev", action: "deploying", summary }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`deck note failed: HTTP ${res.status}`);
      }
    : undefined;

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
  ...(env.MATRIX_QA_LANE_CONFIG ? { agentQaLaneConfig: env.MATRIX_QA_LANE_CONFIG } : {}),
  dataDir,
  host: env.MATRIX_NODE_NAME ?? "localhost",
  deployHosts: parseDeployHosts(env.MATRIX_DEPLOY_HOSTS),
  runnerHosts: parseRunnerHosts(env.MATRIX_RUNNER_HOSTS),
  ...(deckNote ? { deckNote } : {}),
  ...(env.MATRIX_LIMITS ? { limits: parseLimitsEnv(env.MATRIX_LIMITS) ?? {} } : {}),
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
  ...(env.MATRIX_CLEANUP_MS !== undefined ? { cleanupMs: Number(env.MATRIX_CLEANUP_MS) } : {}),
  ...(env.MATRIX_CLEANUP_DRY_RUN === "1" ? { cleanupDryRun: true } : {}),
  watch: env.MATRIX_WATCH === "1",
});
if (!env.MATRIX_DATABASE_URL) {
  console.warn("MATRIX_DATABASE_URL not set: using the in-memory store (state is lost on restart)");
}

// Deck lifecycle mirroring: Matrix ticket events → EagleRay deck(s).
// Per-deck keys read from 0600 files; MATRIX_DECK_REPOS maps "owner/repo" → deck name.
if (env.MATRIX_DECK_URL) {
  const deckBaseUrl = env.MATRIX_DECK_URL.replace(/\/$/, "");
  const repoToDeck = new Map<string, string>(
    Object.entries(
      env.MATRIX_DECK_REPOS ? (JSON.parse(env.MATRIX_DECK_REPOS) as Record<string, string>) : {},
    ),
  );
  // Build decks map from available keys.
  const deckKeyFiles: Record<string, string | undefined> = {
    delta: env.MATRIX_DECK_KEY_FILE,
    tj: env.MATRIX_DECK_TJ_KEY_FILE,
    station: env.MATRIX_DECK_STATION_KEY_FILE,
  };
  const decks = new Map<string, DeckConfig>();
  for (const [name, keyFile] of Object.entries(deckKeyFiles)) {
    if (!keyFile) continue;
    try {
      const key = readFileSync(keyFile, "utf8").trim();
      if (key) decks.set(name, { name, url: deckBaseUrl, key });
    } catch {
      console.warn(`deck-lifecycle: could not read key file for deck "${name}": ${keyFile}`);
    }
  }
  if (decks.size > 0 && repoToDeck.size > 0) {
    const lifecycle = new DeckLifecycle({
      bus: factory.bus,
      store: factory.store,
      decks,
      repoToDeck,
      log: (msg) => console.log(msg),
    });
    lifecycle.start();
    console.log(
      `deck-lifecycle: active (${decks.size} deck(s), ${repoToDeck.size} repo mapping(s))`,
    );
    // Register Matrix factory as an agent on startup (idempotent).
    for (const [, deck] of decks) {
      fetch(`${deckBaseUrl}/agents/me`, {
        method: "POST",
        headers: { Authorization: `Bearer ${deck.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Matrix factory", type: "automation" }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
      break; // Register once (first available deck)
    }
  }
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
