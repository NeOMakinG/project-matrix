import { delay, HttpResponse, http } from "msw";
import type { ApiKey, ServerPhase, ServerProject } from "@/api/view";
import { makeProgress } from "./data/init";
import { integrations, makeSettings, monitor } from "./data/monitor-settings";
import { gateway, overview } from "./data/overview";
import { adrs, apiKeys, graph, projects, receiptsByRun, runs, tickets } from "./data/server";

export const CSRF = "csrf-test-token";

function freshDb() {
  return {
    signedIn: true,
    projects: structuredClone(projects),
    runs: structuredClone(runs),
    keys: structuredClone(apiKeys),
    settings: makeSettings() as Record<string, unknown>,
    settingsVersion: 1,
    initSessions: new Map<string, { projectId: string; answers: Record<string, string> }>(),
    approvals: [] as { runId: string; decision: string; commitSha: string }[],
    keySeq: 10,
  };
}

let db = freshDb();
export const mockDb = () => db;
export function resetMockDb(): void {
  db = freshDb();
}

const V1 = "*/v1";
const latency = () => delay(import.meta.env.MODE === "test" ? 0 : 120);
const err = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status });

/** Mirrors the server's planned contract: cookie session + CSRF header on mutations. */
function guard(request: Request, mutating = false): Response | null {
  if (!db.signedIn) return err(401, "unauthorized", "Sign in first");
  if (mutating && request.headers.get("x-csrf-token") !== CSRF)
    return err(403, "csrf", "Missing CSRF token");
  return null;
}

function project(id: string | readonly string[] | undefined): ServerProject | undefined {
  return db.projects.find((p) => p.id === id);
}

export const sessionHandlers = [
  http.get(`${V1}/session`, () =>
    db.signedIn
      ? HttpResponse.json({ user: "valentin", csrfToken: CSRF, expiresAt: "2026-10-13T00:00:00Z" })
      : err(401, "unauthorized", "No session"),
  ),
  http.post(`${V1}/session`, async ({ request }) => {
    const body = (await request.json()) as { apiKey?: string };
    if (!body.apiKey?.startsWith("mx_")) return err(401, "invalid_key", "Unknown API key");
    db.signedIn = true;
    return HttpResponse.json(
      { user: "valentin", csrfToken: CSRF, expiresAt: "2026-10-13T00:00:00Z" },
      { headers: { "set-cookie": "matrix_session=demo; HttpOnly; SameSite=Strict; Path=/" } },
    );
  }),
];

export const contractHandlers = [
  http.get(
    `${V1}/overview`,
    async ({ request }) => guard(request) ?? (await latency(), HttpResponse.json(overview)),
  ),
  http.get(`${V1}/gateway`, ({ request }) => guard(request) ?? HttpResponse.json(gateway)),
  http.get(
    `${V1}/integrations`,
    ({ request }) => guard(request) ?? HttpResponse.json(integrations),
  ),
  http.get(
    `${V1}/projects/:projectId/monitor`,
    ({ request }) => guard(request) ?? HttpResponse.json(monitor),
  ),
  http.get(
    `${V1}/projects/:projectId/checks`,
    ({ request }) =>
      guard(request) ??
      HttpResponse.json({
        ref: "matrix check · main@4e1f0c2",
        violations: [
          {
            level: "error",
            adr: "ADR-0011",
            location: "src/invoices/total.ts:42",
            message: "Float arithmetic on money: amount * 1.2",
            note: "fix ticket MX-161 queued",
          },
          {
            level: "warn",
            adr: "ADR-0013",
            location: "src/portal/ClientList.tsx:9",
            message: "UI imports db/client directly",
            note: "owner: frontend lane",
          },
        ],
      }),
  ),
  http.get(`${V1}/init/:id/progress`, ({ request, params }) => {
    const denied = guard(request);
    if (denied) return denied;
    const session = db.initSessions.get(String(params.id));
    return session
      ? HttpResponse.json(makeProgress(session.answers))
      : err(404, "not_found", "No such session");
  }),
];

export const projectHandlers = [
  http.get(`${V1}/projects`, ({ request }) => guard(request) ?? HttpResponse.json(db.projects)),
  http.get(`${V1}/projects/:projectId`, ({ request, params }) => {
    const p = project(params.projectId);
    return guard(request) ?? (p ? HttpResponse.json(p) : err(404, "not_found", "No such project"));
  }),
  http.get(`${V1}/projects/:projectId/tickets`, async ({ request, params }) => {
    await latency();
    return guard(request) ?? HttpResponse.json(params.projectId === "ledgerly" ? tickets : []);
  }),
  http.put(`${V1}/projects/:projectId/autonomy`, async ({ request, params }) => {
    const denied = guard(request, true);
    if (denied) return denied;
    const p = project(params.projectId);
    if (!p) return err(404, "not_found", "No such project");
    const body = (await request.json()) as {
      phase: ServerPhase;
      mode: "human" | "gated" | "autonomous";
    };
    p.autonomy = { ...p.autonomy, [body.phase]: body.mode };
    return HttpResponse.json(p);
  }),
  http.get(
    `${V1}/projects/:projectId/adrs`,
    ({ request }) => guard(request) ?? HttpResponse.json(adrs),
  ),
  http.get(
    `${V1}/projects/:projectId/graph`,
    ({ request }) => guard(request) ?? HttpResponse.json(graph),
  ),
  http.post(`${V1}/projects/:projectId/init`, ({ request, params }) => {
    const denied = guard(request, true);
    if (denied) return denied;
    const id = `init_${db.initSessions.size + 1}`;
    db.initSessions.set(id, { projectId: String(params.projectId), answers: {} });
    return HttpResponse.json({
      id,
      projectId: String(params.projectId),
      answers: {},
      state: "in_progress",
      createdAt: "2026-10-12T11:00:00Z",
    });
  }),
  http.get(`${V1}/init/:id`, ({ request, params }) => {
    const denied = guard(request);
    if (denied) return denied;
    const s = db.initSessions.get(String(params.id));
    if (!s) return err(404, "not_found", "No such session");
    return HttpResponse.json({
      id: String(params.id),
      projectId: s.projectId,
      answers: s.answers,
      state: makeProgress(s.answers).question ? "in_progress" : "completed",
      createdAt: "2026-10-12T11:00:00Z",
    });
  }),
  http.post(`${V1}/init/:id/answers`, async ({ request, params }) => {
    const denied = guard(request, true);
    if (denied) return denied;
    const s = db.initSessions.get(String(params.id));
    if (!s) return err(404, "not_found", "No such session");
    const body = (await request.json()) as { answers: Record<string, string> };
    s.answers = { ...s.answers, ...body.answers };
    return HttpResponse.json({
      id: String(params.id),
      projectId: s.projectId,
      answers: s.answers,
      state: "in_progress",
      createdAt: "2026-10-12T11:00:00Z",
    });
  }),
];

