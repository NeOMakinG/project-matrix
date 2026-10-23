import { join } from "node:path";
import type { DependencySetupPort, PhaseContext, Receipt, Sandbox } from "@matrix/core";
import {
  cacheKey,
  copyTree,
  dependencyDirs,
  projectCacheDir,
  realDir,
  restoreInstall,
  storeInstall,
  type TreeCopy,
} from "./deps-cache.js";
import type { SetupStep } from "./existing-repo.js";
import { detectSetup, REGISTRY_HOSTS } from "./setup-detect.js";

/** Host-side setup settings of an existing repo (`matrix.repo.setup` / `setupScripts`). */
export interface SetupPolicy {
  /** Operator steps; undefined = detect from lockfiles; [] = no setup. */
  steps?: SetupStep[];
  /** Allow dependency lifecycle scripts in detected installs (default: `--ignore-scripts`). */
  scripts?: boolean;
}

export interface DependencySetupOptions {
  sandbox: Sandbox;
  /** Host directory holding cached installs, keyed by (project, lockfile hash). */
  cacheRoot: string;
  /** Setup policy of a project; undefined = no dependency setup (Matrix-created repos). */
  policy: (ctx: PhaseContext) => SetupPolicy | undefined;
  timeoutMs?: number;
  copy?: TreeCopy;
}

const tail = (text: string) => text.trim().split("\n").slice(-15).join("\n").slice(-4000);

/**
 * Installs dependencies in the run worktree before checks: each step runs in the sandbox with
 * egress limited to the package registries, argv only, its `cwd` mounted as the workdir. A
 * successful pinned install is cached on the host per (project, cwd, argv, manifest + lockfile
 * bytes) and later copied into fresh worktrees instead of reinstalling.
 */
export function dependencySetup(opts: DependencySetupOptions): DependencySetupPort {
  const copy = opts.copy ?? copyTree;
  return async (ctx, stage) => {
    const policy = opts.policy(ctx);
    if (!policy) return { ok: true, summary: "no dependency setup", receipts: [] };
    const steps =
      policy.steps ?? (await detectSetup(ctx.workdir, ctx.project.checks, policy.scripts));
    const receipts: Receipt[] = [];
    const projectDir = projectCacheDir(opts.cacheRoot, ctx.project.id);
    for (const step of steps) {
      const cwd = step.cwd ?? ".";
      const label = `setup ${cwd}: ${step.run.join(" ")}`;
      if (!(await realDir(ctx.workdir, cwd))) {
        receipts.push({ kind: "log", ok: false, summary: `${label}: directory missing` });
        return { ok: false, summary: `${label}: directory missing or symlinked`, receipts };
      }
      const key = await cacheKey(ctx.workdir, ctx.project.id, cwd, step.run);
      if (key) {
        const restored = await restoreInstall(join(projectDir, key), ctx.workdir, copy).catch(
          () => false as const,
        );
        if (restored) {
          ctx.emit(`${label} (restored from cache)`, "tool");
          receipts.push({ kind: "log", ok: true, summary: `${label}: restored from cache` });
          continue;
        }
      }
      ctx.emit(label, "tool");
      const workdir = cwd === "." ? ctx.workdir : join(ctx.workdir, cwd);
      const res = await opts.sandbox.exec(
        {
          workdir,
          cmd: step.run,
          env: { CI: "true", npm_config_update_notifier: "false" },
          network: "allowlist",
          allowHosts: REGISTRY_HOSTS,
          timeoutMs: opts.timeoutMs ?? 15 * 60_000,
          maxOutputBytes: 256 * 1024,
        },
        ctx.signal,
      );
      const output = tail(`${res.stdout}\n${res.stderr}`);
      receipts.push({
        kind: "log",
        ok: res.code === 0,
        summary: `${label}: exit ${res.code}`,
        data: { cmd: step.run, cwd, output },
      });
      if (res.code !== 0) return { ok: false, summary: `${label} exit ${res.code}`, receipts };
      // Only checks install on the cleaned committed tree (cleanForChecks wiped every untracked
      // node_modules); an implement-stage worktree may hold agent-planted files a non-wiping
      // installer (yarn/pnpm/bun) keeps, so it never feeds the shared cache.
      if (key && stage === "checks") {
        const dirs = await dependencyDirs(ctx.workdir, cwd);
        // A cache write failure only costs speed next time; the install itself succeeded.
        if (dirs.length)
          await storeInstall(projectDir, key, ctx.workdir, dirs, copy).catch(() => undefined);
      }
    }
    return {
      ok: true,
      summary: steps.length ? `${steps.length} setup step(s) done` : "nothing to set up",
      receipts,
    };
  };
}
