import { describe, expect, test } from "vitest";
import { APPROVER, createHarness } from "./testing/harness.js";

function withCleaner() {
  const h = createHarness();
  const calls: string[] = [];
  h.git.cleanForChecks = async (workdir) => {
    calls.push(workdir);
    const state = h.git.dirty.get(workdir) ?? "";
    // Untracked/ignored files are removed; modified tracked files are refused.
    if (state.startsWith("M")) throw new Error("worktree has uncommitted changes after clean");
    h.git.dirty.delete(workdir);
    return h.git.headSha(workdir);
  };
  return { h, calls };
}

describe("cleanForChecks (runtime git port, feature-detected)", () => {
  test("checks run on the cleaned tree and bind every gate run to the returned SHA", async () => {
    const { h, calls } = withCleaner();
    await h.setup();
    const t = h.tickets.add("Clean checks");
    h.git.commit(`/tmp/wt/${t.id}-0`, "e".repeat(40));
    await h.drain();
    // Only right before checks: handover never cleans (it would delete agent work).
    expect(calls).toEqual([`/tmp/wt/${t.id}-0`]);
    const runs = await h.store.listRuns({ ticketId: t.id });
    for (const phase of ["checks", "review", "qa", "merge"]) {
      expect(runs.find((r) => r.phase === phase)?.headSha).toBe("e".repeat(40));
    }
    expect(h.merges[0]?.headSha).toBe("e".repeat(40));
  });

  test("uncommitted agent work at handover fails implement with feedback instead of being cleaned", async () => {
    const { h, calls } = withCleaner();
    await h.setup();
    const t = h.tickets.add("Untracked work");
    let call = 0;
    h.deps.runners["claude-code"] = {
      id: "claude-code",
      run: async (req) => {
        if (req.phase === "implement") {
          if (call++ === 0) h.git.dirty.set(req.workdir, "?? src/new-feature.ts");
          else h.git.dirty.delete(req.workdir); // the retry commits it
        }
        return { runId: req.runId, status: "ok", summary: "done", receipts: [], costUsd: 0.01 };
      },
    };
    await h.drain();
    const implement = (await h.store.listRuns({ ticketId: t.id })).filter(
      (r) => r.phase === "implement",
    );
    expect(implement.map((r) => r.status)).toEqual(["failed", "ok"]);
    expect(implement[0]?.summary).toContain("commit your work");
    // The untracked file was never deleted at handover: cleaning only happened before checks.
    expect(calls).toEqual([`/tmp/wt/${t.id}-0`]);
    expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("done");
  });

  test("modified tracked files send the ticket back to implement", async () => {
    const { h } = withCleaner();
    await h.setup();
    const t = h.tickets.add("Modified tracked");
    await h.reconciler.tick(); // spike
    await h.reconciler.idle();
    await h.reconciler.tick(); // implement
    await h.reconciler.idle();
    h.git.dirty.set(`/tmp/wt/${t.id}-0`, "M src/app.ts");
    await h.reconciler.tick(); // checks dispatch → cleanForChecks refuses
    expect(await h.store.getWorkflow("pilot", t.id)).toMatchObject({
      phase: "implement",
      loops: 1,
    });
    expect((await h.store.getWorkflow("pilot", t.id))?.lastError).toContain(
      "cannot clean for checks",
    );
  });

  test("review on a different commit than checks blocks the merge", async () => {
    const { h } = withCleaner();
    const project = { autonomy: { default: "human" as const } };
    Object.assign(h.project, project);
    await h.setup();
    const t = h.tickets.add("Commit mismatch");
    await h.drain();
    const approval = (await h.store.getPendingApproval("pilot", t.id, "merge"))!;
    await h.reconciler.decideApproval(approval.id, "approved", APPROVER);
    const checks = (await h.store.listRuns({ ticketId: t.id })).find((r) => r.phase === "checks")!;
    await h.store.updateRun(checks.id, { headSha: "9".repeat(40) });
    await h.drain();
    expect(h.merges).toHaveLength(0);
    expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("blocked");
  });
});
