import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectConfig, PullRequestRequest } from "@matrix/core";
import { hostExecutor, type LineExecutor, type ProcessSpec } from "@matrix/sandbox";
import { expect, test } from "vitest";
import { git, makeRepo } from "./existing-repo.test-helpers.js";
import { externalAwareMerge, GitHubPullRequests } from "./github-pr.js";

const SHA = "a".repeat(40);
const PR = "https://github.com/acme/wayline/pull/12";

function fakeExec(handler: (spec: ProcessSpec) => { code?: number; out?: string; err?: string }) {
  const calls: ProcessSpec[] = [];
  const executor: LineExecutor = async (spec, onLine) => {
    calls.push(spec);
    const r = handler(spec);
    for (const line of (r.out ?? "").split("\n")) if (line) onLine(line);
    return { exitCode: r.code ?? 0, timedOut: false, cancelled: false, stderrTail: r.err ?? "" };
  };
  return { calls, executor };
}

const project = (external = true) =>
  ({
    id: "p1",
    repoPath: "/srv/Projects/wayline",
    baseBranch: "main",
    matrix: {
      tickets: { kind: "linear" },
      ...(external ? { repo: { external: true, remote: "origin", github: "acme/wayline" } } : {}),
    },
  }) as unknown as ProjectConfig;

const request = (overrides: Partial<PullRequestRequest> = {}): PullRequestRequest =>
  ({
    project: project(),
    workflow: {},
    ticket: {
      id: "NEO-7",
      title: "Fix @everyone login #12 ‮",
      url: "https://linear.app/neo/issue/NEO-7",
    },
    headSha: SHA,
    evidence: [{ phase: "qa", summary: "ok @here", urls: ["https://example.test/shot.png"] }],
    ...overrides,
  }) as PullRequestRequest;

const ghList = (pulls: unknown[]) => JSON.stringify(pulls);

test("pushes exactly the validated head and opens a draft PR, then dedupes", async () => {
  const { calls, executor } = fakeExec((spec) => {
    if (spec.cmd.includes("list")) return { out: ghList([]) };
    if (spec.cmd.includes("create")) return { out: `Creating...\n${PR}` };
    return {};
  });
  const prs = new GitHubPullRequests({ executor, ghBinary: "/usr/bin/gh" });
  expect(await prs.publish(request())).toEqual({
    url: PR,
    branch: "matrix-NEO-7-fix-everyone-login-12",
  });

  const pushCall = calls.find((c) => c.cmd.includes("push"));
  const push = pushCall?.cmd ?? [];
  expect(push.slice(-3)).toEqual([
    "--",
    "https://github.com/acme/wayline.git",
    `${SHA}:refs/heads/matrix-NEO-7-fix-everyone-login-12`,
  ]);
  expect(push).toContain("push");
  expect(push.join(" ")).not.toMatch(/--force|\+/);
  expect(push.indexOf("--")).toBeLessThan(push.indexOf("https://github.com/acme/wayline.git"));
  expect(push.at(-1)).toBe(`${SHA}:refs/heads/matrix-NEO-7-fix-everyone-login-12`);
  // Credentials come from gh; nothing secret on argv.
  const env = pushCall?.env ?? {};
  expect(Object.values(env)).toContain("!/usr/bin/gh auth git-credential");

  const create = calls.find((c) => c.cmd.includes("create"));
  expect(create?.cmd).toEqual(
    expect.arrayContaining(["--draft", "--base", "main", "--repo", "acme/wayline"]),
  );
  expect(create?.cmd).not.toContain("--fill");
  const title = create?.cmd[create.cmd.indexOf("--title") + 1] ?? "";
  expect(title).toBe("NEO-7: Fix ＠everyone login ＃12");
  expect(create?.stdin).toContain("&#64;here");
  expect(create?.stdin).not.toMatch(/@here|@everyone|‮/);
  expect(create?.stdin).toContain("Linear: [NEO-7](https://linear.app/neo/issue/NEO-7)");
  expect(create?.stdin).toContain("Project Matrix");

  const before = calls.length;
  expect(await prs.publish(request())).toEqual({
    url: PR,
    branch: "matrix-NEO-7-fix-everyone-login-12",
  });
  expect(calls.length).toBe(before);
});

