import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createServer } from "../http/app.js";
import { nowTs, SECRETS } from "../test-helpers.js";
import { hmacHex } from "../webhooks.js";
import { createFactory, type Factory } from "./factory.js";

let factory: Factory | undefined;
afterEach(async () => {
  await factory?.stop();
  factory = undefined;
});

async function boot() {
  factory = await createFactory({
    runtime: "fake",
    dataDir: mkdtempSync(join(tmpdir(), "matrix-int-")),
    host: "test-host",
    log: () => undefined,
  });
  const server = createServer({ core: factory.core, secrets: SECRETS });
  const human = server.keys.create({
    name: "valentin",
    kind: "human",
    scope: { projects: "*", actions: ["admin"] },
  }).token;
  const call = async (method: string, path: string, body?: unknown) =>
    server.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${human}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T>(response: Response | Promise<Response>) =>
    (await (await response).json()) as T;
  return { factory, server, call, json };
}

/** Ticks the reconciler (and waits for dispatched runs) until `done` holds. */
async function drive(f: Factory, done: () => Promise<boolean>, max = 40) {
  for (let i = 0; i < max; i++) {
    if (await done()) return;
    await f.reconciler.tick();
    await f.reconciler.idle();
  }
  throw new Error("workflow did not reach the expected state");
}

describe("server on the real core (fake runtime)", () => {
  test("project → init → ticket → run → phases → human approval → merge, with SSE events", async () => {
    const { factory: f, call, json } = await boot();
    const project = await json<{ id: string; autonomy: Record<string, string> }>(
      call("POST", "/v1/projects", {
        name: "pilot",
        description: "e2e",
        workspace: "native",
        tickets: { kind: "markdown" },
      }),
    );
    expect(project.autonomy.merge).toBe("human");

    const session = await json<{ id: string }>(call("POST", `/v1/projects/${project.id}/init`));
    const progress = await json<{ question: { id: string; options: { id: string }[] } }>(
      call("GET", `/v1/init/${session.id}/progress`),
    );
    const first = progress.question;
    const answered = await call("POST", `/v1/init/${session.id}/answers`, {
      answers: { [first.id]: first.options[0]?.id ?? "x" },
    });
    expect(answered.status).toBe(200);

    const ticket = await json<{ id: string }>(
      call("POST", `/v1/projects/${project.id}/tickets`, {
        title: "Landing page",
        body: "hero + CTA",
      }),
    );

    const seen: string[] = [];
    const run = await json<{ id: string; phase: string }>(
      call("POST", "/v1/runs", { projectId: project.id, ticketId: ticket.id, phase: "spike" }),
    );
    expect(run.phase).toBe("spike");
    f.bus.subscribe((e) => {
      if (e.type === "run.started") seen.push(e.phase);
    });

    const pending = async () =>
      (
        await json<{ phase: string; status: string }[]>(
          call("GET", `/v1/approvals?projectId=${project.id}&status=pending`),
        )
      ).length > 0;
    await drive(f, pending);
    const [approval] = await json<{ id: string; phase: string }[]>(
      call("GET", `/v1/approvals?projectId=${project.id}&status=pending`),
    );
    expect(approval?.phase).toBe("merge");
    expect(seen).toEqual(expect.arrayContaining(["implement", "checks", "review", "qa"]));

    const decided = await json<{ status: string; decidedByKind: string }>(
      call("POST", `/v1/approvals/${approval?.id}/decision`, { decision: "approved" }),
    );
    expect(decided).toMatchObject({ status: "approved", decidedByKind: "human" });

    await drive(f, async () =>
      (await f.store.listRuns({ projectId: project.id })).some(
        (r) => r.phase === "merge" && r.status === "ok",
      ),
    );
    const runs = await json<{ phase: string; state: string }[]>(
      call("GET", `/v1/runs?projectId=${project.id}`),
    );
    expect(runs.find((r) => r.phase === "merge")?.state).toBe("ok");
  });

  test("a signed monitor webhook becomes a ticket in the project's tracker", async () => {
    const { factory: f, server, call, json } = await boot();
    const project = await json<{ id: string }>(
      call("POST", "/v1/projects", {
        name: "prod",
        description: "",
        workspace: "native",
        tickets: { kind: "markdown" },
      }),
    );
    const issued = await json<{ secret: string; url: string }>(
      call("POST", `/v1/projects/${project.id}/webhooks/sentry/secret`),
    );
    expect(issued.url).toBe(`/hooks/sentry?project=${project.id}`);
    const app = server.app;
    const body = JSON.stringify({
      action: "created",
      data: {
        issue: { id: "4242", title: "TypeError: cannot read 'price' of undefined", level: "error" },
        event: {
          title: "TypeError: cannot read 'price' of undefined",
          level: "error",
          platform: "node",
        },
      },
    });
    const hook = await app.request(`/hooks/sentry?project=${project.id}`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "sentry-hook-signature": hmacHex(issued.secret, body),
        "sentry-hook-timestamp": nowTs(),
      },
    });
    expect(hook.status).toBe(202);

    const result = await f.monitor.tick();
    expect(result[project.id]?.errors).toEqual([]);
    const tickets = await json<{ title: string; labels: string[] }[]>(
      call("GET", `/v1/projects/${project.id}/tickets`),
    );
    expect(tickets.length).toBeGreaterThan(0);
  });
});
