import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { PhaseContext, ReviewContext } from "@matrix/core";
import { GRAPH_MD_PATH } from "@matrix/graph";
import { gitLocation, safeGitEnv } from "@matrix/sandbox";
import { safeSegment, type TrustedWorktrees, type WorktreeGitPort } from "@matrix/workspace";

const execute = promisify(execFile);

const MAX_DIFF_CHARS = 150_000;
const MAX_CHANGED_FILES = 500;
const MAX_DOC_BYTES = 20_000;
const MAX_DOCS_TOTAL = 60_000;
const MAX_GRAPH_CHARS = 20_000;
/** Architecture docs read from the reviewed commit (markdown only). */
const DOC_PATHS = ["docs/adr", "CONTEXT.md", "ARCHITECTURE.md", "AGENTS.md"];

const cut = (text: string, max: number) =>
  text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };

/**
 * Computes, host-side through the trusted gitdir, everything a review lane needs about the
 * change: base/merge-base/head SHAs, changed files, the diff, ADRs and the derived code graph.
 * Review sandboxes carry no git metadata, so this is the only way lanes see the change.
 */
export async function hostReviewContext(
  ctx: PhaseContext,
  git: WorktreeGitPort,
  trusted: TrustedWorktrees,
  dataDir: string,
): Promise<ReviewContext> {
  const base = ctx.project.baseBranch;
  if (!/^[A-Za-z0-9._/-]+$/.test(base) || base.startsWith("-") || base.includes(".."))
    throw new Error("base branch name is not a safe ref");
  const headSha = await git.headSha(ctx.workdir);
  const { gitdir } = await trusted.lookup(ctx.workdir);
  const run = async (args: string[], maxBuffer = 32 * 1024 ** 2) =>
    (
      await execute("git", [...gitLocation(gitdir), ...args], {
        cwd: gitdir,
        env: safeGitEnv(),
        signal: ctx.signal,
        encoding: "buffer",
        maxBuffer,
        timeout: 60_000,
      })
    ).stdout;
  const sha = async (ref: string) =>
    (await run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).toString("utf8").trim();
  const baseSha = await sha(`refs/heads/${base}`).catch(() => sha(`refs/remotes/origin/${base}`));
  const mergeBase = (await run(["merge-base", baseSha, headSha])).toString("utf8").trim();
  const changedFiles = (
    await run(["diff", "--name-only", "-z", "--no-renames", mergeBase, headSha])
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  // A diff the host cannot read in full is still reviewed: the lanes are told it was truncated.
  let diffFailed = false;
  const rawDiff = await run(
    ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", mergeBase, headSha],
    64 * 1024 ** 2,
  ).catch(() => {
    ctx.signal.throwIfAborted();
    diffFailed = true;
    return Buffer.from("[the host could not read the full diff]");
  });
  const diff = cut(rawDiff.toString("utf8"), MAX_DIFF_CHARS);
  const docs: ReviewContext["docs"] = [];
  let docBytes = 0;
  const listing = (await run(["ls-tree", "-r", "-z", "-l", headSha, "--", ...DOC_PATHS]))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const record of listing) {
    const tab = record.indexOf("\t");
    const [, type, blob, size] = record.slice(0, tab).split(/ +/);
    const path = record.slice(tab + 1);
    if (type !== "blob" || !blob || !/\.md$/i.test(path)) continue;
    if (Number(size) > MAX_DOC_BYTES || docBytes + Number(size) > MAX_DOCS_TOTAL) continue;
    const content = (await run(["cat-file", "blob", blob])).toString("utf8");
    docBytes += Buffer.byteLength(content);
    docs.push({ path, content });
  }
  const graph = await readGraph(dataDir, ctx.project.id).catch(() =>
    run(["cat-file", "blob", `${headSha}:${GRAPH_MD_PATH}`]).then(
      (out) => out.toString("utf8"),
      () => undefined,
    ),
  );
  return {
    baseBranch: base,
    baseSha,
    mergeBase,
    headSha,
    changedFiles: changedFiles.slice(0, MAX_CHANGED_FILES),
    diff: diff.text,
    diffTruncated: diffFailed || diff.truncated || changedFiles.length > MAX_CHANGED_FILES,
    docs,
    ...(graph ? { graph: cut(graph, MAX_GRAPH_CHARS).text } : {}),
  };
}

/** Existing repos keep the derived graph under the Matrix state dir (see keepGraphHostSide). */
async function readGraph(dataDir: string, projectId: string): Promise<string> {
  return readFile(
    join(dataDir, "projects", safeSegment(projectId), "graph", basename(GRAPH_MD_PATH)),
    "utf8",
  );
}
