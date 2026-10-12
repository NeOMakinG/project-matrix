import { describe, expect, test } from "vitest";
import { type AutonomyMode, PHASES, type Phase } from "./ports.js";
import { AutonomyConflictError, MemoryStore } from "./store.js";
import { testProject } from "./testing/fakes.js";

describe("atomic autonomy policy", () => {
  test("version CAS refuses same-value history changes without any partial policy writes", async () => {
    const store = new MemoryStore();
    await store.upsertProject(testProject({ id: "version", autonomy: { default: "human" } }));
    const before = await store.getProjectPolicy("version");
    await store.setAutonomyPolicy("version", { merge: "human" }, "human:first", before.version);
    const saved = await store.getProjectPolicy("version");
    expect(saved.version).not.toBe(before.version);
    await expect(
      store.setAutonomyPolicy(
        "version",
        { merge: "autonomous", deploy: "autonomous" },
        "human:stale",
        before.version,
      ),
    ).rejects.toBeInstanceOf(AutonomyConflictError);
    expect(await store.getProjectPolicy("version")).toEqual(saved);
  });
  test("init CAS rejects policy ABA and preserves metadata and history atomically", async () => {
    const store = new MemoryStore();
    await store.upsertProject(testProject({ id: "init-cas", autonomy: { default: "human" } }));
    const snapshot = await store.getProjectPolicy("init-cas");
    await store.setAutonomyPolicy("init-cas", { merge: "autonomous" }, "human:external");
    await store.setAutonomyPolicy("init-cas", { merge: "human" }, "human:external");
    const current = await store.getProjectPolicy("init-cas");
    expect(current.version).not.toBe(snapshot.version);
    await expect(
      store.saveInitializedProject(
        { ...snapshot.project, dailyBudgetUsd: 999 },
        { merge: "autonomous", deploy: "autonomous" },
        snapshot.version,
      ),
    ).rejects.toBeInstanceOf(AutonomyConflictError);
    expect(await store.getProjectPolicy("init-cas")).toEqual(current);
  });

  test("applies all phases and history together and refuses stale compare-and-set", async () => {
    const store = new MemoryStore();
    await store.upsertProject(testProject({ id: "p", autonomy: { default: "human" } }));
    const expected = Object.fromEntries(PHASES.map((phase) => [phase, "human"])) as Record<
      Phase,
      AutonomyMode
    >;
    await store.setAutonomyPolicy(
      "p",
      { merge: "gated", deploy: "autonomous" },
      "key:human",
      expected,
    );
    expect((await store.getProject("p"))!.autonomy).toMatchObject({
      merge: "gated",
      deploy: "autonomous",
    });
    expect(await store.autonomyHistory("p")).toHaveLength(2);
    await expect(
      store.setAutonomyPolicy("p", { merge: "human", deploy: "human" }, "key:other", expected),
    ).rejects.toBeInstanceOf(AutonomyConflictError);
    expect(await store.autonomyHistory("p")).toHaveLength(2);
  });
});
