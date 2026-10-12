import type { Action, KeyBudget } from "./auth/keys.js";
import { createServer } from "./http/app.js";
import { MemoryCore } from "./memory-core.js";
import type { WebhookSecrets } from "./webhooks.js";

export const AGENT = { keyId: "test-agent", kind: "agent" } as const;

export const SECRETS: WebhookSecrets = {
  sentry: "sentry-test-secret",
  github: "github-test-secret",
  posthog: "posthog-test-secret",
  otel: "otel-test-secret",
  orca: "orca-test-secret",
};

export async function setup(clock?: () => number) {
  const core = new MemoryCore();
  const server = createServer({ core, secrets: SECRETS, ...(clock ? { clock } : {}) });
  const admin = server.keys.create({
    name: "admin",
    scope: { projects: "*", actions: ["admin"] },
  }).token;

  const call = async (token: string | null, method: string, path: string, body?: unknown) =>
    server.app.request(path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

  const project = await json<{ id: string }>(
    await call(admin, "POST", "/v1/projects", { name: "pilot", description: "test" }),
  );
  const other = await json<{ id: string }>(
    await call(admin, "POST", "/v1/projects", { name: "other" }),
  );

  const key = (
    actions: Action[],
    projects: "*" | string[] = [project.id],
    budget?: KeyBudget,
    ratePerMinute?: number,
  ) =>
    server.keys.create({
      name: actions.join("+"),
      scope: { projects, actions },
      ...(budget ? { budget } : {}),
      ...(ratePerMinute ? { ratePerMinute } : {}),
    }).token;

  return { core, server, admin, call, json, project, other, key };
}
