import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import type { ProjectConfig } from "@matrix/core";
import type { LineExecutor } from "@matrix/sandbox";
import { describe, expect, test } from "vitest";
import type { OrcaCaller } from "./deploy-orca.js";
import {
  hostSlots,
  parseRunnerHosts,
  type RemoteRunners,
  remoteAwareSandbox,
  remoteContext,
  runnerSlots,
  runRemote,
} from "./remote-runner.js";

const SHA = "c".repeat(40);
const hosts = parseRunnerHosts(
  JSON.stringify([
    {
      name: "miniforum",
      orca: { environment: "miniforum", repos: { "o/r": "/home/orca/Projects/r" } },
      cores: 20,
      ramGb: 31,
      phases: ["implement", "checks"],
      key: { envFile: "/home/orca/.config/claude-proxy/env", name: "CLIPROXY_API_KEY" },
    },
    {
      name: "mac",
      orca: { environment: "macbook-pro", repos: { "o/r": "/Users/x/r" } },
      cores: 12,
      ramGb: 36,
      phases: ["checks"],
      key: { secrets: "CLIPROXY_API_KEY" },
    },
  ]),
);
const project = {
  id: "p",
  host: "bosgame",
  repoPath: "/repos/r",
  matrix: { repo: { github: "o/r", setup: [{ run: ["pnpm", "i"] }] } },
} as unknown as ProjectConfig;

/** Fake host git: records argv, answers status/rev-parse/diff. */
function git(opts: { dirty?: boolean; diff?: string } = {}) {
  const ran: string[] = [];
  let stdin: string | undefined;
  const executor: LineExecutor = async (spec, onLine) => {
    const args = spec.cmd.slice(spec.cmd.indexOf("-C") + 2);
    ran.push(args.join(" "));
    if (args[0] === "status") onLine(opts.dirty ? " M a.ts" : "");
    if (args[0] === "rev-parse") onLine(SHA);
    if (args[0] === "diff") onLine(opts.diff ?? "");
    if (args[0] === "apply") stdin = readFileSync(args.at(-1)!, "utf8");
    return { exitCode: 0, stderrTail: "", timedOut: false, cancelled: false };
  };
  return { ran, executor, applied: () => stdin };
}

/** Fake Orca: answers the framed payload for the nonce found in the terminal command. */
function orca(stdout: string, rc = 0, att?: string) {
  const calls: string[][] = [];
  let nonce = "";
  const cli: OrcaCaller = {
    async call(args) {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "create") return { worktree: { path: "/w/mx" } };
      if (args[1] === "create") {
        const cmd = args[args.indexOf("--command") + 1]!;
        const script = Buffer.from(/printf %s (\S+) \|/.exec(cmd)![1]!, "base64").toString();
        nonce = /' B (\w+)/.exec(script)![1]!;
        return { terminal: { handle: "t1" } };
      }
      if (args[1] === "read") {
        const body = Buffer.concat([
          Buffer.from(
            `rc=${rc} out=${Buffer.byteLength(stdout)} full=${Buffer.byteLength(stdout)} att=${att === undefined ? -1 : Buffer.byteLength(att)}\n${stdout}${att ?? ""}`,
          ),
          Buffer.from("err\n"),
        ]);
        return {
          terminal: {
            tail: [`__MXB_${nonce}__`, gzipSync(body).toString("base64"), `__MXE_${nonce}__`],
          },
        };
      }
      return {};
    },
  };
  return { cli, calls };
}

