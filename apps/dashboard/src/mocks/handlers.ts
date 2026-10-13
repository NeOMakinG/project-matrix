import { delay, HttpResponse, http } from "msw";
import type { ApiKey, ServerPhase, ServerProject } from "@/api/view";
import { makeProgress } from "./data/init";
import { integrations, makeSettings, verification } from "./data/monitor-settings";
import {
  adrs,
  apiKeys,
  approvals,
  graph,
  incidents,
  models,
  orca,
  overviewModel,
  projects,
  receiptsByRun,
  runs,
  tickets,
} from "./data/server";

export const CSRF = "csrf-test-token";

function freshDb() {
  return {
    signedIn: true,
    projects: structuredClone(projects),
    runs: structuredClone(runs),
    keys: structuredClone(apiKeys),
    settings: makeSettings() as Record<string, unknown>,
    settingsVersion: 1,
    initSessions: new Map<string, { projectId: string; answers: Record<string, unknown> }>(),
    approvals: structuredClone(approvals),
    decisions: [] as { id: string; decision: string }[],
    logouts: 0,
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

const sessionBody = () => ({
  csrfToken: CSRF,
  expiresAt: "2026-10-13T00:00:00Z",
  key: {
    id: "k-human",
    name: "valentin laptop",
    kind: "human",
    scope: { projects: "*", actions: ["admin"] },
  },
});

export const sessionHandlers = [
  http.get("*/auth/session", () =>
    db.signedIn ? HttpResponse.json(sessionBody()) : err(401, "unauthorized", "no session"),
  ),
  http.post("*/auth/login", async ({ request }) => {
    const body = (await request.json()) as { token?: string };
    if (!body.token?.startsWith("mx_")) return err(401, "unauthorized", "invalid API key");
    db.signedIn = true;
    return HttpResponse.json(sessionBody(), {
      headers: { "set-cookie": "matrix_session=demo; HttpOnly; SameSite=Strict; Path=/" },
    });
  }),
  http.post("*/auth/logout", ({ request }) => {
    if (request.headers.get("x-csrf-token") !== CSRF) {
      return err(403, "csrf", "missing or invalid CSRF token");
    }
    db.signedIn = false;
    db.logouts += 1;
    return HttpResponse.json({ ok: true });
  }),
];

const byQuery = <T extends { projectId?: string; status: string }>(request: Request, rows: T[]) => {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  const status = url.searchParams.get("status");
  return rows.filter(
    (r) => (!projectId || r.projectId === projectId) && (!status || r.status === status),
  );
};

export const contractHandlers = [
  http.get(`${V1}/overview`, async ({ request }) => {
    await latency();
    return guard(request) ?? HttpResponse.json(overviewModel);
  }),
  http.get(`${V1}/gateway/health`, ({ request }) => guard(request) ?? HttpResponse.json(models)),
  http.get(`${V1}/orca/runtime`, ({ request }) => guard(request) ?? HttpResponse.json(orca)),
  http.get(
    `${V1}/incidents`,
    ({ request }) => guard(request) ?? HttpResponse.json(byQuery(request, incidents)),
  ),
  http.get(
    `${V1}/approvals`,
    ({ request }) => guard(request) ?? HttpResponse.json(byQuery(request, db.approvals)),
  ),
  http.post(`${V1}/approvals/:id/decision`, async ({ request, params }) => {
    const denied = guard(request, true);
    if (denied) return denied;
    const approval = db.approvals.find((a) => a.id === params.id);
    if (!approval) return err(404, "not_found", "No such approval");
    if (approval.status !== "pending")
      return err(409, "already_decided", "Approval already decided");
    const body = (await request.json()) as { decision: "approved" | "rejected" };
    approval.status = body.decision;
    approval.decidedAt = "2026-10-12T11:05:00Z";
    approval.decidedBy = "k-human";
    db.decisions.push({ id: approval.id, decision: body.decision });
    const run = db.runs.find((r) => r.id === approval.runId);
    if (run)
      run.approval = { state: body.decision, approvalId: approval.id, phase: approval.phase };
    return HttpResponse.json(approval);
  }),
  http.get(`${V1}/projects/:projectId/verification`, ({ request, params }) => {
    const denied = guard(request);
    if (denied) return denied;
    return params.projectId === "ledgerly"
      ? HttpResponse.json(verification)
      : err(404, "not_found", "No deploy yet");
  }),
  http.get(
    `${V1}/integrations`,
    ({ request }) => guard(request) ?? HttpResponse.json(integrations),
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
  http.post(`${V1}/projects`, async ({ request }) => {
    const denied = guard(request, true);
    if (denied) return denied;
    const body = (await request.json()) as {
      name: string;
      description: string;
      workspace: "orca" | "native";
    };
    if (db.projects.some((p) => p.name === body.name))
      return err(409, "conflict", "project exists");
    const project = {
      id: `prj_${db.projects.length + 1}`,
      name: body.name,
      description: body.description,
      workspace: body.workspace,
      autonomy: {},
      createdAt: "2026-10-12T12:00:00Z",
    };
    db.projects.push(project);
    return HttpResponse.json(project);
  }),
  // Mirrors the real server: finalize does not exist yet.
  http.post(`${V1}/init/:id/finalize`, () => err(404, "not_found", "Not Found")),
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
    const body = (await request.json()) as { answers: Record<string, unknown> };
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
