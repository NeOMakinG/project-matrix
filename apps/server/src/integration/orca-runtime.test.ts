import { mkdtemp, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRequest } from "@matrix/core";
import { OrcaCli } from "@matrix/workspace";
import { FakeOrca } from "@matrix/workspace/testing";
import { expect, test } from "vitest";
import { orcaBridge } from "./orca-runtime.js";

test("one Orca Run per ticket worktree; phases yield receipts with Orca refs", async () => {
  const fake = new FakeOrca();
  const dataDir = await mkdtemp(join(tmpdir(), "matrix-orca-bridge-"));
  const workdir = await realpath(await mkdtemp(join(tmpdir(), "matrix-orca-bridge-wt-")));
  const bridge = orcaBridge({
    dataDir,
    pollMs: 20,
    cli: new OrcaCli({ binary: "/usr/bin/true", executor: fake.executor() }),
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
    const p = bridge.phase(req(phase));
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
  expect(() => orcaBridge({ dataDir: "/tmp", environment: "Bosgame" })).toThrow(/local Orca/);
});