export const runHandlers = [
  http.get(`${V1}/runs`, async ({ request }) => {
    await latency();
    const projectId = new URL(request.url).searchParams.get("projectId");
    return (
      guard(request) ??
      HttpResponse.json(db.runs.filter((r) => !projectId || r.projectId === projectId))
    );
  }),
  http.get(`${V1}/runs/:id`, async ({ request, params }) => {
    await latency();
    const r = db.runs.find((x) => x.id === params.id);
    return guard(request) ?? (r ? HttpResponse.json(r) : err(404, "not_found", "No such run"));
  }),
  http.get(
    `${V1}/runs/:id/receipts`,
    ({ request, params }) =>
      guard(request) ?? HttpResponse.json(receiptsByRun[String(params.id)] ?? []),
  ),
  http.post(`${V1}/runs/:id/pause`, ({ request, params }) => {
    const denied = guard(request, true);
    if (denied) return denied;
    const r = db.runs.find((x) => x.id === params.id);
    if (!r) return err(404, "not_found", "No such run");
    r.state = "paused";
    return HttpResponse.json(r);
  }),
  http.post(`${V1}/runs/:id/approval`, async ({ request, params }) => {
    const denied = guard(request, true);
    if (denied) return denied;
    const r = db.runs.find((x) => x.id === params.id);
    if (!r) return err(404, "not_found", "No such run");
    const body = (await request.json()) as { decision: string; commitSha: string };
    if (body.commitSha !== r.headSha)
      return err(409, "stale_commit", "Approval is for an older commit");
    db.approvals.push({ runId: r.id, decision: body.decision, commitSha: body.commitSha });
    return HttpResponse.json({
      runId: r.id,
      decision: body.decision,
      commitSha: body.commitSha,
      by: "valentin",
      byKind: "human",
      at: "2026-10-12T11:05:00Z",
    });
  }),
];

const etag = () => `"settings-v${db.settingsVersion}"`;

export const settingsHandlers = [
  http.get(
    `${V1}/settings`,
    ({ request }) =>
      guard(request) ?? HttpResponse.json(db.settings, { headers: { etag: etag() } }),
  ),
  http.patch(`${V1}/settings`, async ({ request }) => {
    const denied = guard(request, true);
    if (denied) return denied;
    const ifMatch = request.headers.get("if-match");
    if (ifMatch && ifMatch !== etag())
      return err(412, "precondition_failed", "Settings changed since you loaded them");
    db.settings = { ...db.settings, ...((await request.json()) as Record<string, unknown>) };
    db.settingsVersion += 1;
    return HttpResponse.json(db.settings, { headers: { etag: etag() } });
  }),
  http.get(`${V1}/keys`, ({ request }) => guard(request) ?? HttpResponse.json(db.keys)),
  http.post(`${V1}/keys`, async ({ request }) => {
    const denied = guard(request, true);
    if (denied) return denied;
    const body = (await request.json()) as Pick<ApiKey, "name" | "kind" | "scope"> & {
      budget?: ApiKey["budget"];
    };
    if (!body.name || body.name.length < 2) return err(400, "invalid", "name too short");
    const key: ApiKey = {
      id: `k${db.keySeq++}`,
      name: body.name,
      kind: body.kind ?? "agent",
      scope: body.scope,
      budget: body.budget ?? {},
      ratePerMinute: 60,
      createdAt: "2026-10-12T11:10:00Z",
    };
    db.keys = [key, ...db.keys];
    return HttpResponse.json({ token: `mx_live_${key.id}_demo_secret`, key });
  }),
  http.delete(`${V1}/keys/:id`, ({ request, params }) => {
    const denied = guard(request, true);
    if (denied) return denied;
    db.keys = db.keys.map((k) =>
      k.id === params.id ? { ...k, revokedAt: "2026-10-12T11:20:00Z" } : k,
    );
    return HttpResponse.json({ ok: true });
  }),
];

export const restHandlers = [
  ...sessionHandlers,
  ...contractHandlers,
  ...projectHandlers,
  ...runHandlers,
  ...settingsHandlers,
];
