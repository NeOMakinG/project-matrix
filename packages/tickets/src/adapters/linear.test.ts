import { describe, expect, test } from "vitest";
import { fakeLinear } from "../testing/linear-fake";
import { MATRIX_COMMENT_MARKER } from "../types";
import { LinearTicketStore } from "./linear";
import { LinearClient, sanitizeUntrusted } from "./linear-client";

const KEY = `lin_api_${"x".repeat(16)}`;
const make = (fake = fakeLinear()) => ({
  fake,
  store: new LinearTicketStore({
    teamKey: "NEO",
    projectLabel: "project:demo",
    fetch: fake.fetch,
    env: { LINEAR_API_KEY: KEY },
    sleep: async () => {},
  }),
});
const stateOf = (fake: ReturnType<typeof fakeLinear>, id: string) =>
  fake.issues.get(id)?.state.name;

describe("LinearTicketStore", () => {
  test("uploadFile refuses non-evidence files before asking Linear for an upload URL", async () => {
    const { fake, store } = make();
    const a = await store.create({ title: "Alpha", body: "" });
    const html = new TextEncoder().encode("<script>alert(1)</script>");
    await expect(store.uploadFile(a.id, "x.html", "text/html", html)).rejects.toThrow(
      /not allowed/,
    );
    await expect(store.uploadFile(a.id, "x.png", "image/png", html)).rejects.toThrow(
      /not image\/png/,
    );
    expect(fake.calls.some((c) => /upload/i.test(c.op))).toBe(false);
  });

  test("create adds project label, list/get are scoped and paginated", async () => {
    const { fake, store } = make();
    const a = await store.create({
      title: "Alpha",
      body: "first\nline",
      labels: ["web"],
      priority: 1,
    });
    expect(a).toMatchObject({
      id: "NEO-1",
      title: "Alpha",
      body: "first\nline",
      status: "open",
      priority: 1,
    });
    expect(a.labels.sort()).toEqual(["project:demo", "web"]);
    await store.create({ title: "B", body: "" });
    await store.create({ title: "C", body: "" });
    // Another project's issue in the same team stays invisible.
    const other = make(fake).store;
    const foreign = await new LinearTicketStore({
      teamKey: "NEO",
      projectLabel: "project:other",
      fetch: fake.fetch,
      env: { LINEAR_API_KEY: KEY },
    }).create({ title: "Foreign", body: "" });
    expect((await other.list()).map((t) => t.id)).toEqual(["NEO-1", "NEO-2", "NEO-3"]);
    expect(await store.get(foreign.id)).toBeNull();
    expect(await store.get("OTHER-1")).toBeNull();
    expect(await store.get("NEO-999")).toBeNull();
    expect((await store.list({ labels: ["web"] })).map((t) => t.id)).toEqual(["NEO-1"]);
    expect(fake.calls.filter((c) => c.op === "MatrixIssues").length).toBeGreaterThan(1);
    expect(fake.calls.every((c) => c.auth === KEY)).toBe(true);
  });

  test("status updates move columns; blocked keeps the column", async () => {
    const { fake, store } = make();
    const t = await store.create({ title: "T", body: "b" });
    const cases = [
      ["ready", "Ready"],
      ["in_progress", "Implement"],
      ["review", "Review"],
      ["qa", "QA"],
    ] as const;
    for (const [status, column] of cases) {
      expect((await store.update(t.id, { status })).status).toBe(status);
      expect(stateOf(fake, t.id)).toBe(column);
    }
    const blocked = await store.update(t.id, { status: "blocked", phase: "qa" });
    expect(blocked).toMatchObject({ status: "blocked", phase: "qa" });
    expect(stateOf(fake, t.id)).toBe("QA");
    expect((await store.update(t.id, { status: "done", body: "updated" })).status).toBe("done");
    expect(stateOf(fake, t.id)).toBe("Done");
    expect((await store.get(t.id))?.body).toBe("updated");
    await store.update(t.id, { status: "closed" });
    expect(stateOf(fake, t.id)).toBe("Canceled");
  });

  test("an existing label is reused when creating labels is forbidden; a missing one names the fix", async () => {
    const { fake, store } = make();
    const t = await store.create({ title: "T", body: "", labels: ["qa:passed"] });
    fake.labelCreateForbidden = true;
    const creates = () => fake.calls.filter((c) => c.op === "MatrixLabelCreate").length;
    const before = creates();
    await store.removeLabel(t.id, "qa:passed");
    await store.addLabel(t.id, "qa:passed");
    expect((await store.get(t.id))?.labels).toContain("qa:passed");
    expect(creates()).toBe(before);
    await expect(store.addLabel(t.id, "qa:failed")).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining('create label "qa:failed" in team NEO'),
    });
  });

  test("labels patch keeps the project label; assignee resolves a user", async () => {
    const { store } = make();
    const t = await store.create({ title: "T", body: "", labels: ["a"] });
    const u = await store.update(t.id, { labels: ["x"], assignee: "ada" });
    expect(u.labels.sort()).toEqual(["project:demo", "x"]);
    expect(u.assignee).toBe("ada");
    await expect(store.update(t.id, { assignee: "nobody" })).rejects.toThrow(/not found/);
  });

  test("ready = Ready column, project label, no unresolved blockers", async () => {
    const { store } = make();
    const blocker = await store.create({ title: "Blocker", body: "" });
    const blocked = await store.create({ title: "Blocked", body: "" });
    const todo = await store.create({ title: "Todo", body: "" });
    await store.link(blocker.id, blocked.id, "blocks");
    await store.link(blocker.id, blocked.id, "blocks");
    expect((await store.get(blocked.id))?.deps).toEqual([blocker.id]);
    await store.update(blocker.id, { status: "ready" });
    await store.update(blocked.id, { status: "ready" });
    let ready = (await store.ready()).map((t) => t.id);
    expect(ready).toEqual([blocker.id]);
    expect(ready).not.toContain(todo.id);
    await store.update(blocker.id, { status: "done" });
    ready = (await store.ready()).map((t) => t.id);
    expect(ready).toEqual([blocked.id]);
    await store.update(blocked.id, { deps: [] });
    expect((await store.get(blocked.id))?.deps).toEqual([]);
  });

  test("parents, related links and comments", async () => {
    const { fake, store } = make();
    const epic = await store.create({ title: "Epic", body: "" });
    const child = await store.create({ title: "Child", body: "", parent: epic.id });
    expect(child.parent).toBe(epic.id);
    const other = await store.create({ title: "Other", body: "" });
    await store.link(epic.id, other.id, "parent");
    expect((await store.get(other.id))?.parent).toBe(epic.id);
    await store.link(epic.id, other.id, "related");
    await expect(store.comment(child.id, "note")).resolves.toBeUndefined();
    expect(fake.calls.find((c) => c.op === "MatrixComment")?.variables).toMatchObject({
      input: { body: `note\n\n${MATRIX_COMMENT_MARKER}` },
    });
    await expect(store.comment("NEO-999", "x")).rejects.toThrow(/not found/);
  });

  test("untrusted text is stripped of hidden characters on read", async () => {
    const { fake, store } = make();
    const t = await store.create({ title: "x", body: "" });
    const issue = fake.issues.get(t.id);
    if (!issue) throw new Error("missing");
    issue.title = "Fix\u200B bug\u202E";
    issue.description = "do\u2066 this\u{E0041}\u{E0042}\uFEFF";
    const read = await store.get(t.id);
    expect(read?.title).toBe("Fix bug");
    expect(read?.body).toBe("do this");
    expect(sanitizeUntrusted("a\u00ADb\tc\nd\u0007")).toBe("ab\tc\nd");
  });
});

