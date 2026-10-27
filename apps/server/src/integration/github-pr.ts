import { tmpdir } from "node:os";
import { sep } from "node:path";
import {
  type BaseState,
  type MergePort,
  mergeBlockingChecks,
  type PullRequestFacts,
  type PullRequestPort,
  type PullRequestRequest,
  type Receipt,
} from "@matrix/core";
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
  /** Earlier heads Matrix itself pushed to this branch (newest last, at most 20). */
  previous?: string[];
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

function prNumber(url: string): { repo: string; number: number } {
  const m = url.match(/^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/pull\/(\d{1,9})$/);
  if (!m?.[1] || !m[2]) throw new Error("not a GitHub pull request URL");
  return { repo: m[1], number: Number(m[2]) };
}

/** The external-repo settings of a project; undefined for greenfield projects. */
export function externalRepo(project: PullRequestRequest["project"]) {
  return (project as StoredProject).matrix?.repo;
}

/**
 * Pushes a validated run head to `matrix-<ticket>-<slug>` on the project's GitHub remote and opens
 * a DRAFT pull request with `gh` (host-side, argv only, never in a sandbox). Idempotent: an
 * existing open (or merged) PR for the branch is reused. Force-pushes only with a lease on the head
 * Matrix itself published (a rebased head); never pushes the base branch. Merges only through
 * `autoMerge` (deploy.merge: "auto").
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

  /**
   * The PR's description, changed files and head checks, plus the checks failing on the base
   * branch tip (those are pre-existing). Read-only REST calls; for the agent QA code/CI criteria.
   */
  async facts(project: PullRequestRequest["project"], url: string): Promise<PullRequestFacts> {
    const m = url.match(
      /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/pull\/(\d{1,9})$/,
    );
    if (!m?.[1] || !m[2] || !PR_URL.test(url)) throw new Error("not a GitHub pull request URL");
    if (m[1].toLowerCase() !== externalRepo(project)?.github?.toLowerCase())
      throw new Error("pull request is not on the project's repository");
    const repo = m[1];
    const pr = JSON.parse(await this.#gh(["api", `repos/${repo}/pulls/${m[2]}`])) as {
      body?: string | null;
      head?: { sha?: string };
      base?: { ref?: string };
    };
    const headSha = pr.head?.sha ?? "";
    const baseRef = pr.base?.ref ?? "";
    if (!/^[a-f0-9]{40}$/.test(headSha) || !/^[\w./-]{1,100}$/.test(baseRef))
      throw new Error("GitHub returned no head SHA or base branch for the PR");
    const files = (
      await this.#ghItems<{
        filename?: string;
        status?: string;
        additions?: number;
        patch?: string;
      }>(`repos/${repo}/pulls/${m[2]}/files?per_page=100`, ".[]")
    )
      .slice(0, 3_000)
      .map((f) => ({
        path: String(f.filename ?? ""),
        status: String(f.status ?? ""),
        additions: Number(f.additions ?? 0),
        ...(typeof f.patch === "string" ? { patch: f.patch.slice(0, 200_000) } : {}),
      }));
    const checks = await this.#checks(repo, headSha);
    const base = await this.#checks(repo, encodeURIComponent(baseRef)).catch(() => []);
    return {
      headSha,
      body: String(pr.body ?? "").slice(0, 60_000),
      files,
      checks,
      baseFailing: base.filter((c) => c.state === "failure").map((c) => c.name),
    };
  }

  /**
   * Every item of a paginated list, one JSON value per line (`--jq`), so it works on gh versions
   * without `--slurp` (2.46 on the Matrix host).
   */
  async #ghItems<T>(endpoint: string, jq: string): Promise<T[]> {
    const out = await this.#gh(["api", "--paginate", "--jq", jq, endpoint]);
    return out
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as T);
  }

  /** Check runs and commit statuses of one ref, latest per name. */
  async #checks(repo: string, ref: string): Promise<PullRequestFacts["checks"]> {
    // Every page: a failing check past the first 100 must not read as green.
    const runs = await this.#ghItems<{
      name?: string;
      status?: string;
      conclusion?: string | null;
    }>(`repos/${repo}/commits/${ref}/check-runs?per_page=100`, ".check_runs[]");
    const statuses = await this.#ghItems<{ context?: string; state?: string }>(
      `repos/${repo}/commits/${ref}/statuses?per_page=100`,
      ".[]",
    );
    const out = new Map<string, PullRequestFacts["checks"][number]["state"]>();
    // Same name from several apps, or a run and a status: the worst result stands.
    const rank = { failure: 3, pending: 2, neutral: 1, success: 0 } as const;
    const keep = (name: string, state: PullRequestFacts["checks"][number]["state"]) => {
      const was = out.get(name);
      if (!was || rank[state] > rank[was]) out.set(name, state);
    };
    for (const r of runs) {
      const name = String(r.name ?? "");
      if (!name) continue;
      const c = r.conclusion ?? "";
      keep(
        name,
        r.status !== "completed"
          ? "pending"
          : c === "success"
            ? "success"
            : ["neutral", "skipped"].includes(c)
              ? "neutral"
              : "failure",
      );
    }
    // Statuses come newest first: only the first one per context is its current state.
    const seen = new Set<string>();
    for (const s of statuses) {
      const name = String(s.context ?? "");
      if (!name || seen.has(name)) continue;
      seen.add(name);
      keep(name, s.state === "success" ? "success" : s.state === "pending" ? "pending" : "failure");
    }
    return [...out].map(([name, state]) => ({ name, state }));
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
      const result = await this.#open(request, repo, known?.branch, known?.headSha);
      this.#failedAt.delete(key);
      const record: PullRequestRecord = {
        projectId: request.project.id,
        ticketId: request.ticket.id,
        branch: result.branch,
        headSha: request.headSha,
        url: result.url,
        at: new Date(now).toISOString(),
        previous: known
          ? [...(known.previous ?? []), known.headSha]
              .filter((sha) => sha !== request.headSha)
              .slice(-20)
          : [],
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
    knownHead?: string,
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
      let pushed = await this.#push(gitDir, target, `${headSha}:refs/heads/${branch}`);
      // A head Matrix rebased (or re-applied after a conflict) replaces the head Matrix itself
      // published, and only that: the lease fails if anyone else pushed to the branch since.
      if (!pushed && open && knownBranch === branch && knownHead && SHA.test(knownHead))
        pushed = await this.#push(
          gitDir,
          target,
          `${headSha}:refs/heads/${branch}`,
          `--force-with-lease=refs/heads/${branch}:${knownHead}`,
        );
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
  async #push(gitDir: string, target: string, refspec: string, lease?: string): Promise<boolean> {
    try {
      await this.#git(gitDir, [
        "push",
        "--porcelain",
        "--no-follow-tags",
        ...(lease ? [lease] : []),
        "--",
        target,
        refspec,
      ]);
      return true;
    } catch (error) {
      if (/non-fast-forward|fetch first|stale info|\[rejected\]/.test(String(error))) return false;
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
   * GitHub state of the PR Matrix recorded for a ticket (read-only), for the cleanup sweep.
   * Undefined when Matrix never opened one; throws when GitHub cannot be read.
   */
  async prState(
    projectId: string,
    ticketId: string,
  ): Promise<
    | { state: "MERGED" | "CLOSED" | "OPEN"; headRefOid?: string; url: string; closedAt?: number }
    | undefined
  > {
    const known = this.record(projectId, ticketId);
    if (!known || !PR_URL.test(known.url)) return undefined;
    const out = await this.#gh(["pr", "view", known.url, "--json", "state,headRefOid,closedAt"]);
    const pr = JSON.parse(out || "{}") as {
      state?: unknown;
      headRefOid?: unknown;
      closedAt?: unknown;
    };
    const closedAt = typeof pr.closedAt === "string" ? Date.parse(pr.closedAt) : Number.NaN;
    if (pr.state !== "MERGED" && pr.state !== "CLOSED" && pr.state !== "OPEN")
      throw new Error(`unexpected PR state for ${ticketId}`);
    return {
      state: pr.state,
      url: known.url,
      ...(Number.isFinite(closedAt) ? { closedAt } : {}),
      ...(typeof pr.headRefOid === "string" && SHA.test(pr.headRefOid)
        ? { headRefOid: pr.headRefOid }
        : {}),
    };
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

  /**
   * Auto-merge (ADR 0007, `deploy.merge: "auto"` only): re-reads the PR on GitHub, requires its
   * head to be exactly the validated SHA and every check on it green, marks the draft ready and
   * squash-merges with `--match-head-commit` (GitHub refuses if the head moved). Never pushes.
   */
  async autoMerge(
    project: PullRequestRequest["project"],
    ticketId: string,
    headSha: string,
  ): Promise<
    | { kind: "merged"; url: string; mergeCommit: string }
    | { kind: "pending"; reason: string; url?: string }
    | { kind: "refused"; reason: string; url?: string }
  > {
    const known = this.record(project.id, ticketId);
    if (!known) return { kind: "pending", reason: "no draft PR recorded yet" };
    if (!SHA.test(headSha) || known.headSha !== headSha)
      return {
        kind: "refused",
        reason: `the published PR head ${known.headSha.slice(0, 12)} is not the validated ${headSha.slice(0, 12)}`,
        url: known.url,
      };
    const facts = await this.facts(project, known.url);
    if (facts.headSha !== headSha)
      return {
        kind: "refused",
        reason: `GitHub reports head ${facts.headSha.slice(0, 12)}, not the validated ${headSha.slice(0, 12)}`,
        url: known.url,
      };
    // Relevant CI only (same rule as the QA "CI" criterion): deploy previews and failures the
    // base branch shares are pre-existing and never block.
    const blocking = mergeBlockingChecks(facts);
    const failing = blocking.failing;
    if (failing.length)
      return {
        kind: "refused",
        reason: `checks failing on ${headSha.slice(0, 12)}: ${failing.join(", ").slice(0, 200)}`,
        url: known.url,
      };
    const pending = blocking.pending;
    if (!facts.checks.length || pending.length)
      return {
        kind: "pending",
        reason: facts.checks.length
          ? `checks still running on ${headSha.slice(0, 12)}: ${pending.join(", ").slice(0, 200)}`
          : `no checks reported on ${headSha.slice(0, 12)} yet`,
        url: known.url,
      };
    const { repo, number } = prNumber(known.url);
    const pr = await this.#pull(repo, number);
    if (pr.merged) {
      if (pr.headSha !== headSha)
        return { kind: "refused", reason: "PR was merged at another head", url: known.url };
      return { kind: "merged", url: known.url, mergeCommit: pr.mergeCommit };
    }
    if (pr.state !== "open")
      return { kind: "refused", reason: `PR is ${pr.state}`, url: known.url };
    if (pr.draft) await this.#gh(["pr", "ready", String(number), "--repo", repo]);
    await this.#gh([
      "pr",
      "merge",
      String(number),
      "--repo",
      repo,
      "--squash",
      "--match-head-commit",
      headSha,
    ]);
    const after = await this.#pull(repo, number);
    if (!after.merged || !SHA.test(after.mergeCommit))
      return { kind: "pending", reason: "GitHub has not recorded the merge yet", url: known.url };
    return { kind: "merged", url: known.url, mergeCommit: after.mergeCommit };
  }

  /**
   * Whether the published PR of `headSha` merges into its base as is. Conflicting (`dirty`) or
   * `behind` a base the repo requires up to date: the base tip is fetched host-side (remote-tracking
   * ref, and the local base branch fast-forwarded when that is safe) and returned for a rebase.
   */
  async baseState(
    project: PullRequestRequest["project"],
    ticketId: string,
    headSha: string,
  ): Promise<BaseState> {
    const repo = externalRepo(project);
    const known = this.record(project.id, ticketId);
    if (!repo?.github || !known) return { kind: "wait", reason: "no PR published yet" };
    if (known.headSha !== headSha)
      return { kind: "wait", reason: `the PR head is not ${headSha.slice(0, 12)} yet` };
    const { repo: slug, number } = prNumber(known.url);
    const pr = await this.#pull(slug, number);
    if (pr.merged || pr.state !== "open") return { kind: "current" };
    if (pr.headSha !== headSha)
      return { kind: "wait", reason: `GitHub reports head ${pr.headSha.slice(0, 12)}` };
    const conflict = pr.mergeable === false || pr.mergeableState === "dirty";
    const behind = pr.mergeableState === "behind";
    if (pr.mergeable === null && !behind)
      return { kind: "wait", reason: "GitHub is still computing mergeability" };
    if (!conflict && !behind) return { kind: "current" };
    const base = pr.baseRef || project.baseBranch;
    if (base !== project.baseBranch || !validBranch(base))
      throw new Error(`PR base ${JSON.stringify(base)} is not the project's base branch`);
    const gitDir = `${project.repoPath}${sep}.git`;
    await this.#assertNoUrlRewrites(gitDir);
    const target = `https://github.com/${repo.github}.git`;
    await this.#git(gitDir, [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--",
      target,
      `+refs/heads/${base}:refs/remotes/origin/${base}`,
    ]);
    const baseSha = await this.#git(gitDir, [
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${base}^{commit}`,
    ]);
    if (!SHA.test(baseSha)) throw new Error("fetched base is not a commit");
    await this.#fastForwardBase(project.repoPath, gitDir, base, baseSha);
    return {
      kind: "outdated",
      reason: conflict ? `GitHub reports conflicts with ${base}` : `behind ${base}`,
      base,
      baseSha,
    };
  }

  /**
   * The open PR's head when it was pushed outside Matrix (an agent's rebase, a human fix): fetched
   * from GitHub's `refs/pull/N/head` into `refs/matrix/pr/N` with the base tip, so the run
   * worktree can adopt it and re-validate it. Undefined while the PR head is Matrix's own.
   */
  async externalHead(
    project: PullRequestRequest["project"],
    ticketId: string,
  ): Promise<{ headSha: string; forkSha: string } | undefined> {
    const repo = externalRepo(project);
    const known = this.record(project.id, ticketId);
    if (!repo?.github || !known) return undefined;
    const { repo: slug, number } = prNumber(known.url);
    const pr = await this.#pull(slug, number);
    // A head Matrix itself pushed earlier is GitHub lagging behind Matrix's latest push, not an
    // external push.
    if (
      pr.merged ||
      pr.state !== "open" ||
      !SHA.test(pr.headSha) ||
      pr.headSha === known.headSha ||
      known.previous?.includes(pr.headSha)
    )
      return undefined;
    const base = project.baseBranch;
    if (!validBranch(base)) throw new Error("invalid base branch");
    const gitDir = `${project.repoPath}${sep}.git`;
    await this.#assertNoUrlRewrites(gitDir);
    await this.#git(gitDir, [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--",
      `https://github.com/${repo.github}.git`,
      `+refs/pull/${number}/head:refs/matrix/pr/${number}`,
      `+refs/heads/${base}:refs/remotes/origin/${base}`,
    ]);
    const fetched = await this.#git(gitDir, [
      "rev-parse",
      "--verify",
      `refs/matrix/pr/${number}^{commit}`,
    ]);
    if (fetched !== pr.headSha) return undefined; // moved again while fetching: next tick
    const tip = await this.#git(gitDir, [
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${base}^{commit}`,
    ]);
    await this.#fastForwardBase(project.repoPath, gitDir, base, tip);
    // The fork point against today's base tip (possibly older than the author's): the trusted
    // BASE only bounds which commits count as ticket work; a stale fork is rebased before merge.
    const forkSha = await this.#git(gitDir, ["merge-base", tip, fetched]);
    if (!SHA.test(forkSha)) throw new Error("adopted PR head shares no history with the base");
    await this.#assertNoMatrixArtifacts(gitDir, base, fetched);
    return { headSha: fetched, forkSha };
  }

  /**
   * Review context and check baselines diff against the local base branch: keep it on the fetched
   * tip. Fast-forward only; a checked-out base is advanced only with a clean tracked tree.
   */
  async #fastForwardBase(repoPath: string, gitDir: string, base: string, tip: string) {
    const local = await this.#git(
      gitDir,
      ["rev-parse", "--verify", "--quiet", `refs/heads/${base}`],
      true,
    );
    if (!SHA.test(local) || local === tip) return;
    // Fast-forward only: the local tip must be the merge-base of itself and the fetched tip.
    if ((await this.#git(gitDir, ["merge-base", local, tip], true)) !== local) return;
    const checkedOut = await this.#git(gitDir, ["symbolic-ref", "--quiet", "HEAD"], true);
    if (checkedOut !== `refs/heads/${base}`) {
      await this.#git(gitDir, ["update-ref", `refs/heads/${base}`, tip, local], true);
      return;
    }
    const tracked = await this.#git(
      gitDir,
      ["--work-tree", repoPath, "status", "--porcelain", "--untracked-files=no"],
      true,
    );
    if (tracked.trim()) return;
    await this.#git(gitDir, ["--work-tree", repoPath, "merge", "--ff-only", "--quiet", tip], true);
  }

  /** The merged PR of a ticket: merge commit on the base branch and the files it changed. */
  async mergedInfo(
    project: PullRequestRequest["project"],
    ticketId: string,
  ): Promise<{ url: string; mergeCommit: string; headSha: string; files: string[] } | undefined> {
    const known = this.record(project.id, ticketId);
    if (!known || !externalRepo(project)) return undefined;
    const { repo, number } = prNumber(known.url);
    const pr = await this.#pull(repo, number);
    if (!pr.merged || !SHA.test(pr.mergeCommit)) return undefined;
    const files = (
      await this.#ghItems<{ filename?: string; previous_filename?: string }>(
        `repos/${repo}/pulls/${number}/files?per_page=100`,
        ".[]",
      )
    ).flatMap((f) => [f.filename, f.previous_filename].filter((x): x is string => !!x));
    return { url: known.url, mergeCommit: pr.mergeCommit, headSha: pr.headSha, files };
  }

  async #pull(
    repo: string,
    number: number,
  ): Promise<{
    state: string;
    draft: boolean;
    merged: boolean;
    mergeCommit: string;
    headSha: string;
    baseRef: string;
    /** GitHub's answer; null while it is still computing. */
    mergeable: boolean | null;
    mergeableState: string;
  }> {
    const pr = JSON.parse(await this.#gh(["api", `repos/${repo}/pulls/${number}`])) as {
      state?: string;
      draft?: boolean;
      merged?: boolean;
      merge_commit_sha?: string | null;
      head?: { sha?: string };
      base?: { ref?: string };
      mergeable?: boolean | null;
      mergeable_state?: string;
    };
    return {
      baseRef: String(pr.base?.ref ?? ""),
      mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
      mergeableState: String(pr.mergeable_state ?? ""),
      state: String(pr.state ?? ""),
      draft: pr.draft === true,
      merged: pr.merged === true,
      mergeCommit: String(pr.merge_commit_sha ?? ""),
      headSha: String(pr.head?.sha ?? ""),
    };
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
 * Merge for existing-repo projects. With `deploy.merge: "auto"` Matrix squash-merges the PR itself
 * once the gate holds; otherwise the phase (re)opens the draft PR and succeeds once the PR was
 * merged on GitHub. Greenfield projects keep the local merge port.
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
      let state = await prs.mergeState(ctx.project, ctx.ticket.id);
      // Auto-merge opt-in: authorize() already required the agent QA PASS on this head.
      if (
        !state.merged &&
        !state.moved &&
        ctx.project.deploy?.merge === "auto" &&
        request.mode === "autonomous"
      ) {
        const auto = await prs.autoMerge(ctx.project, ctx.ticket.id, request.headSha);
        const url = auto.url ? { url: auto.url } : {};
        if (auto.kind === "pending")
          return {
            ok: false,
            pending: true,
            summary: `auto-merge waiting: ${auto.reason}`,
            ...url,
          };
        if (auto.kind === "refused")
          return { ok: false, summary: `auto-merge refused: ${auto.reason}`, ...url };
        state = await prs.mergeState(ctx.project, ctx.ticket.id);
        if (!state.merged)
          return {
            ok: true,
            summary: `pull request squash-merged by Matrix: ${auto.url} (merge commit ${auto.mergeCommit})`,
            url: auto.url,
            mergedSha: auto.mergeCommit,
          };
      }
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
        summary: `draft PR ${state.url ?? "(not opened yet)"} is not merged yet (the project's merge policy is not auto)`,
        ...(state.url ? { url: state.url } : {}),
      };
    },
  };
}
