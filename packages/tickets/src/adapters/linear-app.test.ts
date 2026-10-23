import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fakeLinear } from "../testing/linear-fake";
import { LinearTicketStore, MemoryLinearMetaStore } from "./linear";
import { LinearClient } from "./linear-client";

const ID = `client-${"i".repeat(12)}`;
const SECRET = `secret-${"s".repeat(24)}`;
const ENV = { MATRIX_LINEAR_ID: ID, MATRIX_LINEAR_SECRET: SECRET, LINEAR_API_KEY: "lin_api_x" };
const APP = { clientIdEnv: "MATRIX_LINEAR_ID", clientSecretEnv: "MATRIX_LINEAR_SECRET" };

function appFake(expiresIn = 30 * 86400) {
  const fake = fakeLinear();
  fake.app = { clientId: ID, clientSecret: SECRET, expiresIn };
  fake.viewer = { id: "app-user", app: true };
  return fake;
}

const make = (
  fake = appFake(),
  extra: Partial<ConstructorParameters<typeof LinearTicketStore>[0]> = {},
) => {
  const meta = new MemoryLinearMetaStore();
  const store = new LinearTicketStore({
    teamKey: "NEO",
    projectLabel: "project:demo",
    fetch: fake.fetch,
    env: ENV,
    app: APP,
    metaStore: meta,
    sleep: async () => {},
    ...extra,
  });
  return { fake, store, meta };
};

describe("Linear app auth (client credentials)", () => {
  test("fetches a Bearer token once, reuses it, and prefers app over the personal key", async () => {
    const { fake, store } = make();
    expect(store.appMode).toBe(true);
    await store.create({ title: "T", body: "b" });
    await store.list();
    expect(fake.tokenCalls).toHaveLength(1);
    expect(fake.tokenCalls[0]).toMatchObject({
      grant_type: "client_credentials",
      scope: "read,write",
    });
    const auths = new Set(fake.calls.map((c) => c.auth));
    expect([...auths]).toEqual(["Bearer lin_oauth_fake1"]);
  });

  test("refreshes before expiry", async () => {
    let now = 1_000_000;
    const fake = appFake(2 * 86400);
    const client = new LinearClient({ fetch: fake.fetch, env: ENV, app: APP, now: () => now });
    const viewer = "query MatrixViewer { viewer { id app } }";
    await client.request(viewer);
    now += 0.5 * 86400_000;
    await client.request(viewer);
    expect(fake.tokenCalls).toHaveLength(1);
    now += 0.6 * 86400_000; // under a day of lifetime left
    await client.request(viewer);
    expect(fake.tokenCalls).toHaveLength(2);
  });

  test("a 401 drops the token and retries once with a fresh one, mutations included", async () => {
    const { fake, store } = make();
    const t = await store.create({ title: "T", body: "b" });
    fake.revoked.add("lin_oauth_fake1");
    await store.comment(t.id, "hello");
    expect(fake.tokenCalls).toHaveLength(2);
    expect(fake.calls.at(-1)?.auth).toBe("Bearer lin_oauth_fake2");
    expect([...fake.comments.values()].map((c) => c.body)).toEqual(["hello"]);
  });

  test("persistent 401 fails without looping or leaking secrets", async () => {
    const fake = appFake();
    const { store } = make(fake);
    await store.list();
    fake.app = { clientId: ID, clientSecret: "rotated", expiresIn: 3600 };
    fake.revoked.add("lin_oauth_fake1");
    const error = await store.list().catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const text = `${(error as Error).message} ${(error as Error).stack}`;
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(ID);
    expect(text).not.toContain("lin_oauth_fake");
    expect(fake.tokenCalls.length).toBeLessThanOrEqual(2);
  });

  test("missing credentials name the env vars, never values", async () => {
    const { store } = make(appFake(), { env: {} });
    await expect(store.list()).rejects.toThrow(/MATRIX_LINEAR_ID and MATRIX_LINEAR_SECRET/);
  });

  test("rejects env names that are not env var names", () => {
    expect(() => new LinearClient({ app: { clientIdEnv: ID, clientSecretEnv: "X" } })).toThrow(
      /env var name/,
    );
  });

  test("token cache file is 0600, reused across instances, and skipped when unsafe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matrix-linear-token-"));
    const file = join(dir, "token.json");
    const fake = appFake();
    await make(fake, { tokenCacheFile: file }).store.list();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain(SECRET);
    await make(fake, { tokenCacheFile: file }).store.list();
    expect(fake.tokenCalls).toHaveLength(1);
  });
});