describe("runner hosts", () => {
  test("slots follow the host size; repo reach decides eligibility", () => {
    expect(hostSlots(hosts[0]!)).toBe(2);
    expect(hostSlots(hosts[1]!)).toBe(3);
    const slots = runnerSlots(hosts);
    expect(slots[0]!.serves!(project)).toBe(true);
    expect(slots[0]!.serves!({ ...project, matrix: { repo: { github: "o/z" } } } as never)).toBe(
      false,
    );
    expect(() => parseRunnerHosts(JSON.stringify([{ ...hosts[0], phases: ["qa"] }]))).toThrow();
  });

  test("implement: push scratch, run, collect diff, always delete scratch refs", async () => {
    const g = git();
    const o = orca('{"type":"result"}\n', 0, "diff --git a/b b/b\n+x  \n");
    const c = await remoteContext(
      {
        hosts,
        project: async () => project,
        executor: g.executor,
        orcaCli: () => o.cli,
        pollMs: 0,
      },
      "miniforum",
      "p",
      "/wt",
      "run-1",
    );
    const r = await runRemote(c!, {
      argv: ["claude", "-p"],
      env: { K: "__PH__" },
      placeholder: "__PH__",
      stdin: "hi",
      timeoutMs: 5_000,
      collect: true,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("result");
    expect(g.applied()).toBe("diff --git a/b b/b\n+x  \n");
    expect(g.ran.some((x) => x.startsWith("fetch"))).toBe(false);
    expect(g.ran).toEqual(
      expect.arrayContaining([
        `push --quiet --no-follow-tags https://github.com/o/r.git ${SHA}:refs/heads/matrix-run/run-1`,
        "push --quiet https://github.com/o/r.git :refs/heads/matrix-run/run-1",
      ]),
    );
    const cmd = o.calls.find((x) => x[1] === "create" && x[0] === "terminal")!.join(" ");
    expect(cmd).not.toContain("hi");
    expect(o.calls.map((x) => x.slice(0, 2).join(" "))).toContain("worktree rm");
  });

  test("failed remote run: nothing collected, scratch still deleted", async () => {
    const g = git();
    const o = orca("", 1);
    const c = await remoteContext(
      {
        hosts,
        project: async () => project,
        executor: g.executor,
        orcaCli: () => o.cli,
        pollMs: 0,
      },
      "miniforum",
      "p",
      "/wt",
      "run-2",
    );
    expect(
      (await runRemote(c!, { argv: ["x"], env: {}, timeoutMs: 5_000, collect: true })).exitCode,
    ).toBe(1);
    expect(g.ran.some((x) => x.startsWith("fetch"))).toBe(false);
    expect(
      g.ran.filter((x) =>
        x.startsWith("push --quiet https://github.com/o/r.git :refs/heads/matrix-run/run-2"),
      ).length,
    ).toBe(1);
  });

  test("dirty tree or no host: runs locally; unknown host or repo refused", async () => {
    const base = { hosts, project: async () => project, orcaCli: () => orca("").cli };
    expect(
      await remoteContext(
        { ...base, executor: git({ dirty: true }).executor },
        "miniforum",
        "p",
        "/wt",
        "r",
      ),
    ).toBeUndefined();
    expect(await remoteContext(base, undefined, "p", "/wt", "r")).toBeUndefined();
    await expect(remoteContext(base, "nope", "p", "/wt", "r")).rejects.toThrow(
      "unknown runner host",
    );
    await expect(
      remoteContext(
        { ...base, project: async () => ({ ...project, matrix: {} }) as never },
        "mac",
        "p",
        "/wt",
        "r",
      ),
    ).rejects.toThrow("no checkout");
  });

  test("checks sandbox: host specs go remote with the report mount swapped, others stay local", async () => {
    const g = git();
    const o = orca("tests ok\n", 0, '{"r":1}');
    const local = {
      kind: "podman" as const,
      exec: async () => ({ code: 0, stdout: "local", stderr: "" }),
    };
    const r: RemoteRunners = {
      hosts,
      project: async () => project,
      executor: g.executor,
      orcaCli: () => o.cli,
      pollMs: 0,
    };
    const sb = remoteAwareSandbox(local, r);
    expect(
      (await sb.exec({ workdir: "/wt", cmd: ["x"], network: "none", timeoutMs: 1 })).stdout,
    ).toBe("local");
    const res = await sb.exec({
      workdir: "/wt",
      host: "mac",
      projectId: "p",
      cmd: ["vitest", "--outputFile=/matrix-report/v.json"],
      network: "none",
      timeoutMs: 5_000,
      report: { name: "v.json", maxBytes: 100 },
    });
    expect(res.stdout).toBe("tests ok\n");
    expect(res.report).toEqual({ text: '{"r":1}' });
    const script = o.calls.find((x) => x[0] === "terminal" && x[1] === "create")!;
    expect(script.join(" ")).toContain("printf %s");
  });
});

describe("runner host safety", () => {
  test("the scratch-push scan runs in the canonical repo, never the ticket worktree", async () => {
    const g = git();
    const seen: string[] = [];
    const r: RemoteRunners = {
      hosts,
      project: async () => project,
      executor: g.executor,
      orcaCli: () => orca("done\n", 0).cli,
      pollMs: 0,
      scan: async (repo) => {
        seen.push(repo);
        return { ok: false, summary: "stop" };
      },
    };
    const c = await remoteContext(r, "miniforum", "p", "/wt", "run-9");
    await expect(
      runRemote(c!, { argv: ["x"], env: {}, timeoutMs: 1, collect: true }),
    ).rejects.toThrow("secret gate");
    expect(seen).toEqual(["/repos/r"]);
    expect(seen).not.toContain("/wt");
  });

  test("a failing secret scan stops the scratch push; a missing patch fails the run", async () => {
    const g = git();
    const o = orca("done\n", 0);
    const r: RemoteRunners = {
      hosts,
      project: async () => project,
      executor: g.executor,
      orcaCli: () => o.cli,
      pollMs: 0,
      scan: async () => ({ ok: false, summary: "leak" }),
    };
    const c = await remoteContext(r, "miniforum", "p", "/wt", "run-3");
    await expect(
      runRemote(c!, { argv: ["x"], env: {}, timeoutMs: 1, collect: true }),
    ).rejects.toThrow("secret gate");
    expect(g.ran.some((x) => x.startsWith("push"))).toBe(false);
    const c2 = await remoteContext(
      { ...r, scan: async () => ({ ok: true, summary: "" }) },
      "miniforum",
      "p",
      "/wt",
      "run-4",
    );
    const res = await runRemote(c2!, { argv: ["x"], env: {}, timeoutMs: 5_000, collect: true });
    expect(res.exitCode).toBe(98);
  });
});

describe("remote check report path", () => {
  test("the wrapper gives an absolute report path in args and env, even after a cd", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { REPORT_PLACEHOLDER, REPORT_WRAPPER } = await import("./remote-runner.js");
    const root = mkdtempSync(join(tmpdir(), "mx-rep-"));
    mkdirSync(join(root, "app"));
    execFileSync(
      "/bin/sh",
      [
        "-c",
        REPORT_WRAPPER,
        "sh",
        "1",
        "OUT_ENV",
        "sh",
        "-c",
        'cd app && printf env >"$OUT_ENV" && printf arg >"$1" && printf %s "$2" >"$OUT_ENV.k"',
        "inner",
        `${REPORT_PLACEHOLDER}/a.json`,
        "keep\n",
      ],
      { cwd: root, env: { PATH: process.env.PATH ?? "", OUT_ENV: `${REPORT_PLACEHOLDER}/e.tap` } },
    );
    expect(readFileSync(join(root, ".matrix-report/e.tap"), "utf8")).toBe("env");
    expect(readFileSync(join(root, ".matrix-report/a.json"), "utf8")).toBe("arg");
    // Arguments without the placeholder pass through byte for byte (trailing newline kept).
    expect(readFileSync(join(root, ".matrix-report/e.tap.k"), "utf8")).toBe("keep\n");
    expect(() =>
      execFileSync("/bin/sh", ["-c", REPORT_WRAPPER, "sh", "1", "BAD;rm", "true"], { cwd: root }),
    ).toThrow();
  });
});
