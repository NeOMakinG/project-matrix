import { mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRequest } from "@matrix/core";
import { OrcaCli, TrustedWorktrees } from "@matrix/workspace";
import { FakeOrca } from "@matrix/workspace/testing";
import { expect, test } from "vitest";
import { orcaBridge, trustedTicketWorktree } from "./orca-runtime.js";

test("one Orca Run per ticket worktree; phases yield receipts with Orca refs", async () => {
  const fake = new FakeOrca();
  const dataDir = await mkdtemp(join(tmpdir(), "matrix-orca-bridge-"));
  const workdir = await realpath(await mkdtemp(join(tmpdir(), "matrix-orca-bridge-wt-")));
  const bridge = orcaBridge({
    dataDir,
    pollMs: 20,
    cli: new OrcaCli({ binary: "/usr/bin/true", executor: fake.executor() }),
    isTicketWorktree: async (path) => path === workdir,
  });
  const req = (phase: RunRequest["phase"]): RunRequest => ({
    runId: `run-${phase}`,
    projectId: "demo",
    ticketId: "NEO-12",
    phase,
    runner: "codex",
    model: "gpt-6-sol",
    prompt: "",
    workdir,
    timeoutMs: 10_000,
  });
  for (const phase of ["spike", "review"] as const) {
    const p = await bridge.phase(req(phase));
    if (!p) throw new Error("expected an Orca phase");
    const outcome = await p.launcher(
      { cmd: ["true"], cwd: workdir, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 },
      () => {},
      new AbortController().signal,
    );
    expect(outcome.exitCode).toBe(0);
    const [receipt] = await p.receipts();
    expect(receipt).toMatchObject({
      kind: "log",
      ok: true,
      data: { orca: { run: expect.stringMatching(/^run_/), outcome: "succeeded" } },
    });
    expect((await stat(receipt?.path ?? "")).mode & 0o777).toBe(0o600);
  }
  const runs = fake.calls.filter((c) => c[1] === "run-create");
  expect(runs).toHaveLength(1);
  expect(runs[0]).toContain("NEO-12 · demo");
  const titles = fake.calls
    .filter((c) => c[0] === "terminal" && c[1] === "create")
    .map((c) => c[c.indexOf("--title") + 1]);
  expect(titles).toEqual(["matrix:NEO-12 · demo", "spike · gpt-6-sol", "review · gpt-6-sol"]);
  await bridge.release(workdir);
  expect(fake.closed.size).toBe(3);
});

test("a paired remote Orca environment is refused (host-local scripts)", () => {
  expect(() =>
    orcaBridge({ dataDir: "/tmp", environment: "Bosgame", isTicketWorktree: async () => true }),
  ).toThrow(/local Orca/);
});

test("private QA scratch workdirs never reach Orca (native runner, holdout stays private)", async () => {
  const fake = new FakeOrca();
  const dataDir = await mkdtemp(join(tmpdir(), "matrix-orca-scratch-"));
  const worktree = await realpath(await mkdtemp(join(tmpdir(), "matrix-orca-scratch-wt-")));
  const scratch = join(dataDir, "scratch", "run-1-abc");
  const bridge = orcaBridge({
    dataDir,
    pollMs: 20,
    cli: new OrcaCli({ binary: "/usr/bin/true", executor: fake.executor() }),
    isTicketWorktree: async (path) => path === worktree,
  });
  const base: RunRequest = {
    runId: "run-1",
    projectId: "demo",
    ticketId: "NEO-7",
    phase: "spike",
    runner: "claude-code",
    model: "claude-sonnet-5-5",
    prompt: "holdout",
    workdir: scratch,
    readOnly: true,
    timeoutMs: 10_000,
  };
  expect(await bridge.phase(base)).toBeUndefined();
  expect(await bridge.phase({ ...base, phase: "qa" })).toBeUndefined();
  expect(fake.calls).toEqual([]);
  expect(await bridge.phase({ ...base, workdir: worktree })).toBeDefined();
});

test("retries and server restarts reuse the ticket's Orca Run (run-use), never a new one", async () => {
  const fake = new FakeOrca();
  const dataDir = await mkdtemp(join(tmpdir(), "matrix-orca-reuse-"));
  const workdir = await realpath(await mkdtemp(join(tmpdir(), "matrix-orca-reuse-wt-")));
  const cli = new OrcaCli({ binary: "/usr/bin/true", executor: fake.executor() });
  const isTicketWorktree = async () => true;
  const req: RunRequest = {
    runId: "run-spike",
    projectId: "demo",
    ticketId: "NEO-7",
    phase: "spike",
    runner: "claude-code",
    model: "claude-opus-4-7",
    prompt: "",
    workdir,
    timeoutMs: 10_000,
  };
  const spec = { cmd: ["true"], cwd: workdir, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000 };
  const attempt = async (bridge: ReturnType<typeof orcaBridge>) => {
    const p = await bridge.phase(req);
    if (!p) throw new Error("expected an Orca phase");
    await p.launcher(spec, () => {}, new AbortController().signal);
    return (await p.receipts())[0]?.data as { orca: { run: string } };
  };
  const first = await attempt(orcaBridge({ dataDir, pollMs: 20, cli, isTicketWorktree }));
  // A server restart: a fresh bridge, same data dir.
  const second = await attempt(orcaBridge({ dataDir, pollMs: 20, cli, isTicketWorktree }));
  expect(second.orca.run).toBe(first.orca.run);
  expect(fake.calls.filter((c) => c[1] === "run-create")).toHaveLength(1);
  expect(fake.calls.filter((c) => c[1] === "run-use")).toHaveLength(1);
  // Every task-create carried the --spec Orca 1.4 requires.
  for (const call of fake.calls.filter((c) => c[1] === "task-create"))
    expect(call[call.indexOf("--spec") + 1]).toMatch(/^Matrix phase spike/);
  // A Run the runtime no longer knows falls back to a new one.
  fake.runs.clear();
  const third = await attempt(orcaBridge({ dataDir, pollMs: 20, cli, isTicketWorktree }));
  expect(third.orca.run).not.toBe(first.orca.run);
}, 30_000);

test("only worktrees in the persisted trusted registry count as Orca ticket worktrees", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "matrix-orca-trusted-"));
  const worktree = await realpath(await mkdtemp(join(tmpdir(), "matrix-orca-trusted-wt-")));
  const registry = join(dataDir, "worktrees.json");
  await new TrustedWorktrees(registry).record(worktree, {
    gitdir: "/g",
    commonDir: "/c",
    baseSha: "a".repeat(40),
    branch: "matrix/NEO-7",
  });
  // A restarted server reads the same registry.
  const isTicketWorktree = trustedTicketWorktree(new TrustedWorktrees(registry));
  expect(await isTicketWorktree(worktree)).toBe(true);
  expect(await isTicketWorktree(join(dataDir, "scratch", "run-1-abc"))).toBe(false);
});
