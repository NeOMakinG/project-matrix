import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutonomyMode, ProjectPolicySnapshot } from "@matrix/core";
import { sampleAnswers } from "@matrix/packs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createServer } from "../http/app.js";
import { createFactory, type Factory } from "./factory.js";

const databaseUrl = process.env.MATRIX_TEST_DATABASE_URL;
let factory: Factory | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await factory?.stop();
  factory = undefined;
});

describe.each([
  { name: "memory Store (explicit restart reseeding)", postgres: false },
  { name: "real PostgreSQL Store", postgres: true },
])("init policy: $name, fake agent runtime, real generator", ({ postgres }) => {
  async function boot() {
    const dataDir = mkdtempSync(join(tmpdir(), "matrix-init-policy-"));
    const start = async (snapshot?: ProjectPolicySnapshot) => {
      factory = await createFactory({
        runtime: "fake",
        dataDir,
        host: "test-host",
        log: () => undefined,
        ...(postgres ? { databaseUrl: databaseUrl as string } : {}),
      });
      if (snapshot && !postgres) {
        await factory.store.upsertProject(snapshot.project);
        for (const change of snapshot.history) await factory.store.setAutonomy(change);
        await factory.store.upsertProject(snapshot.project);
      }
      return createServer({ core: factory.core, stateDir: dataDir });
    };
    let server = await start();
    const token = server.keys.create({
      name: "policy-test",
      kind: "human",
      scope: { projects: "*", actions: ["admin"] },
    }).token;
    const call = (method: string, path: string, body?: unknown, headers = {}) =>
      server.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const created = await call("POST", "/v1/projects", {
      name: "policy-regression",
      description: "",
      workspace: "native",
      tickets: { kind: "markdown" },
    });
    expect(created.status).toBe(200);
    const project = (await created.json()) as { id: string };
    const session = (await (await call("POST", `/v1/projects/${project.id}/init`)).json()) as {
      id: string;
    };
    expect(
      (
        await call("POST", `/v1/init/${session.id}/answers`, {
          answers: {
            ...sampleAnswers,
            "process.autonomy.merge": "autonomous",
            "process.autonomy.deploy": "autonomous",
            "process.reviewLanes": ["correctness-security", "performance"],
          },
        })
      ).status,
    ).toBe(200);
    const repo = (await factory!.store.getProject(project.id))!.repoPath;
    const finalize = () =>
      call("POST", `/v1/init/${session.id}/finalize`, { acceptRecommended: true });
    const save = async (merge: AutonomyMode, deploy: AutonomyMode) => {
      const current = await call("GET", `/v1/projects/${project.id}`);
      const saved = await call(
        "PUT",
        `/v1/projects/${project.id}/autonomy-policy`,
        { autonomy: { merge, deploy } },
        { "if-match": current.headers.get("etag")! },
      );
      expect(saved.status).toBe(200);
    };
    const assertPolicy = async (merge: AutonomyMode, deploy: AutonomyMode) => {
      const current = await call("GET", `/v1/projects/${project.id}`);
      expect(current.status).toBe(200);
      expect(await current.json()).toMatchObject({ autonomy: { merge, deploy } });
      const config = readFileSync(join(repo, "matrix.config.ts"), "utf8");
      expect(config).toMatch(
        new RegExp(`"?merge"?: "${merge === "gated" ? "gated-auto" : merge}"`),
      );
      expect(config).toMatch(
        new RegExp(`"?deploy"?: "${deploy === "gated" ? "gated-auto" : deploy}"`),
      );
      const answers = JSON.parse(readFileSync(join(repo, ".matrix/answers.json"), "utf8"));
      expect(answers["process.autonomy.merge"]).toBe(merge === "gated" ? "gated-auto" : merge);
      const adr = readdirSync(join(repo, "docs/adr")).find((file) =>
        file.includes("merge-autonomy"),
      )!;
      if (merge === "human")
        expect(readFileSync(join(repo, "docs/adr", adr), "utf8")).toContain(
          "**Human approves** (chosen)",
        );
    };
    const restart = async () => {
      const snapshot = await factory!.store.getProjectPolicy(project.id);
      await factory!.stop();
      server = await start(snapshot);
    };
    const deniedProgress = () => {
      const scoped = server.keys.create({
        name: "other-project",
        kind: "human",
        scope: { projects: ["not-this-project"], actions: ["read"] },
      }).token;
      return call("GET", `/v1/init/${session.id}/progress`, undefined, {
        authorization: `Bearer ${scoped}`,
      });
    };
    return { call, project, session, repo, finalize, save, assertPolicy, restart, deniedProgress };
  }

  test.skipIf(postgres && !databaseUrl)(
    "explicit same-value human PUT wins over interview across retries and restart",
    async () => {
      const context = await boot();
      await context.save("human", "human");
      expect((await context.finalize()).status).toBe(200);
      await context.assertPolicy("human", "human");
      const before = readFileSync(join(context.repo, "matrix.config.ts"), "utf8");
      expect((await context.finalize()).status).toBe(200);
      await context.restart();
      expect((await context.finalize()).status).toBe(200);
      await context.assertPolicy("human", "human");
      expect(readFileSync(join(context.repo, "matrix.config.ts"), "utf8")).toBe(before);
    },
    60_000,
  );

  test.skipIf(postgres && !databaseUrl)(
    "without explicit saves interview initializes policy; legacy completed journal rebases later saves",
    async () => {
      const context = await boot();
      expect((await context.finalize()).status).toBe(200);
      await context.assertPolicy("autonomous", "autonomous");
      const tickets = await factory!.core.listTickets(context.project.id, {});
      await context.save("human", "human");
      const journalPath = `${context.repo}.init.json`;
      const journal = JSON.parse(readFileSync(journalPath, "utf8"));
      delete journal.policyVersion;
      writeFileSync(journalPath, JSON.stringify(journal));
      await context.restart();
      expect((await context.finalize()).status).toBe(200);
      await context.assertPolicy("human", "human");
      expect(
        (await factory!.core.listTickets(context.project.id, {})).map((ticket) => ticket.id),
      ).toEqual(tickets.map((ticket) => ticket.id));
      expect((await context.finalize()).status).toBe(200);
    },
    60_000,
  );

  test.skipIf(postgres && !databaseUrl)(
    "external default and per-phase settings remain authoritative",
    async () => {
      const context = await boot();
      for (const [phase, mode] of [
        ["merge", "gated"],
        ["checks", "human"],
        ["default", "human"],
      ] as const)
        await factory!.store.setAutonomy({
          projectId: context.project.id,
          phase,
          mode,
          actor: "external-human",
          at: new Date(),
        });
      expect((await context.finalize()).status).toBe(200);
      await context.assertPolicy("gated", "human");
      expect(
        (await factory!.store.getProjectPolicy(context.project.id)).project.autonomy.checks,
      ).toBe("human");
    },
    60_000,
  );

  test.skipIf(postgres && !databaseUrl)(
    "concurrent policy save aborts final CAS and pending journal recomputes after restart",
    async () => {
      const context = await boot();
      const store = factory!.store;
      const original = store.saveInitializedProject.bind(store);
      vi.spyOn(store, "saveInitializedProject").mockImplementationOnce(async (...args) => {
        await context.save("human", "human");
        return original(...args);
      });
      expect((await context.finalize()).status).toBe(412);
      expect((await store.getProjectPolicy(context.project.id)).project.autonomy).toMatchObject({
        merge: "human",
        deploy: "human",
      });
      await context.restart();
      expect((await context.finalize()).status).toBe(200);
      await context.assertPolicy("human", "human");
      expect((await context.finalize()).status).toBe(200);
    },
    60_000,
  );

  test.skipIf(postgres && !databaseUrl)(
    "a policy change during generation aborts before publishing files",
    async () => {
      const context = await boot();
      const store = factory!.store;
      const original = store.getProjectPolicy.bind(store);
      vi.spyOn(store, "getProjectPolicy")
        .mockImplementationOnce(original)
        .mockImplementationOnce(async (projectId) => {
          await context.save("human", "human");
          return original(projectId);
        });
      expect((await context.finalize()).status).toBe(412);
      expect(existsSync(join(context.repo, "matrix.config.ts"))).toBe(false);
      expect((await context.finalize()).status).toBe(200);
      await context.assertPolicy("human", "human");
    },
    60_000,
  );

  test.skipIf(postgres && !databaseUrl)(
    "confirmed multiselect descriptors survive refresh and restart without bypassing scope",
    async () => {
      const context = await boot();
      for (const restart of [false, true]) {
        if (restart) await context.restart();
        const response = await context.call("GET", `/v1/init/${context.session.id}/progress`);
        expect(response.status).toBe(200);
        const progress = (await response.json()) as { answered: { questionId: string }[] };
        expect(
          progress.answered.find((question) => question.questionId === "process.reviewLanes"),
        ).toMatchObject({
          id: "process.reviewLanes",
          kind: "multiselect",
          value: "Correctness + security, Performance",
          recommended: ["correctness-security", "architecture-adr", "ux-product", "performance"],
          options: expect.arrayContaining([
            expect.objectContaining({ id: "architecture-adr", recommended: true }),
          ]),
          rationale: expect.any(String),
          dependsOn: [],
        });
        expect(
          progress.answered.find((question) => question.questionId === "process.autonomy.deploy"),
        ).toMatchObject({ dependsOn: ["process.autonomy.merge"], recommended: "gated-auto" });
        expect((await context.deniedProgress()).status).toBe(403);
      }
    },
  );
});
