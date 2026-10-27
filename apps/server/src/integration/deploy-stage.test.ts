import type { DeployProfile, PhaseContext } from "@matrix/core";
import type { LineExecutor } from "@matrix/sandbox";
import { describe, expect, test, vi } from "vitest";
import { deployPort, verifyPort } from "./deploy-stage.js";

vi.mock("./deploy-hosts.js", async (orig) => ({
  ...(await orig<typeof import("./deploy-hosts.js")>()),
  assertPublicUrl: async () => undefined,
}));

const SHA = "b".repeat(40);
const profile: DeployProfile = {
  merge: "auto",
  targets: [
    {
      name: "dashboard",
      kind: "git-integration",
      paths: ["apps/dashboard", "README.md"],
      version: { url: "https://d.example.com/version.json", field: "commit" },
      health: { url: "https://d.example.com/", expect: 200 },
    },
    {
      name: "api",
      kind: "command",
      paths: ["apps/api"],
      capability: "fly",
      run: ["fly", "deploy", "-a", "app"],
      health: { url: "https://api.example.com/health", expect: 200 },
      rollback: { kind: "fly-releases", app: "app" },
      holdOn: ["apps/api/prisma/**"],
      coordinate: { deck: true, recentForeignDeployMinutes: 30 },
    },
  ],
};

function ctx(comments: string[]): PhaseContext {
  return {
    project: { id: "p", deploy: profile, matrix: { repo: { github: "o/r" } } },
    ticket: { id: "NEO-1" },
    tickets: { comment: async (_: string, body: string) => void comments.push(body) },
    signal: new AbortController().signal,
  } as unknown as PhaseContext;
}

const prs = (files: string[]) => ({
  mergedInfo: async () => ({
    url: "https://github.com/o/r/pull/1",
    mergeCommit: SHA,
    headSha: SHA,
    files,
  }),
});

/** Fake host shell: records argv, answers `fly releases`. */
function shell(releases: object[]) {
  const ran: string[] = [];
  const executor: LineExecutor = async (spec, onLine) => {
    const cmd = spec.cmd.join(" ");
    ran.push(cmd);
    if (cmd.includes("fly' 'releases")) onLine(JSON.stringify(releases));
    return { exitCode: 0, stderrTail: "", timedOut: false } as never;
  };
  return { ran, executor };
}
const opts = { polls: { attempts: 2, everyMs: 0 }, sleep: async () => undefined };
const okFetch = (commit: string, status = 200) =>
  (async (url: string) =>
    new Response(String(url).endsWith("version.json") ? JSON.stringify({ commit }) : "ok", {
      status,
    })) as never;

describe("deploy stage", () => {
  test("README: nothing runs, production proof + health pass, one receipt comment", async () => {
    const { ran, executor } = shell([]);
    const comments: string[] = [];
    const o = { ...opts, prs: prs(["README.md"]), hosts: [], executor, fetch: okFetch(SHA) };
    expect((await deployPort(o).deploy(ctx(comments), {} as never)).ok).toBe(true);
    const v = await verifyPort(o).verify(ctx(comments));
    const receipts = Array.isArray(v) ? v : v.receipts;
    expect(receipts.every((r) => r.ok)).toBe(true);
    expect(ran).toEqual([]);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("PASS");
  });

  test("production still serving another commit fails verification", async () => {
    const o = { ...opts, prs: prs(["README.md"]), hosts: [], fetch: okFetch("c".repeat(40)) };
    const v = await verifyPort(o).verify(ctx([]));
    expect((Array.isArray(v) ? v : v.receipts).some((r) => !r.ok)).toBe(true);
  });

  test("a migration merges but holds the api deploy, nothing runs", async () => {
    const { ran, executor } = shell([]);
    const o = {
      ...opts,
      prs: prs(["apps/api/prisma/m.sql"]),
      hosts: [{ name: "mac", transport: "local" as const, capabilities: ["fly" as const] }],
      executor,
    };
    const res = await deployPort(o).deploy(ctx([]), {} as never);
    expect(res).toMatchObject({ ok: false, blocked: true });
    expect(res.summary).toContain("held");
    expect(ran).toEqual([]);
  });

  test("a recent foreign Fly release holds the deploy", async () => {
    const { ran, executor } = shell([
      {
        Version: 9,
        Status: "complete",
        User: { Email: "contact@0xgom.es" },
        CreatedAt: new Date().toISOString(),
        ImageRef: "registry.fly.io/app:deployment-x",
      },
    ]);
    const deck = vi.fn(async () => undefined);
    const o = {
      ...opts,
      prs: prs(["apps/api/a.ts"]),
      hosts: [{ name: "mac", transport: "local" as const, capabilities: ["fly" as const] }],
      executor,
      deckNote: deck,
    };
    const res = await deployPort(o).deploy(ctx([]), {} as never);
    expect(res.summary).toContain("contact@0xgom.es");
    expect(deck).not.toHaveBeenCalled();
    expect(ran.some((c) => c.includes("'deploy'"))).toBe(false);
  });

  test("api health failure rolls back only while the current release is ours", async () => {
    const tag = `registry.fly.io/app:matrix-${SHA.slice(0, 12)}`;
    const { ran, executor } = shell([
      { Version: 10, Status: "complete", CreatedAt: "2026-01-01T00:00:00Z", ImageRef: tag },
      {
        Version: 9,
        Status: "complete",
        CreatedAt: "2026-01-01T00:00:00Z",
        ImageRef: "registry.fly.io/app:old",
      },
    ]);
    const o = {
      ...opts,
      prs: prs(["apps/api/a.ts"]),
      hosts: [{ name: "mac", transport: "local" as const, capabilities: ["fly" as const] }],
      executor,
      fetch: okFetch(SHA, 503),
    };
    const deck = vi.fn(async () => undefined);
    const shared = await verifyPort({ ...o, deckNote: deck }).verify(ctx([]));
    expect(
      (Array.isArray(shared) ? shared : shared.receipts).some((r) =>
        r.summary.includes("rolled back app to v9"),
      ),
    ).toBe(true);
    expect(deck).toHaveBeenCalledWith(expect.stringContaining("rolling back app to v9"));
    // A newer foreign release on top of ours: never rolled back.
    const foreign = shell([
      {
        Version: 11,
        Status: "complete",
        CreatedAt: "2026-01-01T00:00:00Z",
        ImageRef: "registry.fly.io/app:deployment-x",
        User: { Email: "contact@0xgom.es" },
      },
      { Version: 10, Status: "complete", CreatedAt: "2026-01-01T00:00:00Z", ImageRef: tag },
    ]);
    const v = await verifyPort({ ...o, executor: foreign.executor }).verify(ctx([]));
    const receipts = Array.isArray(v) ? v : v.receipts;
    expect(receipts.some((r) => r.summary.includes("rolled back"))).toBe(false);
    expect(foreign.ran.some((c) => c.includes("'deploy'"))).toBe(false);
  });
});
