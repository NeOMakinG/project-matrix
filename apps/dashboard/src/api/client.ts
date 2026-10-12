import type { z } from "zod";
import {
  createdApiKeySchema,
  gatewaySchema,
  type InitAnswer,
  initSessionSchema,
  knowledgeSchema,
  monitorSchema,
  type NewApiKey,
  overviewSchema,
  projectSchema,
  runSchema,
  runSummarySchema,
  type Settings,
  settingsSchema,
  ticketSchema,
} from "./schemas";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const base = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export function apiUrl(path: string): string {
  return `${base}/api${path}`;
}

async function request<T extends z.ZodType>(
  schema: T,
  path: string,
  init?: RequestInit,
): Promise<z.infer<T>> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text || res.statusText);
  }
  return schema.parse(await res.json());
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const api = {
  overview: () => request(overviewSchema, "/overview"),
  gateway: () => request(gatewaySchema, "/gateway"),
  projects: () => request(projectSchema.array(), "/projects"),
  project: (id: string) => request(projectSchema, `/projects/${id}`),
  tickets: (projectId: string) => request(ticketSchema.array(), `/projects/${projectId}/tickets`),
  runs: (projectId: string) => request(runSummarySchema.array(), `/projects/${projectId}/runs`),
  run: (runId: string) => request(runSchema, `/runs/${runId}`),
  pauseRun: (runId: string) => request(runSchema, `/runs/${runId}/pause`, json({})),
  decideMerge: (runId: string, decision: "approved" | "changes_requested") =>
    request(runSchema, `/runs/${runId}/approval`, json({ decision })),
  knowledge: (projectId: string) => request(knowledgeSchema, `/projects/${projectId}/knowledge`),
  initSession: (projectId: string) => request(initSessionSchema, `/projects/${projectId}/init`),
  answerInit: (projectId: string, answer: InitAnswer) =>
    request(initSessionSchema, `/projects/${projectId}/init/answers`, json(answer)),
  monitor: (projectId: string) => request(monitorSchema, `/projects/${projectId}/monitor`),
  settings: (projectId: string) => request(settingsSchema, `/projects/${projectId}/settings`),
  saveSettings: (projectId: string, settings: Pick<Settings, "autonomy" | "runners">) =>
    request(settingsSchema, `/projects/${projectId}/settings`, {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  createApiKey: (projectId: string, input: NewApiKey) =>
    request(createdApiKeySchema, `/projects/${projectId}/api-keys`, json(input)),
  revokeApiKey: (projectId: string, keyId: string) =>
    request(settingsSchema, `/projects/${projectId}/api-keys/${keyId}/revoke`, json({})),
};