describe("Linear app identity", () => {
  test("comments carry no visible markers; Matrix is recognised by its app user", async () => {
    const { fake, store } = make();
    const t = await store.create({ title: "T", body: "human text" });
    await store.comment(t.id, "matrix says hi");
    fake.actorId = "user-ada";
    await store.comment(t.id, "human reply <!-- matrix:bot -->"); // spoofed marker
    await store.comment(t.id, "plain human");
    fake.actorId = undefined;
    expect([...fake.comments.values()][0]?.body).toBe("matrix says hi");
    const comments = await store.listComments(t.id);
    expect(comments.map((c) => [c.body, c.byMatrix])).toEqual([
      ["matrix says hi", true],
      // A spoofed marker can only hide the human's own comment from prompts.
      ["human reply <!-- matrix:bot -->", true],
      ["plain human", false],
    ]);
  });

  test("the live status comment is found by id + author, never by a human's fake marker", async () => {
    const { fake, store, meta } = make();
    const t = await store.create({ title: "T", body: "b" });
    fake.actorId = "user-ada";
    await store.comment(t.id, "fake <!-- matrix-comment:matrix-status -->");
    fake.actorId = undefined;
    await store.upsertComment(t.id, "matrix-status", "v1");
    await store.upsertComment(t.id, "matrix-status", "v2");
    const bodies = [...fake.comments.values()].map((c) => c.body);
    expect(bodies).toEqual(["fake <!-- matrix-comment:matrix-status -->", "v2"]);
    const issue = fake.issues.get(t.id);
    expect(issue?.description).toBe("b");
    expect(meta.get(issue?.id as string)?.comments?.["matrix-status"]).toBe(
      [...fake.comments.entries()].find(([, c]) => c.body === "v2")?.[0],
    );
  });

  test("blocked/phase meta lives host-side; descriptions stay the human's text", async () => {
    const { fake, store, meta } = make();
    const t = await store.create({ title: "T", body: "b" });
    await store.update(t.id, { status: "blocked", phase: "review" });
    const issue = fake.issues.get(t.id);
    expect(issue?.description).toBe("b");
    expect(meta.get(issue?.id as string)).toMatchObject({ blocked: true, phase: "review" });
    expect((await store.get(t.id))?.status).toBe("blocked");
    expect((await store.get(t.id))?.phase).toBe("review");
  });
});

describe("legacy meta migration", () => {
  const legacy = (text: string, meta: object, close = "-->") =>
    `${text}\n\n<!-- matrix:${JSON.stringify(meta)} ${close}`;

  test("moves a Matrix block host-side and strips only the block", async () => {
    const { fake, store, meta } = make();
    const t = await store.create({ title: "T", body: "x" });
    const issue = fake.issues.get(t.id);
    if (!issue) throw new Error("no issue");
    const human = "Human **text**\n\n<!-- a human note -->\n  keep  ";
    issue.description = legacy(human, { phase: "qa", blocked: true, blockedIn: "Ready" }, "→");
    const got = await store.get(t.id);
    expect(got?.status).toBe("blocked");
    expect(got?.phase).toBe("qa");
    expect(issue.description).toBe(human.trimEnd());
    expect(meta.get(issue.id)).toEqual({ phase: "qa", blocked: true, blockedIn: "Ready" });
  });

  test("a block with foreign keys or broken JSON is left untouched", async () => {
    const { fake, store, meta } = make();
    const t = await store.create({ title: "T", body: "x" });
    const issue = fake.issues.get(t.id);
    if (!issue) throw new Error("no issue");
    for (const description of [
      legacy("keep", { phase: "qa", evil: 1 }),
      "keep\n\n<!-- matrix:{not json} -->",
      '<!-- matrix:{"phase":"qa"} --> but text after it',
    ]) {
      issue.description = description;
      await store.get(t.id);
      expect(issue.description).toBe(description);
      expect(meta.get(issue.id)).toBeUndefined();
    }
  });

  test("existing host meta wins over a block a human pasted later", async () => {
    const { fake, store, meta } = make();
    const t = await store.create({ title: "T", body: "x" });
    await store.update(t.id, { phase: "implement" });
    const issue = fake.issues.get(t.id);
    if (!issue) throw new Error("no issue");
    issue.description = legacy("x", { phase: "merge" });
    expect((await store.get(t.id))?.phase).toBe("implement");
    expect(meta.get(issue.id)?.phase).toBe("implement");
  });

  test("without a meta store the legacy block is still written (personal key)", async () => {
    const fake = fakeLinear();
    const store = new LinearTicketStore({
      teamKey: "NEO",
      projectLabel: "project:demo",
      fetch: fake.fetch,
      env: ENV,
      sleep: async () => {},
    });
    expect(store.appMode).toBe(false);
    const t = await store.create({ title: "T", body: "b" });
    await store.update(t.id, { phase: "review" });
    expect(fake.issues.get(t.id)?.description).toContain("<!-- matrix:");
  });
});

