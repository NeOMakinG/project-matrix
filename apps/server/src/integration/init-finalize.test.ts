import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleAnswers } from "@matrix/packs";
import { afterEach, describe, expect, test, vi } from "vitest";
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
  test("refuses existing files and symlink targets without touching them", async () => {
    const { factory: current, call, json, project, session } = await boot();
    const repo = (await current.store.getProject(project.id))!.repoPath;
    await call("POST", `/v1/init/${session.id}/answers`, { answers: sampleAnswers });
    writeFileSync(join(repo, "README.md"), "owner content\n");
    const refused = await json<{ result: { status: string } }>(
      call("POST", `/v1/init/${session.id}/finalize`, { acceptRecommended: true }),
    );
    expect(refused.result.status).toBe("invalid");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("owner content\n");
    expect(existsSync(join(repo, "matrix.config.ts"))).toBe(false);
    const external = mkdtempSync(join(tmpdir(), "matrix-no-follow-"));
    const config = (await current.store.getProject(project.id))!;
    const link = join(repo, "outside");
    symlinkSync(external, link);
    await current.store.upsertProject({ ...config, repoPath: link });
    expect(
      (await call("POST", `/v1/init/${session.id}/finalize`, { acceptRecommended: true })).status,
    ).toBe(403);
    expect(existsSync(join(external, "matrix.config.ts"))).toBe(false);
  }, 60_000);

  test("unsupported stack is explicit and leaves the target repo untouched", async () => {
    const { factory: current, call, json, project, session } = await boot();
    await call("POST", `/v1/init/${session.id}/answers`, {
      answers: { ...sampleAnswers, "frontend.framework": "other", "frontend.name": "svelte" },
    });
    const result = await json<{ result: { status: string; issues: { path: string }[] } }>(
      call("POST", `/v1/init/${session.id}/finalize`, { acceptRecommended: true }),
    );
    expect(result.result.status).toBe("invalid");
    expect(result.result.issues.some((issue) => issue.path === "stack")).toBe(true);
    expect(
      existsSync(join((await current.store.getProject(project.id))!.repoPath, "matrix.config.ts")),
    ).toBe(false);
  }, 60_000);

  test("a partial finalize failure resumes its durable generation plan without overwrites", async () => {
    const { factory: current, call, json, project, session } = await boot();
    await call("POST", `/v1/init/${session.id}/answers`, { answers: sampleAnswers });
    const fault = vi
      .spyOn(current.store, "saveInitializedProject")
      .mockRejectedValueOnce(new Error("injected store failure"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(
        (await call("POST", `/v1/init/${session.id}/finalize`, { acceptRecommended: true })).status,
      ).toBe(500);
    } finally {
      consoleError.mockRestore();
      fault.mockRestore();
    }
    const repo = (await current.store.getProject(project.id))!.repoPath;
    const before = readFileSync(join(repo, "matrix.config.ts"), "utf8");
    const retried = await json<{ state: string; result: { status: string } }>(
      call("POST", `/v1/init/${session.id}/finalize`, { acceptRecommended: true }),
    );
    expect(retried).toMatchObject({ state: "completed", result: { status: "ok" } });
    expect(readFileSync(join(repo, "matrix.config.ts"), "utf8")).toBe(before);
  }, 60_000);

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
