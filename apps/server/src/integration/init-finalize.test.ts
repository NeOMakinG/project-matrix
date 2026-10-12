import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleAnswers } from "@matrix/packs";
import { afterEach, describe, expect, test } from "vitest";
import { createServer } from "../http/app.js";
import { createFactory, type Factory } from "./factory.js";

let factory: Factory | undefined;
afterEach(async () => {
  await factory?.stop();
  factory = undefined;
});

async function boot() {
  factory = await createFactory({
    runtime: "fake",
    dataDir: mkdtempSync(join(tmpdir(), "matrix-init-")),
    host: "test-host",
    log: () => undefined,
  });
  const server = createServer({ core: factory.core });
  const token = server.keys.create({
    name: "valentin",
    kind: "human",
    scope: { projects: "*", actions: ["admin"] },
  }).token;
  const call = async (method: string, path: string, body?: unknown) =>
    server.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
  const project = await json<{ id: string }>(
    call("POST", "/v1/projects", {
      name: "pilot",
      description: "",
      workspace: "native",
      tickets: { kind: "markdown" },
    }),
  );
  const session = await json<{ id: string }>(call("POST", `/v1/projects/${project.id}/init`));
  return { factory, call, json, project, session };
}

describe("init interview finalize", () => {
  test("progress returns the full round with kinds, options, recommendations and contradictions", async () => {
    const { call, json, session } = await boot();
    const progress = await json<{
      round: { id: string; kind: string; options: unknown[]; rationale: string }[];
      contradictions: unknown[];
    }>(call("GET", `/v1/init/${session.id}/progress`));
    expect(progress.round.length).toBeGreaterThan(1);
    expect(progress.round[0]).toEqual(
      expect.objectContaining({ kind: expect.any(String), options: expect.any(Array) }),
    );
    expect(Array.isArray(progress.contradictions)).toBe(true);
  });

  test("incomplete answers report what's missing; complete answers generate the project once", async () => {
    const { factory: f, call, json, project, session } = await boot();
    const early = await json<{ result: { status: string; missing: string[] } }>(
      call("POST", `/v1/init/${session.id}/finalize`, {}),
    );
    expect(early.result.status).toBe("missing");
    expect(early.result.missing.length).toBeGreaterThan(0);

    expect(
      (await call("POST", `/v1/init/${session.id}/answers`, { answers: sampleAnswers })).status,
    ).toBe(200);
    const contradictions = await json<unknown[]>(
      call("GET", `/v1/init/${session.id}/contradictions`),
    );
    expect(contradictions.filter((c) => (c as { severity: string }).severity === "error")).toEqual(
      [],
    );

    const done = await json<{
      state: string;
      result: { status: string; files: string[]; tickets: string[]; commit: string };
    }>(call("POST", `/v1/init/${session.id}/finalize`, { acceptRecommended: true }));
    expect(JSON.stringify(done.result).slice(0, 600)).toContain('"status":"ok"');
    expect(done.state).toBe("completed");
    expect(done.result.status).toBe("ok");
    expect(done.result.files).toEqual(expect.arrayContaining(["matrix.config.ts", "CONTEXT.md"]));
    expect(done.result.tickets.length).toBeGreaterThan(0);

    const repo = (await f.store.getProject(project.id))?.repoPath ?? "";
    expect(existsSync(join(repo, "matrix.config.ts"))).toBe(true);
    expect(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim()).toBe(
      done.result.commit,
    );

    // Idempotent: the same result, no second commit.
    const again = await json<{ result: { commit: string } }>(
      call("POST", `/v1/init/${session.id}/finalize`, { acceptRecommended: true }),
    );
    expect(again.result.commit).toBe(done.result.commit);
    const tickets = await json<unknown[]>(call("GET", `/v1/projects/${project.id}/tickets`));
    expect(tickets.length).toBe(done.result.tickets.length);
  }, 60_000);
});