test("reuses an existing open PR for the branch and keeps the branch on new heads", async () => {
  const { calls, executor } = fakeExec((spec) =>
    spec.cmd.includes("list")
      ? {
          out: ghList([
            { url: "https://github.com/acme/wayline/pull/3", state: "CLOSED" },
            { url: PR, state: "OPEN" },
          ]),
        }
      : {},
  );
  const prs = new GitHubPullRequests({ executor });
  expect((await prs.publish(request()))?.url).toBe(PR);
  expect(calls.some((c) => c.cmd.includes("create"))).toBe(false);
  // A later loop produces a new head under a renamed ticket: same remote branch, plain push.
  const next = request({ headSha: "b".repeat(40) });
  next.ticket = { ...next.ticket, title: "Renamed" };
  expect((await prs.publish(next))?.branch).toBe("matrix-NEO-7-fix-everyone-login-12");
});

test("never publishes greenfield projects, short SHAs or a secret-flagged range", async () => {
  const { calls, executor } = fakeExec(() => ({}));
  const prs = new GitHubPullRequests({
    executor,
    scan: async () => ({ kind: "secret-scan", ok: false, summary: "1 finding" }),
  });
  expect(await prs.publish(request({ project: project(false) }))).toBeUndefined();
  await expect(prs.publish(request({ headSha: "abc" }))).rejects.toThrow(/full commit SHA/);
  const other = request();
  other.ticket = { ...other.ticket, id: "NEO-8" };
  await expect(prs.publish(other)).rejects.toThrow(/secret gate/);
  expect(calls).toHaveLength(0);
});

