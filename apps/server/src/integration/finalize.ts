import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runInit } from "@matrix/cli/init";
import type { MatrixConfig } from "@matrix/config";
import { AutonomyConflictError, type AutonomyMode, type Store } from "@matrix/core";
import type { TicketStore } from "@matrix/tickets";
import { assertSafePath } from "@matrix/tickets/adapters/safe-fs";
import type { InitFinalizeResult } from "../core-port.js";
import { toAnswers } from "../init-progress.js";
import { PrivateState } from "../private-state.js";
import type { PrivateStateOwner } from "../state-owner.js";
import { mirrorBacklog, type TrackerJournal } from "./finalize-tracker.js";
import type { StoredProject } from "./mapping.js";
import { publishOwnedFile } from "./owned-files.js";

type Generated = Extract<Awaited<ReturnType<typeof runInit>>, { status: "ok" }>;
export interface FinalizeJournal extends TrackerJournal {
  sessionId?: string;
  inputHash: string;
  effectiveHash?: string;
  generated: Generated;
  files: Record<string, string>;
  policyVersion?: string;
  previousFiles?: Record<string, string>;
  completed?: {
    result: InitFinalizeResult;
    project: StoredProject;
    effectiveAnswers?: Record<string, unknown>;
  };
}

async function generatedFiles(root: string, directory = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await generatedFiles(root, path));
    else if (entry.isFile()) files[path] = await readFile(join(root, path), "utf8");
    else throw new Error("generator produced a non-regular file");
  }
  return files;
}

const run = promisify(execFile);
const answersHash = (answers: Record<string, unknown>) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(answers).sort(([left], [right]) => left.localeCompare(right)),
        ),
      ),
    )
    .digest("hex");

const AUTONOMY: Record<MatrixConfig["process"]["autonomy"]["merge"], AutonomyMode> = {
  human: "human",
  "gated-auto": "gated",
  autonomous: "autonomous",
};

/**
 * Generates the project from interview answers (M1 generator: matrix.config.ts, ADRs, CONTEXT.md,
 * product graph, scaffold, backlog) into the project repo, copies the backlog into the project's own
 * tracker when it isn't markdown, applies process settings to the project and commits the result.
 */
