import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { decodePayload, type OrcaCaller, routeScript, runViaOrca } from "./deploy-orca.js";
import { parseDeployHosts, planDeploy } from "./deploy-plan.js";

const SHA = "a".repeat(40);
const route = { environment: "macbook-pro", repos: { "o/r": "/Users/x/r" } };

/** Runs the real route script in /bin/sh with `fly` stubbed, returns the terminal lines. */
function shRun(script: string, stub: string): string[] {
  const out = execFileSync("/bin/sh", ["-c", `fly() { ${stub}; }\n${script}`], {
    encoding: "utf8",
  });
  return out.split("\n");
}

describe("orca deploy route", () => {
  test("script frames stdout, stderr and the exit code; markers never appear in the script", () => {
    const script = routeScript({ nonce: "n1", argv: ["fly", "releases", "--json"] });
    expect(script).not.toContain("__MXB_n1__");
    const got = decodePayload(shRun(script, 'echo "[1,2]"; echo warn >&2; return 3'), "n1");
    expect(got).toEqual({ exitCode: 3, stdout: "[1,2]\n", output: "[1,2]\n\nwarn\n" });
  });

  test("checkout steps quote nothing user-controlled and verify HEAD", () => {
    const script = routeScript({ nonce: "n2", argv: ["fly", "deploy"], checkout: { sha: SHA } });
    expect(script).toContain(`git checkout --quiet --detach ${SHA}`);
    expect(script).toContain(`test "$(git rev-parse HEAD)" = ${SHA}`);
  });

  test("corrupt payload is a failure, not a throw; truncated stdout never passes", () => {
    expect(decodePayload(["__MXB_x__", "@@@", "__MXE_x__"], "x")?.exitCode).toBe(126);
    const script = routeScript({ nonce: "t", argv: ["fly", "x"] }).replace(
      "pack 2000000",
      "pack 3",
    );
    expect(decodePayload(shRun(script, "echo 123456"), "t")?.exitCode).toBe(125);
  });

  test("no payload until the end marker", () => {
    expect(decodePayload(["__MXB_x__", "abc"], "x")).toBeUndefined();
  });

  test("worktree + terminal created, output decoded, both always cleaned up", async () => {
    const calls: string[][] = [];
    let script = "";
    const cli: OrcaCaller = {
      async call(args) {
        calls.push(args);
        if (args[1] === "create" && args[0] === "worktree")
          return { worktree: { path: "/Users/x/ws/r/mx-1" } };
        if (args[1] === "create") {
          const cmd = args[args.indexOf("--command") + 1]!;
          script = Buffer.from(/printf %s (\S+) \|/.exec(cmd)![1]!, "base64").toString();
          return { terminal: { handle: "term_1" } };
        }
        if (args[1] === "read") {
          const lines = shRun(script.replace(/git [^&]*&& |test [^&]*&& /g, ""), "echo deployed");
          return { terminal: { tail: lines, nextCursor: "9" } };
        }
        return {};
      },
    };
    const r = await runViaOrca(route, ["fly", "deploy"], {
      repo: "o/r",
      checkout: { sha: SHA },
      timeoutMs: 5_000,
      cli,
      sleep: async () => undefined,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("deployed\n");
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "worktree create",
      "terminal create",
      "terminal read",
      "terminal close",
      "worktree rm",
    ]);
    expect(calls[0]).toContain("path:/Users/x/r");
  });

  test("cleanup runs even when the terminal fails", async () => {
    const calls: string[] = [];
    const cli: OrcaCaller = {
      async call(args) {
        calls.push(args.slice(0, 2).join(" "));
        if (args[0] === "worktree" && args[1] === "create") return { worktree: { path: "/w" } };
        if (args[1] === "create") throw new Error("pty refused");
        return {};
      },
    };
    await expect(
      runViaOrca(route, ["fly", "deploy"], { repo: "o/r", timeoutMs: 5_000, cli }),
    ).rejects.toThrow("pty refused");
    expect(calls).toEqual(["worktree create", "terminal create", "worktree rm"]);
  });

  test("unknown repo and short sha are refused before anything runs", async () => {
    const cli: OrcaCaller = {
      call: async () => {
        throw new Error("must not run");
      },
    };
    await expect(runViaOrca(route, ["x"], { repo: "o/z", timeoutMs: 1, cli })).rejects.toThrow(
      "no repo path",
    );
    await expect(
      runViaOrca(route, ["x"], { repo: "o/r", checkout: { sha: "abc" }, timeoutMs: 1, cli }),
    ).rejects.toThrow("full commit sha");
  });

  test("plan resolves an orca host only for repos it has", () => {
    const hosts = parseDeployHosts(
      JSON.stringify([
        { name: "bosgame", transport: "local", capabilities: ["gh"] },
        { name: "macbook", transport: "orca", orca: route, capabilities: ["fly"] },
      ]),
    );
    const profile = {
      merge: "auto" as const,
      targets: [
        {
          name: "api",
          kind: "command" as const,
          paths: ["apps/api"],
          capability: "fly" as const,
          run: ["fly", "deploy"],
        },
      ],
    };
    const base = { profile, files: ["apps/api/x.ts"], hosts, mergeCommit: SHA };
    expect(planDeploy({ ...base, repo: "o/r" }).steps[0]).toMatchObject({
      action: "run",
      host: "macbook",
    });
    expect(planDeploy({ ...base, repo: "o/z" }).steps[0]).toMatchObject({ action: "block" });
    expect(() =>
      parseDeployHosts(JSON.stringify([{ name: "m", transport: "orca", capabilities: ["fly"] }])),
    ).toThrow("orca needs");
  });
});

describe("orca route tail mode", () => {
  test("keepTail keeps the end of an oversized stdout and still passes", () => {
    const script = routeScript({
      nonce: "t1",
      argv: ["sh", "-c", "seq 1 400000; echo LAST"],
      keepTail: true,
    });
    const out = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", maxBuffer: 64 << 20 });
    const got = decodePayload(out.split("\n"), "t1", true)!;
    expect(got.exitCode).toBe(0);
    expect(got.stdout.trimEnd().endsWith("LAST")).toBe(true);
    expect(decodePayload(out.split("\n"), "t1")!.exitCode).toBe(125);
  });
});

describe("orca route attachment", () => {
  test("attachment travels whole even when the log is cut", () => {
    const dir = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
    const script = routeScript({
      nonce: "a1",
      argv: ["sh", "-c", "seq 1 400000; printf 'p\\0q  \\n' > .matrix-patch"],
      keepTail: true,
      attach: ".matrix-patch",
    });
    const out = execFileSync("/bin/sh", ["-c", script], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 64 << 20,
    });
    const got = decodePayload(out.split("\n"), "a1", true)!;
    expect(got.exitCode).toBe(0);
    expect(got.attachment).toEqual(Buffer.from("p\0q  \n"));
    expect(() => routeScript({ nonce: "x", argv: ["x"], attach: "../etc" })).toThrow("attachment");
  });
});
