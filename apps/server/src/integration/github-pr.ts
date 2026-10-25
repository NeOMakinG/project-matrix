import { tmpdir } from "node:os";
import { sep } from "node:path";
import type { MergePort, PullRequestPort, PullRequestRequest, Receipt } from "@matrix/core";
import { redact } from "@matrix/monitor";
import {
  gitLocation,
  hostExecutor,
  type LineExecutor,
  runToCompletion,
  safeGitEnv,
} from "@matrix/sandbox";
import { PrivateState } from "../private-state.js";
import type { PrivateStateOwner } from "../state-owner.js";
import { validBranch } from "./existing-repo.js";
import type { StoredProject } from "./mapping.js";
import { pullRequestBody, pullRequestBranch, pullRequestTitle } from "./pr-text.js";

export interface PullRequestRecord {
  projectId: string;
  ticketId: string;
  branch: string;
  headSha: string;
  url: string;
  at: string;
}

export interface GitHubPullRequestsOptions {
  /** Host-side record of opened PRs (never inside a product repo). */
  stateFile?: string;
  stateOwner?: PrivateStateOwner;
  /** Absolute paths recommended; `gh` is also git's credential helper for https pushes. */
  gitBinary?: string;
  ghBinary?: string;
  executor?: LineExecutor;
  /** Secret gate over exactly the commits being pushed; a failing receipt refuses the push. */
  scan?: (repoPath: string, range: string) => Promise<Receipt>;
  /** Minimum delay between two attempts for one ticket after a failure. */
  retryMs?: number;
  clock?: () => Date;
}

const SHA = /^[0-9a-f]{40}$/;
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/\d{1,9}$/;
/** Env passed to gh: its auth/config only, never the server's own secrets. */
const GH_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "XDG_CONFIG_HOME", "GH_HOST"];

interface GhPull {
  url?: unknown;
  state?: unknown;
  headRefOid?: unknown;
}

/** The external-repo settings of a project; undefined for greenfield projects. */
export function externalRepo(project: PullRequestRequest["project"]) {
  return (project as StoredProject).matrix?.repo;
}

/**
 * Pushes a validated run head to `matrix-<ticket>-<slug>` on the project's GitHub remote and opens
 * a DRAFT pull request with `gh` (host-side, argv only, never in a sandbox). Idempotent: an
 * existing open (or merged) PR for the branch is reused. Never merges, never force-pushes, never
 * pushes the base branch.
 */
export class GitHubPullRequests implements PullRequestPort {
  readonly #o: GitHubPullRequestsOptions;
  readonly #state: PrivateState<{ prs: PullRequestRecord[] }>;
  readonly #records = new Map<string, PullRequestRecord>();
  readonly #failedAt = new Map<string, number>();
  readonly #inflight = new Map<string, Promise<{ url: string; branch: string } | undefined>>();

  constructor(options: GitHubPullRequestsOptions = {}) {
    this.#o = options;
    // gh doubles as git's credential helper (`!<gh> auth git-credential`, run by a shell).
    if (options.ghBinary && !/^[A-Za-z0-9/._][A-Za-z0-9/._-]*$/.test(options.ghBinary))
      throw new Error("MATRIX_GH must be a plain path (letters, digits, / . _ -)");
    this.#state = new PrivateState(options.stateFile, options.stateOwner);
    for (const pr of this.#state.load({ prs: [] }).prs) this.#records.set(this.#key(pr), pr);
  }

  #key(r: { projectId: string; ticketId: string }) {
    return `${r.projectId}\u0000${r.ticketId}`;
  }

  handles(project: PullRequestRequest["project"]): boolean {
    return externalRepo(project) !== undefined;
  }

