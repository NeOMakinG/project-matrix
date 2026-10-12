import type { GitPort, HandlerDeps, Workspace } from "@matrix/core";
import { FakeGit, FakeRunner, FakeSandbox, FakeWorkspace, qaEvidence } from "@matrix/core/testing";

export type RuntimeKind = "fake" | "native" | "orca";

/** Everything the reconciler and its phase handlers need to actually run work. */
export interface Runtime {
  kind: RuntimeKind;
  workspace: Workspace;
  git: GitPort;
  deps: Omit<HandlerDeps, "store" | "holdout">;
}

export class RuntimeUnavailableError extends Error {}

export function parseRuntimeKind(value: string | undefined): RuntimeKind {
  const kind = (value ?? "fake").toLowerCase();
  if (kind === "fake" || kind === "native" || kind === "orca") return kind;
  throw new RuntimeUnavailableError(`MATRIX_RUNTIME must be fake, native or orca (got ${value})`);
}

const SCENARIOS = JSON.stringify({
  scenarios: [
    { id: "s1", given: "a visitor", when: "they open the app", then: "they see the home page" },
  ],
});

/**
 * Deterministic runtime for development and end-to-end receipts: runners return canned plans,
 * reviews and QA verdicts, merges and deploys are recorded instead of performed. Nothing leaves the
 * process.
 */
export function fakeRuntime(): Runtime {
  const implementer = new FakeRunner("claude-code", async (req) =>
    req.phase === "implement"
      ? { summary: "implemented (fake runtime)" }
      : { summary: "plan: 3 steps" },
  );
  const reviewer = new FakeRunner("codex", (req) => {
    if (req.prompt.includes("acceptance scenarios")) return { summary: SCENARIOS };
    if (req.phase === "review") return { summary: '{"findings":[]}' };
    if (req.phase === "qa") return { summary: '{"verdicts":[{"id":"s1","satisfied":true}]}' };
    return { summary: "" };
  });
  return {
    kind: "fake",
    workspace: new FakeWorkspace(),
    git: new FakeGit(),
    deps: {
      runners: { "claude-code": implementer, codex: reviewer },
      sandbox: new FakeSandbox(),
      qa: { run: async () => qaEvidence() },
      merge: {
        merge: async (_ctx, request) => ({
          ok: true,
          summary: `merged ${request.headSha.slice(0, 7)} (fake runtime)`,
          url: `https://example.invalid/pr/${request.headSha.slice(0, 7)}`,
        }),
      },
      deploy: { deploy: async () => ({ ok: true, summary: "deployed (fake runtime)" }) },
      verify: {
        verify: async () => [{ kind: "curl", ok: true, summary: "GET / 200 (fake runtime)" }],
      },
    },
  };
}

/**
 * `native` and `orca` come from the runtime packages (PR #4). Until they're on main the switch exists
 * but refuses to start, so a misconfigured server never silently runs the fake runtime.
 */
export function createRuntime(kind: RuntimeKind): Runtime {
  if (kind === "fake") return fakeRuntime();
  throw new RuntimeUnavailableError(
    `MATRIX_RUNTIME=${kind} needs the runtime packages (PR #4); use MATRIX_RUNTIME=fake until it merges`,
  );
}
