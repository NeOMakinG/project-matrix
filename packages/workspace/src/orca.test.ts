import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { checkOrcaContract, ORCA_REQUIRED_COMMANDS, OrcaWorkspace } from "./orca.js";
import { OrcaCli, shellQuote } from "./orca-cli.js";
import {
  type OrcaPhaseEvidence,
  orcaLauncher,
  resolveBinary,
  runnerScript,
} from "./orca-launcher.js";
import { OrcaTicketSession, UNATTENDED_REPLY } from "./orca-session.js";
import { FakeOrca } from "./testing/fake-orca.js";
import { TrustedWorktrees } from "./trusted.js";

vi.setConfig({ testTimeout: 30_000 });

async function repo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "matrix-orca-repo-")));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir });
  git("init", "-q", "-b", "main");
  await writeFile(join(dir, "README.md"), "x");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

const BIN = "/opt/Orca/resources/bin/orca-ide";

describe("orca contract", () => {
  test("reports missing commands and flags", () => {
    const good = {
      schemaVersion: 1,
      commands: Object.entries(ORCA_REQUIRED_COMMANDS).map(([command, flags]) => ({
        command,
        flags,
      })),
    };
    expect(checkOrcaContract(good)).toEqual([]);
    expect(checkOrcaContract({ schemaVersion: 2, commands: [] })).toEqual(
      expect.arrayContaining(["unsupported schemaVersion 2", "missing command: orca worktree rm"]),
    );
  });

  test("the CLI is only ever called by absolute path", () => {
    expect(() => new OrcaCli({ binary: "orca" })).toThrow(/absolute/);
    expect(new OrcaCli().binary).toBe(BIN);
  });

  test("shell quoting survives hostile text", () => {
    const hostile = `a'; touch /tmp/pwned #$(id)\`x\``;
    expect(execFileSync("bash", ["-c", `printf %s ${shellQuote(hostile)}`]).toString()).toBe(
      hostile,
    );
  });
});

describe("orca workspace", () => {
  test("prepare links the Linear issue, records the Orca branch; cleanup archives before rm", async () => {
    const repoPath = await repo();
    const fake = new FakeOrca();
    fake.repos = [{ id: "r1", path: repoPath }];
    fake.worktreeRoot = await realpath(await mkdtemp(join(tmpdir(), "matrix-orca-wt-")));
    const trusted = new TrustedWorktrees();
    const removed: string[] = [];
    const ws = new OrcaWorkspace({
      executor: fake.executor(),
      trusted,
      beforeRemove: async (w) => {
        removed.push(w);
      },
    });
    const target = {
      projectId: "p",
      ticketId: "NEO-12",
      repoPath,
      branch: "matrix/NEO-12",
      baseBranch: "main",
    };
    const prepared = await ws.prepare(target);
    const create = fake.calls.find((c) => c[0] === "worktree" && c[1] === "create") ?? [];
    expect(create).toEqual(
      expect.arrayContaining(["--no-parent", "--setup", "skip", "--linear-issue", "NEO-12"]),
    );
    expect(create[create.indexOf("--name") + 1]).toBe("matrix-NEO-12");
    expect(JSON.parse(prepared.ref)).toMatchObject({
      orca: "wt-matrix-NEO-12",
      branch: "matrix-NEO-12",
    });
    const entry = await trusted.lookup(prepared.workdir);
    expect(entry.baseSha).toMatch(/^[0-9a-f]{40}$/);

    await ws.cleanup(prepared);
    const refs = execFileSync("git", ["-C", repoPath, "for-each-ref", "refs/matrix/archive"])
      .toString()
      .trim();
    expect(refs).toContain(`refs/matrix/archive/matrix-NEO-12-${entry.baseSha?.slice(0, 12)}`);
    expect(removed).toEqual([prepared.workdir]);
    expect(fake.calls.at(-1)).toEqual([
      "worktree",
      "rm",
      "--worktree",
      "id:wt-matrix-NEO-12",
      "--force",
      "--json",
    ]);
    await expect(ws.cleanup({ workdir: prepared.workdir, ref: "wt-legacy" })).rejects.toThrow(
      /refusing to remove/,
    );
  });

  test("non-Linear ticket ids are not linked", async () => {
    const repoPath = await repo();
    const fake = new FakeOrca();
    fake.repos = [{ id: "r1", path: repoPath }];
    fake.worktreeRoot = await realpath(await mkdtemp(join(tmpdir(), "matrix-orca-wt-")));
    await new OrcaWorkspace({ executor: fake.executor() }).prepare({
      projectId: "p",
      ticketId: "bd-7; rm -rf",
      repoPath,
      branch: "matrix/bd-7",
      baseBranch: "main",
    });
    expect(fake.calls.flat()).not.toContain("--linear-issue");
  });

  test("unregistered repo is a clear error", async () => {
    const fake = new FakeOrca();
    await expect(
      new OrcaWorkspace({ executor: fake.executor() }).prepare({
        projectId: "p",
        ticketId: "t",
        repoPath: await repo(),
        branch: "b",
        baseBranch: "main",
      }),
    ).rejects.toThrow(/not registered in Orca/);
  });
});