test("a failing push errors redacted, backs off, and retries later", async () => {
  let now = 0;
  const { calls, executor } = fakeExec((spec) => {
    if (spec.cmd.includes("push"))
      return { code: 128, err: "fatal: denied for ghp_abcdefghijklmnopqrstuvwxyz0123456789" };
    if (spec.cmd.includes("config")) return { code: 1 };
    return spec.cmd.includes("list") ? { out: "[]" } : {};
  });
  const pushes = () => calls.filter((c) => c.cmd.includes("push")).length;
  const prs = new GitHubPullRequests({ executor, retryMs: 1000, clock: () => new Date(now) });
  const error = await prs.publish(request()).catch((e: Error) => e);
  expect(String(error)).toMatch(/denied/);
  expect(String(error)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  expect(await prs.publish(request())).toBeUndefined();
  expect(pushes()).toBe(1);
  now = 2000;
  await expect(prs.publish(request())).rejects.toThrow(/denied/);
  expect(pushes()).toBe(2);
});

test("diverged or already-merged branches move to a fresh suffixed branch, never force", async () => {
  const branch = "matrix-NEO-7-fix-everyone-login-12";
  const { calls, executor } = fakeExec((spec) => {
    const head = spec.cmd[spec.cmd.indexOf("--head") + 1];
    if (spec.cmd.includes("list"))
      return {
        out:
          head === branch
            ? ghList([{ url: PR, state: "MERGED", headRefOid: "c".repeat(40) }])
            : "[]",
      };
    if (spec.cmd.includes("push") && spec.cmd.at(-1)?.endsWith(`${branch}-2`))
      return { code: 1, err: " ! [rejected] (non-fast-forward)" };
    if (spec.cmd.includes("create")) return { out: "https://github.com/acme/wayline/pull/13" };
    return spec.cmd.includes("config") ? { code: 1 } : {};
  });
  const prs = new GitHubPullRequests({ executor });
  expect(await prs.publish(request())).toEqual({
    url: "https://github.com/acme/wayline/pull/13",
    branch: `${branch}-3`,
  });
  expect(calls.some((c) => c.cmd.join(" ").includes("+"))).toBe(false);
});

test("refuses to push when repo config rewrites URLs", async () => {
  const { calls, executor } = fakeExec((spec) =>
    spec.cmd.includes("config") ? { out: "url.https://evil.test/.insteadof" } : {},
  );
  const prs = new GitHubPullRequests({ executor });
  await expect(prs.publish(request())).rejects.toThrow(/rewrites URLs/);
  expect(calls.some((c) => c.cmd.includes("push"))).toBe(false);
});

test("existing-repo merge only succeeds once a human merged the PR on GitHub", async () => {
  let state = "OPEN";
  let movedHead = SHA;
  const { executor } = fakeExec((spec) => {
    if (spec.cmd.includes("list"))
      return { out: ghList([{ url: PR, state, headRefOid: state === "OPEN" ? SHA : movedHead }]) };
    return spec.cmd.includes("config") ? { code: 1 } : {};
  });
  const prs = new GitHubPullRequests({ executor });
  const local = { merge: async () => ({ ok: true, summary: "local" }) };
  const merge = externalAwareMerge(prs, local);
  const ctx = { project: project(), workflow: {}, ticket: request().ticket } as never;
  const req = { headSha: SHA, idempotencyKey: "k", mode: "human" as const };
  expect(await merge.merge(ctx, req)).toMatchObject({ ok: false, pending: true, url: PR });
  state = "MERGED";
  expect(await merge.merge(ctx, req)).toMatchObject({ ok: true, url: PR, mergedSha: SHA });
  movedHead = "d".repeat(40);
  const moved = await merge.merge(ctx, req);
  expect(moved).toMatchObject({ ok: false, url: PR });
  expect(moved).not.toHaveProperty("pending");
  const greenfield = { ...(ctx as object), project: project(false) } as never;
  expect(await merge.merge(greenfield, req)).toMatchObject({ summary: "local" });
});

test("the pushed commit of an existing repo never carries .matrix/ paths (real git)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "matrix-pr-real-")));
  const repo = makeRepo(root, "wayline");
  const commitOn = (branch: string, file: string) => {
    git(repo, "checkout", "-q", "-b", branch, "main");
    mkdirSync(join(repo, dirname(file)), { recursive: true });
    writeFileSync(join(repo, file), "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", branch);
    return git(repo, "rev-parse", "HEAD").trim();
  };
  const clean = commitOn("clean", "app/src/features/a.ts");
  const dirty = commitOn("dirty", ".matrix/graph/code.json");
  const pushed: string[] = [];
  const executor: LineExecutor = async (spec, onLine, signal) => {
    if (spec.cmd.includes("push")) {
      pushed.push(spec.cmd.at(-1) ?? "");
      return { exitCode: 0, timedOut: false, cancelled: false, stderrTail: "" };
    }
    if (spec.cmd[0] === "gh") {
      onLine(spec.cmd.includes("list") ? "[]" : PR);
      return { exitCode: 0, timedOut: false, cancelled: false, stderrTail: "" };
    }
    return hostExecutor(spec, onLine, signal);
  };
  const prs = new GitHubPullRequests({ executor });
  const at = (headSha: string, id: string) => {
    const r = request({ headSha, project: { ...project(), repoPath: repo } as ProjectConfig });
    r.ticket = { ...r.ticket, id };
    return r;
  };
  await expect(prs.publish(at(dirty, "NEO-8"))).rejects.toThrow(/Matrix\/CI paths/);
  expect(pushed).toEqual([]);
  expect((await prs.publish(at(clean, "NEO-9")))?.url).toBe(PR);
  expect(pushed).toHaveLength(1);
  const files = git(repo, "diff", "--name-only", `main...${clean}`).trim().split("\n");
  expect(files).toEqual(["app/src/features/a.ts"]);
});
