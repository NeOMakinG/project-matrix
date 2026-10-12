import { describe, expect, test } from "vitest";
import { createHarness } from "./testing/harness.js";

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
    // Once at implement handover, once right before checks.
    expect(calls).toEqual([`/tmp/wt/${t.id}-0`, `/tmp/wt/${t.id}-0`]);
    const runs = await h.store.listRuns({ ticketId: t.id });
    for (const phase of ["checks", "review", "qa", "merge"]) {
      expect(runs.find((r) => r.phase === phase)?.headSha).toBe("e".repeat(40));
    }
    expect(h.merges[0]?.headSha).toBe("e".repeat(40));
  });

  test("untracked build artifacts are cleaned instead of bouncing the ticket", async () => {
    const { h } = withCleaner();
    await h.setup();
    const t = h.tickets.add("Artifacts");
    let leftArtifacts = false;
    h.deps.runners["claude-code"] = {
      id: "claude-code",
      run: async (req) => {
        if (req.phase === "implement" && !leftArtifacts) {
          leftArtifacts = true;
          // Committed work, plus an untracked build directory the implementer left behind.
          h.git.dirty.set(req.workdir, "?? dist/");
        }
        return { runId: req.runId, status: "ok", summary: "done", receipts: [], costUsd: 0.01 };
      },
    };
    await h.drain();
    // Implement is retried once (it handed over an untracked file), then checks clean any leftovers.
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
    await h.reconciler.decideApproval(approval.id, "approved", "user:valentin");
    const checks = (await h.store.listRuns({ ticketId: t.id })).find((r) => r.phase === "checks")!;
    await h.store.updateRun(checks.id, { headSha: "9".repeat(40) });
    await h.drain();
    expect(h.merges).toHaveLength(0);
    expect((await h.store.getWorkflow("pilot", t.id))?.status).toBe("blocked");
  });
});