  /** Adds/removes PR labels (created on the repo when missing). Only labels Matrix owns. */
  async label(
    project: PullRequestRequest["project"],
    url: string,
    add: string[],
    remove: string[],
  ): Promise<void> {
    if (!this.handles(project)) return;
    const m = url.match(
      /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/pull\/(\d{1,9})$/,
    );
    if (!m?.[1] || !m[2] || !PR_URL.test(url)) throw new Error("not a GitHub pull request URL");
    if (m[1].toLowerCase() !== externalRepo(project)?.github?.toLowerCase())
      throw new Error("pull request is not on the project's repository");
    const safe = (l: string) => /^[a-z][a-z0-9:-]{0,40}$/.test(l);
    if (![...add, ...remove].every(safe)) throw new Error("invalid PR label");
    // REST, not `gh pr edit`: its GraphQL query reads classic Projects and fails on repos where
    // GitHub deprecated them. Removals first, so a failure midway never leaves a stale pass.
    const issue = `repos/${m[1]}/issues/${m[2]}/labels`;
    for (const l of remove) {
      try {
        await this.#gh(["api", "-X", "DELETE", `${issue}/${encodeURIComponent(l)}`, "--silent"]);
      } catch (error) {
        // Only GitHub's own "label not on this issue" answer: a 404 for a wrong PR/repo still fails.
        if (!/Label does not exist/.test((error as Error).message)) throw error;
      }
    }
    for (const l of add)
      await this.#gh([
        "label",
        "create",
        l,
        "--repo",
        m[1],
        "--force",
        "--color",
        l.endsWith("failed") ? "d73a4a" : "0e8a16",
      ]);
    if (add.length)
      await this.#gh([
        "api",
        "-X",
        "POST",
        issue,
        ...add.flatMap((l) => ["-f", `labels[]=${l}`]),
        "--silent",
      ]);
  }

  /** The recorded PR of a ticket, if Matrix opened one. */
  record(projectId: string, ticketId: string): PullRequestRecord | undefined {
    return this.#records.get(this.#key({ projectId, ticketId }));
  }

  publish(request: PullRequestRequest) {
    const key = this.#key({ projectId: request.project.id, ticketId: request.ticket.id });
    const running = this.#inflight.get(key);
    if (running) return running;
    const pending = this.#publish(key, request).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, pending);
    return pending;
  }

  async #publish(key: string, request: PullRequestRequest) {
    const repo = externalRepo(request.project);
    if (!repo) return undefined;
    const known = this.#records.get(key);
    if (known && known.headSha === request.headSha) return { url: known.url, branch: known.branch };
    const now = (this.#o.clock?.() ?? new Date()).getTime();
    const failed = this.#failedAt.get(key);
    if (failed !== undefined && now - failed < (this.#o.retryMs ?? 5 * 60_000)) return undefined;
    try {
      const result = await this.#open(request, repo, known?.branch);
      this.#failedAt.delete(key);
      const record: PullRequestRecord = {
        projectId: request.project.id,
        ticketId: request.ticket.id,
        branch: result.branch,
        headSha: request.headSha,
        url: result.url,
        at: new Date(now).toISOString(),
      };
      this.#records.set(key, record);
      this.#state.save({ prs: [...this.#records.values()] });
      return result;
    } catch (error) {
      this.#failedAt.set(key, now);
      throw new Error(redact(error instanceof Error ? error.message : String(error)));
    }
  }

  async #open(
    request: PullRequestRequest,
    repo: NonNullable<ReturnType<typeof externalRepo>>,
    knownBranch: string | undefined,
  ): Promise<{ url: string; branch: string }> {
    const { project, ticket, headSha } = request;
    if (!SHA.test(headSha)) throw new Error("refusing to push: head is not a full commit SHA");
    const gitDir = `${project.repoPath}${sep}.git`;
    if (this.#o.scan) {
      const gate = await this.#o.scan(project.repoPath, `${project.baseBranch}..${headSha}`);
      if (!gate.ok) throw new Error(`secret gate refused the push: ${gate.summary}`);
    }
    await this.#assertNoUrlRewrites(gitDir);
    await this.#assertNoMatrixArtifacts(gitDir, project.baseBranch, headSha);
    // Push to the URL validated at registration, never to whatever the remote name resolves to now.
    const target = `https://github.com/${repo.github}.git`;
    const stem = knownBranch ?? pullRequestBranch(ticket);
    for (let n = 1; n <= 20; n++) {
      const branch = n === 1 ? stem : `${stem}-${n}`;
      if (!branch.startsWith("matrix-") || !validBranch(branch) || branch === project.baseBranch)
        throw new Error(`refusing to push to branch ${JSON.stringify(branch)}`);
      const pulls = await this.#pulls(repo.github, branch);
      const open = pulls.find((p) => p.state === "OPEN");
      const same = pulls.find((p) => p.state === "MERGED" && p.headRefOid === headSha);
      if (same && typeof same.url === "string" && PR_URL.test(same.url))
        return { url: same.url, branch };
      // A merged or closed PR on this branch belongs to earlier work: use a fresh branch.
      if (!open && pulls.length > 0) continue;
      // Plain refspec, no `+`: a diverged remote branch is never overwritten.
      const pushed = await this.#push(gitDir, target, `${headSha}:refs/heads/${branch}`);
      if (!pushed) {
        if (open) throw new Error(`branch ${branch} diverged from its open PR; not force-pushing`);
        continue;
      }
      if (open && typeof open.url === "string" && PR_URL.test(open.url))
        return { url: open.url, branch };
      return { url: await this.#create(request, repo.github, branch), branch };
    }
    throw new Error("no free matrix branch name for this ticket");
  }

  async #create(request: PullRequestRequest, slug: string, branch: string): Promise<string> {
    const { project, ticket, headSha } = request;
    const stdout = await this.#gh(
      [
        "pr",
        "create",
        "--repo",
        slug,
        "--draft",
        "--base",
        project.baseBranch,
        "--head",
        branch,
        "--title",
        pullRequestTitle(ticket),
        "--body-file",
        "-",
      ],
      pullRequestBody({
        ticket,
        headSha,
        evidence: request.evidence,
        linear: (project as StoredProject).matrix?.tickets.kind === "linear",
        manualQa: request.manualQa,
      }),
    );
    const url = stdout
      .split("\n")
      .map((l) => l.trim())
      .reverse()
      .find((l) => PR_URL.test(l));
    if (!url) throw new Error("gh pr create returned no pull request URL");
    return url;
  }

  /** `url.*.insteadOf` / `pushInsteadOf` in repo config could redirect the push: refuse them. */
  async #assertNoUrlRewrites(gitDir: string): Promise<void> {
    const out = await this.#git(gitDir, ["config", "--name-only", "--get-regexp", "^url\\."], true);
    if (out.trim())
      throw new Error("repo config rewrites URLs (url.*.insteadOf); refusing to push");
  }

  /** Matrix state (`.matrix/`) and CI workflows never leave the host in a run branch. */
  async #assertNoMatrixArtifacts(gitDir: string, base: string, headSha: string): Promise<void> {
    const changed = await this.#git(gitDir, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      `refs/heads/${base}...${headSha}`,
      "--",
    ]);
    const bad = changed
      .split("\0")
      .filter(Boolean)
      .filter((path) => path.startsWith(".matrix/") || path.startsWith(".github/workflows/"));
    if (bad.length)
      throw new Error(
        `run branch touches Matrix/CI paths (${bad.slice(0, 5).join(", ")}); refusing to push`,
      );
  }

  /** True when pushed; false when the remote rejected it as non-fast-forward. */
  async #push(gitDir: string, target: string, refspec: string): Promise<boolean> {
    try {
      await this.#git(gitDir, ["push", "--porcelain", "--no-follow-tags", "--", target, refspec]);
      return true;
    } catch (error) {
      if (/non-fast-forward|fetch first|\[rejected\]/.test(String(error))) return false;
      throw error;
    }
  }

  async #pulls(github: string, branch: string): Promise<GhPull[]> {
    const out = await this.#gh([
      "pr",
      "list",
      "--repo",
      github,
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "20",
      "--json",
      "url,state,headRefOid",
    ]);
    const parsed = JSON.parse(out || "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as GhPull[]) : [];
  }

  /**
   * Merge state of a ticket's PR (merges happen on GitHub, by a human). `pending` until a PR for
   * the recorded branch is merged.
   */
  async mergeState(
    project: PullRequestRequest["project"],
    ticketId: string,
  ): Promise<{ merged: boolean; url?: string; mergedHead?: string; moved?: boolean }> {
    const repo = externalRepo(project);
    const known = this.record(project.id, ticketId);
    if (!repo || !known) return { merged: false };
    const merged = (await this.#pulls(repo.github, known.branch)).find((p) => p.state === "MERGED");
    if (!merged) return { merged: false, url: known.url };
    const url = typeof merged.url === "string" && PR_URL.test(merged.url) ? merged.url : known.url;
    const head = typeof merged.headRefOid === "string" ? merged.headRefOid : undefined;
    // Commits added on GitHub after validation were never checked, reviewed or QA'd by Matrix.
    if (head !== known.headSha) return { merged: false, moved: true, url };
    return { merged: true, url, mergedHead: head };
  }

  async #git(gitDir: string, args: string[], allowFailure = false): Promise<string> {
    const gh = this.#o.ghBinary ?? "gh";
    const env = safeGitEnv(this.#passthrough(GH_ENV), [
      // Hardened defaults block network protocols and credentials: allow https + gh's helper only.
      ["protocol.https.allow", "always"],
      ["credential.helper", `!${gh} auth git-credential`],
    ]);
    const result = await runToCompletion(this.#o.executor ?? hostExecutor, {
      cmd: [this.#o.gitBinary ?? "git", ...gitLocation(gitDir), ...args],
      cwd: gitDir,
      env,
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0 && !allowFailure)
      throw new Error(
        redact(`git ${args[0]} failed (${result.exitCode}): ${result.stderrTail.trim()}`),
      );
    return result.stdout.trim();
  }

  async #gh(args: string[], stdin?: string): Promise<string> {
    const env = safeGitEnv({
      ...this.#passthrough(GH_ENV),
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
    });
    const result = await runToCompletion(this.#o.executor ?? hostExecutor, {
      cmd: [this.#o.ghBinary ?? "gh", ...args],
      // Never the product checkout: gh must not pick up its local git config.
      cwd: tmpdir(),
      env,
      timeoutMs: 120_000,
      ...(stdin === undefined ? {} : { stdin }),
    });
    if (result.exitCode !== 0)
      throw new Error(
        redact(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderrTail.trim()}`),
      );
    return result.stdout.trim();
  }

  #passthrough(names: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of names) {
      const value = process.env[name];
      if (value) out[name] = value;
    }
    return out;
  }
}

/**
 * Merge for existing-repo projects: Matrix never merges. The phase (re)opens the draft PR if
 * needed and succeeds only once a human merged it on GitHub; until then it asks for approval
 * again. Greenfield projects keep the local merge port.
 */
export function externalAwareMerge(prs: GitHubPullRequests, local?: MergePort): MergePort {
  return {
    async merge(ctx, request) {
      if (!externalRepo(ctx.project)) {
        if (!local) return { ok: false, summary: "no merge port configured" };
        return local.merge(ctx, request);
      }
      await prs.publish({
        project: ctx.project,
        workflow: ctx.workflow,
        ticket: ctx.ticket,
        headSha: request.headSha,
        evidence: [],
      });
      const state = await prs.mergeState(ctx.project, ctx.ticket.id);
      if (state.moved)
        return {
          ok: false,
          summary: `PR ${state.url ?? ""} was merged with commits Matrix never validated; needs a human`,
          ...(state.url ? { url: state.url } : {}),
        };
      if (state.merged)
        return {
          ok: true,
          summary: `pull request merged on GitHub${state.url ? `: ${state.url}` : ""}`,
          ...(state.url ? { url: state.url } : {}),
          ...(state.mergedHead ? { mergedSha: state.mergedHead } : {}),
        };
      return {
        ok: false,
        pending: true,
        summary: `draft PR ${state.url ?? "(not opened yet)"} is not merged: merge it on GitHub, then approve the merge again`,
        ...(state.url ? { url: state.url } : {}),
      };
    },
  };
}
