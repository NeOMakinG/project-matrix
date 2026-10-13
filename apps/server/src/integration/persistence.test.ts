import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleAnswers } from "@matrix/packs";
import { afterEach, describe, expect, test } from "vitest";
import { createServer } from "../http/app.js";
import { nowTs } from "../test-helpers.js";
import { hmacHex } from "../webhooks.js";
import { createFactory, type Factory } from "./factory.js";

const databaseUrl = process.env.MATRIX_TEST_DATABASE_URL;
let factory: Factory | undefined;
afterEach(async () => {
  await factory?.stop();
  factory = undefined;
});

describe.each([
  { name: "private state (memory project index explicitly reseeded)", postgres: false },
  { name: "real PostgreSQL restart", postgres: true },
])("$name, fake agent runtime", ({ postgres }) => {
  test.skipIf(postgres && !databaseUrl)(
    "init finalize, keys, sessions, CSRF and monitor survive restart",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "matrix-restart-"));
      const boot = () =>
        createFactory({
          runtime: "fake",
          dataDir,
          host: "test-host",
          ...(postgres ? { databaseUrl: databaseUrl! } : {}),
          log: () => undefined,
        });
      factory = await boot();
      let server = createServer({
        core: factory.core,
        stateDir: dataDir,
        webhookSecretsFile: join(dataDir, "webhook-secrets.json"),
      });
      const { token } = server.keys.create({
        name: "human",
        kind: "human",
        scope: { projects: "*", actions: ["admin"] },
      });
      const call = (
        method: string,
        path: string,
        body?: unknown,
        extra: Record<string, string> = {},
      ) =>
        server.app.request(path, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...extra,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const create = () =>
        call(
          "POST",
          "/v1/projects",
          {
            name: "restart-pilot",
            description: "",
            workspace: "native",
            tickets: { kind: "markdown" },
          },
          { "idempotency-key": "restart-create-0001" },
        );
      const created = await create();
      expect(created.status).toBe(200);
      const project = (await created.json()) as { id: string };
      const config = await factory.store.getProject(project.id);
      const session = (await (await call("POST", `/v1/projects/${project.id}/init`)).json()) as {
        id: string;
      };
      expect(
        (await call("POST", `/v1/init/${session.id}/answers`, { answers: sampleAnswers })).status,
      ).toBe(200);
      const login = await server.app.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const { csrfToken } = (await login.json()) as { csrfToken: string };
      await factory.stop();
      factory = await boot();
      if (!postgres) await factory.store.upsertProject(config!);
      server = createServer({
        core: factory.core,
        stateDir: dataDir,
        webhookSecretsFile: join(dataDir, "webhook-secrets.json"),
      });
      expect((await call("GET", `/v1/projects/${project.id}`)).status).toBe(200);
      expect(((await (await create()).json()) as { id: string }).id).toBe(project.id);
      expect(
        (await server.app.request("/v1/projects", { headers: { authorization: "Bearer invalid" } }))
          .status,
      ).toBe(401);
      expect((await server.app.request("/v1/projects", { headers: { cookie } })).status).toBe(200);
      expect(
        (
          await server.app.request(`/v1/init/${session.id}/finalize`, {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(403);
      const finalize = () =>
        server.app.request(`/v1/init/${session.id}/finalize`, {
          method: "POST",
          headers: { cookie, "x-csrf-token": csrfToken, "content-type": "application/json" },
          body: JSON.stringify({ acceptRecommended: true }),
        });
      const results = await Promise.all([finalize(), finalize()]);
      expect(results.map((response) => response.status)).toEqual([200, 200]);
      const completed = (await results[0]!.json()) as { state: string; result: { commit: string } };
      expect(completed.state).toBe("completed");
      expect(((await results[1]!.json()) as typeof completed).result.commit).toBe(
        completed.result.commit,
      );
      const secret = (await (
        await call("POST", `/v1/projects/${project.id}/webhooks/sentry/secret`)
      ).json()) as { secret: string };
      const body = JSON.stringify({
        action: "created",
        data: {
          issue: { id: "4242", title: "TypeError: cannot read price", level: "error" },
          event: { title: "TypeError: cannot read price", level: "error", platform: "node" },
        },
      });
      expect(
        (
          await server.app.request(`/hooks/sentry?project=${project.id}`, {
            method: "POST",
            body,
            headers: {
              "content-type": "application/json",
              "sentry-hook-signature": hmacHex(secret.secret, body),
              "sentry-hook-timestamp": nowTs(),
            },
          })
        ).status,
      ).toBe(202);
      const generatedConfig = await factory.store.getProject(project.id);
      await factory.stop();
      factory = await boot();
      if (!postgres) await factory.store.upsertProject(generatedConfig!);
      server = createServer({
        core: factory.core,
        stateDir: dataDir,
        webhookSecretsFile: join(dataDir, "webhook-secrets.json"),
      });
      const retried = await call("POST", `/v1/init/${session.id}/finalize`, {
        acceptRecommended: true,
      });
      expect(retried.status).toBe(200);
      expect(((await retried.json()) as typeof completed).result.commit).toBe(
        completed.result.commit,
      );
      expect((await factory.monitor.tick())[project.id]?.errors).toEqual([]);
      const ticketCount = (await factory.core.listTickets(project.id, {})).length;
      expect(
        (await factory.core.listIncidents({ projectId: project.id }))[0]?.ticketId,
      ).toBeTruthy();
      await factory.stop();
      factory = await boot();
      if (!postgres) await factory.store.upsertProject(generatedConfig!);
      expect((await factory.monitor.tick())[project.id]?.errors).toEqual([]);
      expect((await factory.core.listTickets(project.id, {})).length).toBe(ticketCount);
    },
    60_000,
  );
});