describe("LinearClient", () => {
  test("retries 429 with backoff then succeeds", async () => {
    const fake = fakeLinear();
    const waits: number[] = [];
    fake.queue.push(
      {
        status: 429,
        body: { errors: [{ message: "rate", extensions: { code: "RATELIMITED" } }] },
        headers: { "retry-after": "2" },
      },
      { status: 200, body: { errors: [{ message: "rate", extensions: { code: "RATELIMITED" } }] } },
      { status: 503, body: "busy" },
    );
    const store = new LinearTicketStore({
      teamKey: "NEO",
      projectLabel: "p",
      fetch: fake.fetch,
      env: { LINEAR_API_KEY: KEY },
      sleep: async (ms) => void waits.push(ms),
    });
    expect(await store.list()).toEqual([]);
    expect(waits).toEqual([2000, 1000, 2000]);
  });

  test("errors surface without leaking the key", async () => {
    const fake = fakeLinear();
    fake.queue.push({ status: 401, body: `bad key ${KEY}` });
    const client = new LinearClient({ fetch: fake.fetch, env: { LINEAR_API_KEY: KEY } });
    const error = await client.request("query X { viewer { id } }").catch((e: Error) => e);
    expect(String(error)).toMatch(/HTTP 401/);
    expect(String(error)).not.toContain(KEY);
    fake.queue.push({ status: 429, body: "slow" }, { status: 429, body: "slow" });
    const limited = new LinearClient({
      fetch: fake.fetch,
      env: { LINEAR_API_KEY: KEY },
      maxRetries: 1,
      sleep: async () => {},
    });
    await expect(limited.request("query X { a }")).rejects.toThrow(/429/);
    fake.queue.push({ status: 503, body: "busy" });
    await expect(limited.request("mutation M { a }")).rejects.toThrow(/503/);
    await expect(new LinearClient({ env: {} }).request("query X { a }")).rejects.toThrow(
      /LINEAR_API_KEY/,
    );
    expect(() => new LinearClient({ apiKeyEnv: "lin_api_value" })).toThrow(/env var name/);
    expect(() => new LinearTicketStore({ teamKey: "neo; x", projectLabel: "p" })).toThrow();
  });
});
