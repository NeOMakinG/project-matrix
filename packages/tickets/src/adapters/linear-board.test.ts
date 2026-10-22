import { describe, expect, test } from "vitest";
import { fakeLinear } from "../testing/linear-fake";
import { LinearTicketStore } from "./linear";
import { readBody } from "./linear-mapping";

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
const bodies = (fake: ReturnType<typeof fakeLinear>) =>
  [...fake.comments.values()].map((c) => c.body.split("\n\n<!--")[0]);
const column = (fake: ReturnType<typeof fakeLinear>, id: string) => fake.issues.get(id)?.state.name;

describe("LinearTicketStore board columns", () => {
  test("setPhase maps each phase to its column", async () => {
    const { fake, store } = make();
    const t = await store.create({ title: "T", body: "b" });
    const cases = [
      ["spike", "running", "Spike"],
      ["design", "running", "Implement"],
      ["implement", "running", "Implement"],
      ["checks", "running", "Implement"],
      ["review", "running", "Review"],
      ["qa", "waiting_approval", "QA"],
      ["merge", "running", "Awaiting merge"],
      ["merge", "waiting_approval", "Awaiting merge"],
      ["merge", "done", "Done"],
    ] as const;
    for (const [phase, status, expected] of cases) {
      await store.setPhase(t.id, { phase, status });
      expect(column(fake, t.id)).toBe(expected);
    }
  });

  test("pending, blocked and unknown phases keep the column; terminal issues stay put", async () => {
    const { fake, store } = make();
    const t = await store.create({ title: "T", body: "b" });
    await store.setPhase(t.id, { phase: "review", status: "running" });
    const writes = () => fake.calls.filter((c) => c.op === "MatrixIssueUpdate").length;
    const before = writes();
    await store.setPhase(t.id, { phase: "implement", status: "pending" });
    await store.setPhase(t.id, { phase: "implement", status: "blocked" });
    await store.setPhase(t.id, { phase: "deploy", status: "running" });
    await store.setPhase(t.id, { phase: "constructor", status: "running" });
    await store.setPhase(t.id, { phase: "review", status: "running" }); // already there
    expect(writes()).toBe(before);
    expect(column(fake, t.id)).toBe("Review");
    await store.update(t.id, { status: "closed" });
    await store.setPhase(t.id, { phase: "qa", status: "running" });
    expect(column(fake, t.id)).toBe("Canceled");
  });

  test("phase-aware update agrees with setPhase; coarse update without phase is unchanged", async () => {
    const { fake, store } = make();
    const t = await store.create({ title: "T", body: "b" });
    const spike = await store.update(t.id, { status: "in_progress", phase: "spike" });
    expect(column(fake, t.id)).toBe("Spike");
    expect(spike).toMatchObject({ status: "in_progress", phase: "spike" });
    await store.update(t.id, { status: "in_progress", phase: "checks" });
    expect(column(fake, t.id)).toBe("Implement");
    await store.update(t.id, { status: "review", phase: "review" });
    expect(column(fake, t.id)).toBe("Review");
    await store.update(t.id, { status: "in_progress" });
    expect(column(fake, t.id)).toBe("Implement");
    await store.update(t.id, { status: "done", phase: "merge" });
    expect(column(fake, t.id)).toBe("Done");
  });

  test("custom phase columns override defaults", async () => {
    const fake = fakeLinear();
    const store = new LinearTicketStore({
      teamKey: "NEO",
      projectLabel: "project:demo",
      fetch: fake.fetch,
      env: { LINEAR_API_KEY: KEY },
      phaseColumns: { spike: "Implement" },
    });
    const t = await store.create({ title: "T", body: "" });
    await store.setPhase(t.id, { phase: "spike", status: "running" });
    expect(column(fake, t.id)).toBe("Implement");
  });
});

