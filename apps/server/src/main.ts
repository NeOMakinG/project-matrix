import { serve } from "@hono/node-server";
import { hashToken, KeyStore } from "./auth/keys.js";
import { createServer } from "./http/app.js";
import { MemoryCore } from "./memory-core.js";

const env = process.env;
const host = env.MATRIX_HOST ?? "127.0.0.1";
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

const { app } = createServer({
  core: new MemoryCore(),
  keys,
  ...(env.MATRIX_AUDIT_FILE ? { auditFile: env.MATRIX_AUDIT_FILE } : {}),
  secrets: {
    ...(env.MATRIX_SENTRY_SECRET ? { sentry: env.MATRIX_SENTRY_SECRET } : {}),
    ...(env.MATRIX_GITHUB_SECRET ? { github: env.MATRIX_GITHUB_SECRET } : {}),
    ...(env.MATRIX_POSTHOG_SECRET ? { posthog: env.MATRIX_POSTHOG_SECRET } : {}),
    ...(env.MATRIX_OTEL_SECRET ? { otel: env.MATRIX_OTEL_SECRET } : {}),
    ...(env.MATRIX_ORCA_SECRET ? { orca: env.MATRIX_ORCA_SECRET } : {}),
  },
});

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`matrix-server listening on http://${info.address}:${info.port}`);
});
