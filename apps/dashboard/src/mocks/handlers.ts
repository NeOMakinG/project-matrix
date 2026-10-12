import { delay, HttpResponse, http } from "msw";
import { sse } from "msw/sse";
import {
  type ApiKey,
  initAnswerSchema,
  newApiKeySchema,
  type Settings,
  settingsSchema,
} from "@/api/schemas";
import { runs, tickets } from "./data/board";
import { makeInitSession } from "./data/init";
import { knowledge } from "./data/knowledge";
import { makeSettings, monitor } from "./data/monitor-settings";
import { gateway, overview, projects } from "./data/overview";
import { liveTail, makeRun } from "./data/run";

function freshDb() {
  return { run: makeRun(), init: makeInitSession(), settings: makeSettings(), keySeq: 5 };
}

let db = freshDb();

export function resetMockDb(): void {
  db = freshDb();
}

const API = "*/api";
const latency = () => delay(import.meta.env.MODE === "test" ? 0 : 120);

function notFound(what: string) {
  return HttpResponse.json({ error: `${what} not found` }, { status: 404 });
}

export const restHandlers = [
  http.get(`${API}/overview`, async () => {
    await latency();
    return HttpResponse.json(overview);
  }),
  http.get(`${API}/gateway`, () => HttpResponse.json(gateway)),
  http.get(`${API}/projects`, () => HttpResponse.json(projects)),
  http.get(`${API}/projects/:id`, ({ params }) => {
    const project = projects.find((p) => p.id === params.id);
    return project ? HttpResponse.json(project) : notFound("project");
  }),
  http.get(`${API}/projects/:id/tickets`, async ({ params }) => {
    await latency();
    return HttpResponse.json(params.id === "ledgerly" ? tickets : []);
  }),
  http.get(`${API}/projects/:id/runs`, async ({ params }) => {
    await latency();
    return HttpResponse.json(params.id === "ledgerly" ? runs : []);
  }),
  http.get(`${API}/runs/:runId`, async ({ params }) => {
    await latency();
    return params.runId === db.run.id ? HttpResponse.json(db.run) : notFound("run");
  }),
  http.post(`${API}/runs/:runId/pause`, () => {
    db.run = { ...db.run, status: db.run.status === "paused" ? "running" : "paused" };
    return HttpResponse.json(db.run);
  }),
  http.post(`${API}/runs/:runId/approval`, async ({ request }) => {
    const body = (await request.json()) as { decision?: string };
    if (body.decision !== "approved" && body.decision !== "changes_requested") {
      return HttpResponse.json({ error: "invalid decision" }, { status: 400 });
    }
    db.run = { ...db.run, merge: { ...db.run.merge, decision: body.decision } };
    return HttpResponse.json(db.run);
  }),
  http.get(`${API}/projects/:id/knowledge`, async () => {
    await latency();
    return HttpResponse.json(knowledge);
  }),
  http.get(`${API}/projects/:id/init`, async () => {
    await latency();
    return HttpResponse.json(db.init);
  }),
  http.post(`${API}/projects/:id/init/answers`, async ({ request }) => {
    const parsed = initAnswerSchema.safeParse(await request.json());
    const question = db.init.question;
    if (!parsed.success || !question || parsed.data.questionId !== question.id) {
      return HttpResponse.json({ error: "invalid answer" }, { status: 400 });
    }
    const option = question.options.find((o) => o.id === parsed.data.optionId);
    if (!option) return HttpResponse.json({ error: "unknown option" }, { status: 400 });
    db.init = {
      ...db.init,
      answersCount: db.init.answersCount + 1,
      answered: [...db.init.answered, { label: "Server data", value: option.label }],
      packs: db.init.packs.map((p) => (p.id === "stack" ? { ...p, answered: p.answered + 1 } : p)),
      question: null,
    };
    return HttpResponse.json(db.init);
  }),
  http.get(`${API}/projects/:id/monitor`, async () => {
    await latency();
    return HttpResponse.json(monitor);
  }),
  http.get(`${API}/projects/:id/settings`, async () => {
    await latency();
    return HttpResponse.json(db.settings);
  }),
  http.put(`${API}/projects/:id/settings`, async ({ request }) => {
    const patch = settingsSchema
      .pick({ autonomy: true, runners: true })
      .safeParse(await request.json());
    if (!patch.success) return HttpResponse.json({ error: "invalid settings" }, { status: 400 });
    db.settings = { ...db.settings, ...patch.data, autonomyNote: "changed just now by you" };
    return HttpResponse.json(db.settings);
  }),
  http.post(`${API}/projects/:id/api-keys`, async ({ request }) => {
    const input = newApiKeySchema.safeParse(await request.json());
    if (!input.success) return HttpResponse.json({ error: "invalid key" }, { status: 400 });
    const id = `k${db.keySeq++}`;
    const suffix = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
    const key: ApiKey = {
      id,
      name: input.data.name,
      prefix: `mxk_…${suffix}`,
      scopes: input.data.scopes,
      budget: input.data.budget ? `$${input.data.budget}/day` : "—",
      status: "active",
    };
    db.settings = { ...db.settings, apiKeys: [key, ...db.settings.apiKeys] };
    return HttpResponse.json({ key, secret: `mxk_live_${id}_${suffix}_demo` });
  }),
  http.post(`${API}/projects/:id/api-keys/:keyId/revoke`, ({ params }) => {
    const apiKeys: Settings["apiKeys"] = db.settings.apiKeys.map((k) =>
      k.id === params.keyId ? { ...k, status: "revoked" } : k,
    );
    db.settings = { ...db.settings, apiKeys };
    return HttpResponse.json(db.settings);
  }),
];

// msw refuses to build SSE handlers where EventSource doesn't exist (jsdom),
// so the stream mock is only registered in real browsers.
export const handlers =
  typeof globalThis.EventSource === "undefined"
    ? restHandlers
    : [
        ...restHandlers,
        sse(`${API}/runs/:runId/events`, async ({ client }) => {
          for (const event of liveTail) {
            await delay(import.meta.env.MODE === "test" ? 0 : 1500);
            client.send({ data: JSON.stringify(event) });
          }
        }),
      ];
