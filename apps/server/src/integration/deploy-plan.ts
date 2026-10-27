import {
  DEPLOY_CAPABILITIES,
  type DeployCapability,
  type DeployProfile,
  type DeployTarget,
  selectTargets,
} from "@matrix/core";
import { z } from "zod";

/**
 * Host capability map (`MATRIX_DEPLOY_HOSTS`, operator config, never project config): which host
 * holds which deploy CLI and how Matrix reaches it. No credential ever moves between hosts.
 */
export const deployHostsSchema = z.array(
  z.object({
    name: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/),
    transport: z.enum(["local", "ssh", "orca"]),
    /** `user@host` for ssh (BatchMode, no agent forwarding). */
    ssh: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+$/)
      .optional(),
    /**
     * Paired Orca runtime (no SSH): a throwaway worktree + terminal on that machine runs the
     * command with the machine's own CLI auth. `repos` maps GitHub `owner/name` to the absolute
     * path of the Orca-registered checkout there.
     */
    orca: z
      .object({
        environment: z.string().regex(/^[A-Za-z0-9_.-]{1,60}$/),
        repos: z
          .record(
            z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
            z.string().regex(/^\/[^\0\n]{1,300}$/),
          )
          .refine((r) => Object.keys(r).length > 0, "orca.repos needs at least one repo"),
      })
      .strict()
      .optional(),
    capabilities: z.array(z.enum(DEPLOY_CAPABILITIES)).min(1),
  }),
);
export type DeployHost = z.output<typeof deployHostsSchema>[number];

export function parseDeployHosts(raw: string | undefined): DeployHost[] {
  if (!raw?.trim()) return [];
  const hosts = deployHostsSchema.parse(JSON.parse(raw));
  for (const h of hosts)
    if (h.transport === "ssh" && !h.ssh)
      throw new Error(`MATRIX_DEPLOY_HOSTS ${h.name}: ssh needs user@host`);
    else if (h.transport === "orca" && !h.orca)
      throw new Error(`MATRIX_DEPLOY_HOSTS ${h.name}: orca needs { environment, repos }`);
  return hosts;
}

/** An Orca host only serves the repos it has a checkout of; local/ssh hosts clone any repo. */
export function reaches(host: DeployHost, repo: string): boolean {
  return host.transport !== "orca" || Boolean(host.orca?.repos[repo]);
}

export type StepAction = "provider" | "run" | "dry-run" | "hold" | "block" | "skip";

export interface DeployStep {
  target: string;
  kind: DeployTarget["kind"];
  action: StepAction;
  reason: string;
  host?: string;
  argv?: string[];
  capability?: DeployCapability;
}

export interface DeployPlan {
  repo: string;
  mergeCommit: string;
  dryRun: boolean;
  files: string[];
  steps: DeployStep[];
}

/** Matrix's own fixed flag: the Fly image label names the merged commit (release proof). */
export function deployArgv(target: DeployTarget, mergeCommit: string): string[] {
  const argv = [...(target.run ?? [])];
  if (target.capability === "fly") argv.push("--image-label", `matrix-${mergeCommit.slice(0, 12)}`);
  return argv;
}

/** Pure: what a merged diff deploys, where, and what holds. Nothing runs here. */
export function planDeploy(input: {
  profile: DeployProfile;
  files: string[] | undefined;
  hosts: DeployHost[];
  repo: string;
  mergeCommit: string;
  dryRun?: boolean;
}): DeployPlan {
  const selected = new Map(
    selectTargets(input.profile, input.files).map((s) => [s.target.name, s] as const),
  );
  const steps: DeployStep[] = [];
  for (const target of input.profile.targets) {
    const base = { target: target.name, kind: target.kind };
    const sel = selected.get(target.name);
    if (!sel) {
      steps.push({
        ...base,
        action: "skip",
        reason: "no-op: the merged diff touches none of its paths",
      });
      continue;
    }
    if (sel.held.length) {
      steps.push({
        ...base,
        action: "hold",
        reason: `held for a human (merged, not deployed): ${sel.held.slice(0, 5).join(", ")} match holdOn (migrations / release config on shared infra)`,
      });
      continue;
    }
    if (target.kind === "git-integration") {
      steps.push({
        ...base,
        action: "provider",
        reason: `the provider deploys ${input.mergeCommit.slice(0, 12)} on merge; Matrix proves it via ${target.version?.url}`,
      });
      continue;
    }
    const cap = target.capability as DeployCapability;
    if (target.dryRun || input.dryRun) {
      const dry = input.hosts.find((h) => h.capabilities.includes(cap) && reaches(h, input.repo));
      steps.push({
        ...base,
        action: "dry-run",
        capability: cap,
        ...(dry ? { host: dry.name } : {}),
        argv: deployArgv(target, input.mergeCommit),
        reason: `dry run, nothing runs (would run on ${dry?.name ?? `no host: no host has ${cap}`})`,
      });
      continue;
    }
    const host = input.hosts.find((h) => h.capabilities.includes(cap) && reaches(h, input.repo));
    if (!host) {
      steps.push({ ...base, action: "block", capability: cap, reason: `no host has ${cap}` });
      continue;
    }
    steps.push({
      ...base,
      action: "run",
      capability: cap,
      host: host.name,
      argv: deployArgv(target, input.mergeCommit),
      reason: `${sel.matched.slice(0, 5).join(", ")} changed`,
    });
  }
  return {
    repo: input.repo,
    mergeCommit: input.mergeCommit,
    dryRun: input.dryRun === true,
    files: input.files ?? [],
    steps,
  };
}

export function renderPlan(plan: DeployPlan, profile: DeployProfile): string {
  const lines = [
    `Deploy plan for ${plan.repo}@${plan.mergeCommit.slice(0, 12)}${plan.dryRun ? " (DRY RUN: nothing runs)" : ""}`,
    `Changed: ${plan.files.slice(0, 10).join(", ") || "(none)"}`,
  ];
  for (const s of plan.steps) {
    const t = profile.targets.find((x) => x.name === s.target);
    lines.push(`- ${s.target} [${s.kind}] ${s.action.toUpperCase()}: ${s.reason}`);
    const acts = s.action === "run" || s.action === "dry-run";
    if (acts) {
      if (t?.coordinate?.deck)
        lines.push(
          `  1. deck note, then hold if another actor released in the last ${t.coordinate.recentForeignDeployMinutes} min`,
        );
      lines.push(
        `  2. on ${s.host}: clean checkout of ${plan.mergeCommit.slice(0, 12)}, run: ${s.argv?.join(" ")}`,
      );
      lines.push(
        `  3. prove: newest release is ours with image label matrix-${plan.mergeCommit.slice(0, 12)}`,
      );
    }
    if (t?.health && (acts || s.action === "provider"))
      lines.push(`  health: GET ${t.health.url} expect ${t.health.expect}`);
    if (acts && t?.rollback)
      lines.push(
        t.coordinate
          ? `  on failure: hold and post the failing receipt; a human rolls ${t.rollback.app} back (shared app)`
          : `  rollback on failure: redeploy the previous ${t.rollback.app} image (if the current release is still ours)`,
      );
  }
  return lines.join("\n");
}