async function phase(fake: FakeOrca, opts: { cmd: string[]; stdin?: string; timeoutMs?: number }) {
  const worktree = await realpath(await mkdtemp(join(tmpdir(), "matrix-orca-phase-")));
  const scriptRoot = join(await mkdtemp(join(tmpdir(), "matrix-orca-scripts-")), "orca");
  const cli = new OrcaCli({ binary: "/usr/bin/true", executor: fake.executor() });
  const session = new OrcaTicketSession(cli, worktree, "NEO-12 · demo", 20);
  const evidence: OrcaPhaseEvidence[] = [];
  const lines: string[] = [];
  const launch = orcaLauncher({
    cli,
    session,
    scriptRoot,
    title: "review · gpt-6-sol",
    pollMs: 20,
    exitGraceMs: 3_000,
    onEvidence: (e) => {
      evidence.push(e);
    },
  });
  const outcome = await launch(
    {
      cmd: opts.cmd,
      cwd: worktree,
      env: { PATH: "/usr/bin:/bin", HOME: worktree },
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      timeoutMs: opts.timeoutMs ?? 10_000,
    },
    (line) => lines.push(line),
    new AbortController().signal,
  );
  await session.idle();
  return { outcome, lines, evidence, worktree, scriptRoot, session };
}

describe("orca launcher", () => {
  test("runs the command in an Orca terminal; hostile prompt text stays data", async () => {
    const fake = new FakeOrca();
    const hostile = `line one\n'; touch pwned; echo '\n$(touch pwned2) \`touch pwned3\``;
    const r = await phase(fake, { cmd: ["cat"], stdin: hostile });
    expect(r.outcome).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(r.lines.join("\n")).toBe(hostile);
    for (const f of ["pwned", "pwned2", "pwned3"])
      expect(existsSync(join(r.worktree, f))).toBe(false);
    expect(r.evidence[0]).toMatchObject({ outcome: "succeeded", taskId: expect.any(String) });
    expect(r.evidence[0]?.messages.map((m) => m.type)).toEqual(["worker_done"]);
    expect(fake.closed.has(r.evidence[0]?.terminal ?? "")).toBe(true);
    expect(await readdir(r.scriptRoot)).toEqual([]);
    // Every Delivery was acknowledged, so nothing replays into the next phase.
    expect(fake.pending()).toBe(0);
    const send = fake.calls.find((c) => c[1] === "send" && c.includes("--text")) ?? [];
    expect(send.join(" ")).not.toContain("touch");
  });

  test("worker questions get the fixed unattended answer", async () => {
    const fake = new FakeOrca();
    fake.askQuestion = true;
    await phase(fake, { cmd: ["true"] });
    expect(fake.replies).toEqual([{ id: expect.any(String), body: UNATTENDED_REPLY }]);
  });

  test("a lost worker_done still completes from the exit file", async () => {
    const fake = new FakeOrca();
    fake.dropWorkerDone = true;
    const r = await phase(fake, { cmd: ["false"] });
    expect(r.outcome.exitCode).toBe(1);
    expect(r.evidence[0]?.outcome).toBe("failed");
  });

  test("a stuck worker times out and is interrupted", async () => {
    const fake = new FakeOrca();
    const r = await phase(fake, { cmd: ["sleep", "30"], timeoutMs: 300 });
    expect(r.outcome).toMatchObject({ timedOut: true, exitCode: 124 });
    expect(fake.interrupted.size).toBe(1);
    expect(r.evidence[0]?.outcome).toBe("timeout");
  });

  test("runner script refuses secrets in env and relative binaries", () => {
    const base = {
      argv0: "/bin/cat",
      outFile: "/o",
      errFile: "/e",
      rcFile: "/r",
      orcaBinary: BIN,
      taskId: "t",
      dispatchId: "d",
    };
    expect(() =>
      runnerScript({
        ...base,
        spec: { cmd: ["cat"], cwd: "/", env: { ANTHROPIC_API_KEY: "x" }, timeoutMs: 1 },
      }),
    ).toThrow(/refusing/);
    expect(() => resolveBinary("./cat", "/bin")).toThrow(/relative/);
    expect(resolveBinary("cat", "/usr/bin:/bin")).toMatch(/^\/.*cat$/);
  });
});

// Opt-in, read-only: MATRIX_ORCA_LIVE=1 [MATRIX_ORCA_BINARY=/abs/orca-ide] checks the installed CLI.
test.runIf(process.env.MATRIX_ORCA_LIVE === "1")("live Orca satisfies the contract", async () => {
  const cli = new OrcaCli(
    process.env.MATRIX_ORCA_BINARY ? { binary: process.env.MATRIX_ORCA_BINARY } : {},
  );
  expect(checkOrcaContract(await cli.call(["agent-context", "--json"]))).toEqual([]);
});