export async function finalizeProject(input: {
  sessionId: string;
  completedCommit?: string;
  project: StoredProject;
  answers: Record<string, unknown>;
  /** Fill unanswered questions with their recommended answer. */
  acceptRecommended: boolean;
  store: Store;
  tickets: TicketStore;
  journalFile?: string | undefined;
  stateOwner?: PrivateStateOwner | undefined;
}): Promise<{
  result: InitFinalizeResult;
  project: StoredProject;
  effectiveAnswers?: Record<string, unknown>;
}> {
  const owner = input.stateOwner;
  if (input.journalFile && !owner)
    throw new Error("durable finalize journal requires lifetime ownership");
  const check = () => owner?.assertOwned();
  check();
  const snapshot = await input.store.getProjectPolicy(input.project.id);
  check();
  const project = snapshot.project as StoredProject;
  const explicit = snapshot.history.filter((change) => change.actor !== "init");
  const answers = { ...input.answers };
  if (explicit.length) {
    for (const phase of ["merge", "deploy"] as const) {
      const mode = project.autonomy[phase] ?? project.autonomy.default;
      answers[`process.autonomy.${phase}`] = mode === "gated" ? "gated-auto" : mode;
    }
  }
  const chosenTracker = input.answers["process.tickets"] ?? input.tickets.kind;
  if (chosenTracker !== input.tickets.kind)
    return {
      result: {
        status: "invalid",
        issues: [
          {
            path: "process.tickets",
            message:
              "tracker migration is not supported during finalize; use the configured project tracker",
          },
        ],
      },
      project,
    };
  const state = new PrivateState<FinalizeJournal | null>(input.journalFile, owner);
  let journal = state.load(null);
  const inputHash = answersHash(input.answers);
  const legacyHash = createHash("sha256").update(JSON.stringify(input.answers)).digest("hex");
  const sameSession =
    !journal ||
    journal.sessionId === input.sessionId ||
    (!journal.sessionId &&
      input.completedCommit !== undefined &&
      journal.completed?.result.status === "ok" &&
      input.completedCommit === journal.completed.result.commit);
  if (
    journal &&
    (!sameSession ||
      (![journal.inputHash, journal.effectiveHash, answersHash(journal.generated.answers)].includes(
        inputHash,
      ) &&
        journal.inputHash !== legacyHash))
  )
    return {
      result: {
        status: "invalid",
        issues: [
          {
            path: "answers",
            message:
              "generation is bound to another interview or input; retry the same interview and answers",
          },
        ],
      },
      project,
    };
  if (journal?.completed && journal.policyVersion === snapshot.version)
    return { ...journal.completed, project, effectiveAnswers: journal.generated.answers };
  if (
    journal?.completed?.result.status === "ok" &&
    journal.completed.result.tickets.length > 0 &&
    input.tickets.kind !== "markdown" &&
    !journal.ticketMap
  )
    throw new Error("legacy external backlog has no durable ID map; reconcile before retrying");
  const reuse = journal?.policyVersion === snapshot.version;
  const staging = reuse ? undefined : await mkdtemp(join(tmpdir(), "matrix-finalize-"));
  if (staging && journal) {
    check();
    for (const [path, content] of Object.entries(journal.files)) {
      const target = join(staging, path);
      publishOwnedFile({ root: staging, path: target, content, owner });
    }
  }
  const generate = () =>
    runInit({
      answers: toAnswers({ ...answers, "process.tickets": chosenTracker }),
      outDir: staging as string,
      acceptRecommended: input.acceptRecommended,
      scaffold: true,
      force: Boolean(journal),
    });
  const outcome =
    (reuse ? journal?.generated : undefined) ??
    (owner ? await owner.guard(generate) : await generate());
  check();
  if (outcome.status === "missing") {
    return { result: { status: "missing", missing: outcome.missing.map((q) => q.id) }, project };
  }
  if (outcome.status === "contradictions") {
    return {
      result: {
        status: "contradictions",
        contradictions: outcome.contradictions.map((c) => ({
          id: c.id,
          message: c.message,
          questions: c.questions,
        })),
      },
      project,
    };
  }
  if (outcome.status === "invalid")
    return { result: { status: "invalid", issues: outcome.issues }, project };
  if (outcome.status === "conflicts") {
    return {
      result: {
        status: "invalid",
        issues: outcome.files.map((f) => ({ path: f, message: "already exists" })),
      },
      project,
    };
  }

  if (
    outcome.warnings.some((warning) =>
      /not generated|no scaffold pack|only supports/i.test(warning),
    )
  )
    return {
      result: {
        status: "invalid",
        issues: outcome.warnings.map((message) => ({ path: "stack", message })),
      },
      project,
    };

  if ((await input.store.getProjectPolicy(project.id)).version !== snapshot.version)
    throw new AutonomyConflictError();
  check();
  const files = reuse ? journal!.files : await generatedFiles(staging as string);
  const previousFiles: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    const target = join(project.repoPath, path);
    await assertSafePath(project.repoPath, target);
    try {
      const entry = await lstat(target);
      const existing = entry.isFile() ? await readFile(target, "utf8") : undefined;
      if (
        !journal ||
        existing === undefined ||
        (existing !== journal.files[path] && existing !== journal.previousFiles?.[path])
      )
        return {
          result: {
            status: "invalid",
            issues: [{ path, message: "already exists; refusing to overwrite" }],
          },
          project,
        };
      previousFiles[path] = existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  journal = {
    sessionId: input.sessionId,
    inputHash,
    effectiveHash: answersHash(outcome.answers),
    ...(journal?.ticketMap ? { ticketMap: journal.ticketMap } : {}),
    ...(journal?.ticketIntents ? { ticketIntents: journal.ticketIntents } : {}),
    generated: outcome,
    files,
    previousFiles,
    policyVersion: snapshot.version,
  };
  state.save(journal);
  const tickets =
    input.tickets.kind === "markdown"
      ? outcome.tickets
      : await mirrorBacklog({
          projectId: project.id,
          sessionId: input.sessionId,
          journal,
          tickets: input.tickets,
          stateOwner: owner,
          save: () => state.save(journal),
        });
  check();
  for (const [path, content] of Object.entries(files)) {
    const target = join(project.repoPath, path);
    publishOwnedFile({
      root: project.repoPath,
      path: target,
      content,
      previous: journal.previousFiles?.[path],
      owner,
    });
  }

  const config = outcome.config;
  const updated: StoredProject = {
    ...project,
    autonomy: {
      ...project.autonomy,
      merge: AUTONOMY[config.process.autonomy.merge],
      deploy: AUTONOMY[config.process.autonomy.deploy],
    },
    reviewLanes: config.process.reviewLanes,
    dailyBudgetUsd: config.process.budgets.dailyUsd,
  };

  const git = async (...args: string[]) => {
    check();
    const result = await run("git", ["-C", project.repoPath, ...args], { signal: owner?.signal });
    check();
    return result.stdout.trim();
  };
  const staged = (await git("diff", "--cached", "--name-only")).split("\n").filter(Boolean);
  if (staged.some((path) => !Object.hasOwn(files, path)))
    throw new Error("project has unrelated staged changes; refusing to commit");
  await git("add", "--", ...Object.keys(files));
  const dirty = await git("diff", "--cached", "--name-only");
  if (dirty)
    await git("commit", "-q", "-m", "chore: project generated by the Matrix init interview");
  const commit = await git("rev-parse", "HEAD");
  check();
  const saved = await input.store.saveInitializedProject(
    updated,
    {
      merge: AUTONOMY[config.process.autonomy.merge],
      deploy: AUTONOMY[config.process.autonomy.deploy],
    },
    snapshot.version,
  );
  check();

  const completed: NonNullable<FinalizeJournal["completed"]> = {
    result: { status: "ok", files: outcome.files, tickets, warnings: outcome.warnings, commit },
    project: saved.project as StoredProject,
    effectiveAnswers: outcome.answers,
  };
  state.save({ ...journal, policyVersion: saved.version, completed });
  return completed;
}