describe("LinearTicketStore live comment", () => {
  test("creates once, then edits in place; id survives other updates", async () => {
    const { fake, store } = make();
    const t = await store.create({ title: "T", body: "keep me" });
    await store.upsertComment(t.id, "status", "v1");
    await store.update(t.id, { status: "in_progress", phase: "implement", body: "edited" });
    await store.upsertComment(t.id, "status", "v2");
    await store.upsertComment(t.id, "status", "v3");
    expect(bodies(fake)).toEqual(["v3"]);
    expect(fake.calls.filter((c) => c.op === "MatrixComment")).toHaveLength(1);
    const issue = fake.issues.get(t.id);
    const { text, meta } = readBody(issue?.description ?? null);
    expect(text).toBe("edited");
    expect(meta).toMatchObject({ phase: "implement", comments: { status: expect.any(String) } });
    expect((await store.get(t.id))?.body).toBe("edited");
  });

  test("a deleted comment is recreated; keys are validated", async () => {
    const { fake, store } = make();
    const t = await store.create({ title: "T", body: "" });
    await store.upsertComment(t.id, "status", "v1");
    fake.comments.clear();
    await store.upsertComment(t.id, "status", "v2");
    expect(bodies(fake)).toEqual(["v2"]);
    await expect(store.upsertComment(t.id, "Bad Key", "x")).rejects.toThrow(/invalid comment key/);
  });

  test("forged comment ids in the description are ignored", async () => {
    const { fake, store } = make();
    const t = await store.create({ title: "T", body: "" });
    const issue = fake.issues.get(t.id);
    if (issue) issue.description = `x\n\n<!-- matrix:{"comments":{"status":"../../evil id"}} -->`;
    await store.upsertComment(t.id, "status", "v1");
    expect(fake.calls.some((c) => c.op === "MatrixCommentUpdate")).toBe(false);
    expect(fake.comments.size).toBe(1);
  });

  test("another issue's or a human's comment id is never edited", async () => {
    const { fake, store } = make();
    const a = await store.create({ title: "A", body: "" });
    const b = await store.create({ title: "B", body: "" });
    await store.upsertComment(a.id, "status", "a1");
    const [aId] = [...fake.comments.keys()];
    fake.comments.set("human-1", { issueId: "uuid-2", body: "mine", isMe: false });
    for (const forged of [aId, "human-1"]) {
      const issue = fake.issues.get(b.id);
      if (issue) issue.description = `x\n\n<!-- matrix:{"comments":{"status":"${forged}"}} -->`;
      await store.upsertComment(b.id, "status", "b1");
    }
    expect(fake.comments.get(aId as string)?.body).toContain("a1");
    expect(fake.comments.get("human-1")?.body).toBe("mine");
  });

  test("a lost id (description write failed) is recovered by marker, not duplicated", async () => {
    const { fake, store } = make();
    const t = await store.create({ title: "T", body: "" });
    const realFetch = fake.fetch;
    let failDescription = true;
    fake.fetch = async (url, init) => {
      if (failDescription && init.body.includes("MatrixIssueUpdate")) {
        failDescription = false;
        return realFetch(url, { ...init, body: init.body.replace("MatrixIssueUpdate", "Nope") });
      }
      return realFetch(url, init);
    };
    const flaky = new LinearTicketStore({
      teamKey: "NEO",
      projectLabel: "project:demo",
      fetch: (u, i) => fake.fetch(u, i),
      env: { LINEAR_API_KEY: KEY },
      sleep: async () => {},
    });
    await expect(flaky.upsertComment(t.id, "status", "v1")).rejects.toThrow();
    await flaky.upsertComment(t.id, "status", "v2");
    await flaky.upsertComment(t.id, "status", "v3");
    expect(bodies(fake)).toEqual(["v3"]);
  });

  test("boards without a phase column fall back to the coarse column", async () => {
    const fake = fakeLinear();
    fake.states.splice(
      fake.states.findIndex((s) => s.name === "Spike"),
      1,
    );
    const { store } = make(fake);
    const t = await store.create({ title: "T", body: "" });
    await store.update(t.id, { status: "in_progress", phase: "spike" });
    expect(column(fake, t.id)).toBe("Implement");
    await store.setPhase(t.id, { phase: "spike", status: "running" });
    expect(column(fake, t.id)).toBe("Implement");
  });

  test("a phase start does not reopen an issue a human canceled", async () => {
    const { fake, store } = make();
    const t = await store.create({ title: "T", body: "" });
    await store.update(t.id, { status: "closed" });
    await store.update(t.id, { status: "in_progress", phase: "implement" });
    expect(column(fake, t.id)).toBe("Canceled");
    await store.update(t.id, { status: "done" });
    expect(column(fake, t.id)).toBe("Done");
  });

  test("ensureScope creates the project label once", async () => {
    const { fake, store } = make();
    await store.ensureScope();
    await store.ensureScope();
    expect(fake.calls.filter((c) => c.op === "MatrixLabelCreate")).toHaveLength(1);
    expect(fake.calls.find((c) => c.op === "MatrixLabelCreate")?.variables).toMatchObject({
      input: { name: "project:demo", teamId: "team-1" },
    });
  });
});