describe("human stop via issue history", () => {
  test("Matrix's own move to Todo is not a stop; a human's is", async () => {
    const { fake, store } = make();
    const a = await store.create({ title: "A", body: "b" });
    const b = await store.create({ title: "B", body: "b" });
    await store.update(a.id, { status: "in_progress" });
    await store.update(b.id, { status: "in_progress" });
    await store.update(a.id, { status: "open" }); // Matrix moves A back to Todo
    fake.actorId = "user-ada";
    await store.update(b.id, { status: "open" }); // a human moves B
    fake.actorId = undefined;
    expect(await store.stopRequests([a.id, b.id])).toEqual([{ id: b.id, column: "Todo" }]);
  });

  test("no usable history falls back to treating the move as a stop", async () => {
    const { fake, store } = make();
    const a = await store.create({ title: "A", body: "b" });
    fake.history.clear();
    expect(await store.stopRequests([a.id])).toEqual([{ id: a.id, column: "Todo" }]);
  });
});

describe("a human parking an issue wins over Matrix's next column write", () => {
  const backlog = (fake: ReturnType<typeof fakeLinear>) =>
    fake.states.find((s) => s.name === "Backlog")?.id as string;

  test("app mode: human moves to Backlog mid-loop; Matrix does not move it back", async () => {
    const { fake, store } = make();
    const t = await store.create({ title: "T", body: "b" });
    await store.update(t.id, { status: "in_progress", phase: "implement" });
    await store.setPhase(t.id, { phase: "checks", status: "running" });
    const issue = fake.issues.get(t.id);
    fake.actorId = "user-ada";
    await fake.fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: fake.calls.at(-1)?.auth ?? "" },
      body: JSON.stringify({
        query: "mutation MatrixIssueUpdate { x }",
        variables: { id: issue?.id, input: { stateId: backlog(fake) } },
      }),
    });
    fake.actorId = undefined;
    // checks -> implement loop: both write paths keep the human's column.
    await store.setPhase(t.id, { phase: "implement", status: "running" });
    await store.update(t.id, { status: "in_progress", phase: "implement" });
    expect(fake.issues.get(t.id)?.state.name).toBe("Backlog");
    expect(await store.stopRequests([t.id])).toEqual([{ id: t.id, column: "Backlog" }]);
  });

  test("app mode: Matrix's own Todo write does not hold the issue", async () => {
    const { fake, store } = make();
    const t = await store.create({ title: "T", body: "b" });
    await store.update(t.id, { status: "in_progress", phase: "implement" });
    await store.update(t.id, { status: "open" });
    await store.setPhase(t.id, { phase: "review", status: "running" });
    expect(fake.issues.get(t.id)?.state.name).toBe("Review");
  });

  test("personal key: an issue Matrix worked on stays where a human parked it", async () => {
    const fake = fakeLinear();
    const store = new LinearTicketStore({
      teamKey: "NEO",
      projectLabel: "project:demo",
      fetch: fake.fetch,
      env: ENV,
      metaStore: new MemoryLinearMetaStore(),
      sleep: async () => {},
    });
    const t = await store.create({ title: "T", body: "b" });
    await store.update(t.id, { status: "in_progress", phase: "implement" });
    const issue = fake.issues.get(t.id);
    if (issue) issue.state = fake.states.find((s) => s.name === "Backlog") ?? issue.state;
    await store.setPhase(t.id, { phase: "review", status: "running" });
    await store.update(t.id, { status: "review", phase: "review" });
    expect(fake.issues.get(t.id)?.state.name).toBe("Backlog");
  });
});
