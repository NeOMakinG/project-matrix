import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhaseContext } from "@matrix/core";
import { createHarness } from "@matrix/core/testing";
import { TrustedWorktrees, WorktreeGitPort } from "@matrix/workspace";
import { afterEach, expect, test, vi } from "vitest";
import { hostReviewContext } from "./review-context.js";

afterEach(() => vi.restoreAllMocks());

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "matrix-review-context-"));
  const dir = join(root, "repo");
  await mkdir(join(dir, "docs/adr"), { recursive: true });
  git(root, "init", "-q", "-b", "main", dir);
  await writeFile(join(dir, "docs/adr/0001-layers.md"), "# Layers\nUI never imports db.\n");
  await writeFile(join(dir, "app.ts"), "export const a = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const baseSha = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-qb", "matrix/t");
  await writeFile(join(dir, "app.ts"), "export const a = 2;\n");
  await writeFile(join(dir, "film.ts"), "export const film = true;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "change");
  return { root, dir, baseSha, headSha: git(dir, "rev-parse", "HEAD") };
}

function context(dir: string): PhaseContext {
  const harness = createHarness();
  const ticket = harness.tickets.add("t");
  return {
    project: { ...harness.project, baseBranch: "main" },
    workflow: {
      projectId: "test",
      ticketId: ticket.id,
      phase: "review",
      status: "running",
      attempt: 0,
      loops: 0,
      priority: 1,
      version: 1,
    },
    ticket,
    tickets: harness.tickets,
    workdir: dir,
    runId: "r",
    branch: "matrix/t",
    idempotencyKey: "k",
    signal: new AbortController().signal,
    emit: () => {},
    stillOwner: async () => true,
    authorize: async () => ({ ok: false, kind: "gates", reason: "not used" }),
    scratchDir: async () => dir,
  };
}

test("computes SHAs, changed files, diff and ADRs host-side (real git)", async () => {
  const setup = await repo();
  try {
    const trusted = new TrustedWorktrees(join(setup.root, "registry.json"));
    vi.spyOn(trusted, "lookup").mockResolvedValue({
      gitdir: join(setup.dir, ".git"),
      commonDir: join(setup.dir, ".git"),
    });
    const port = new WorktreeGitPort({ trusted });
    vi.spyOn(port, "headSha").mockResolvedValue(setup.headSha);
    const result = await hostReviewContext(context(setup.dir), port, trusted, setup.root);
    expect(result).toMatchObject({
      baseBranch: "main",
      baseSha: setup.baseSha,
      mergeBase: setup.baseSha,
      headSha: setup.headSha,
      changedFiles: ["app.ts", "film.ts"],
      diffTruncated: false,
    });
    expect(result.diff).toContain("+export const film = true;");
    expect(result.docs).toEqual([
      { path: "docs/adr/0001-layers.md", content: "# Layers\nUI never imports db.\n" },
    ]);
    expect(result.graph).toBeUndefined();
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("refuses an option-shaped base branch", async () => {
  const setup = await repo();
  try {
    const trusted = new TrustedWorktrees(join(setup.root, "registry.json"));
    const ctx = context(setup.dir);
    ctx.project = { ...ctx.project, baseBranch: "--output=/tmp/x" };
    await expect(
      hostReviewContext(ctx, new WorktreeGitPort({ trusted }), trusted, setup.root),
    ).rejects.toThrow("not a safe ref");
  } finally {
    await rm(setup.root, { recursive: true, force: true });
  }
});
