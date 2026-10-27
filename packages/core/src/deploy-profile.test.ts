import { describe, expect, test } from "vitest";
import { advance, autonomyFor } from "./machine.js";
import { requiredDeviceSurfaces } from "./manual-qa.js";
import type { ProjectConfig, WorkflowState } from "./types.js";

const base = {
  id: "p",
  autonomy: { default: "human" },
  lastPhase: "merge",
  maxLoops: 3,
  maxAttempts: 3,
  holdoutThreshold: 0.8,
  qa: { surfaces: ["web", "api"], driver: "agent" },
} as unknown as ProjectConfig;
const auto = { ...base, deploy: { merge: "auto", targets: [] } } as ProjectConfig;
const w = { phase: "merge", status: "running", attempt: 0, loops: 0 } as unknown as WorkflowState;
const ok = { ok: true, summary: "merged", receipts: [] };
const backoff = { baseMs: 1, maxMs: 1 };

describe("deploy profile in the state machine", () => {
  test("merge: auto opts merge and deploy into autonomy; other phases unchanged", () => {
    expect(autonomyFor(auto, "merge")).toBe("autonomous");
    expect(autonomyFor(auto, "deploy")).toBe("autonomous");
    expect(autonomyFor(auto, "review")).toBe("human");
    expect(autonomyFor(base, "merge")).toBe("human");
  });

  test("a deploy profile extends an external repo past the merge to deploy then verify", () => {
    expect(advance(w, ok, base, backoff, new Date()).state.status).toBe("done");
    const next = advance(w, ok, auto, backoff, new Date());
    expect(next.state).toMatchObject({ phase: "deploy", status: "pending" });
    const end = advance(
      { ...w, phase: "verify" },
      { ...ok, receipts: [{ kind: "curl", ok: true, summary: "" }] },
      auto,
      backoff,
      new Date(),
    );
    expect(end.state.status).toBe("done");
  });

  test("auto-merge projects still get a web smoke QA on a docs-only diff", () => {
    const ticket = { body: "", labels: [] };
    expect(requiredDeviceSurfaces(base, ticket, ["README.md"])).toEqual([]);
    expect(requiredDeviceSurfaces(auto, ticket, ["README.md"])).toEqual(["web"]);
  });
});
