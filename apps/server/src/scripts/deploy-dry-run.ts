/**
 * Operator dry run of a deploy through the real route (no deploy runs):
 *   MATRIX_DEPLOY_HOSTS=... bun apps/server/src/scripts/deploy-dry-run.ts <profile.json> <owner/repo> <mergeSha> <file>...
 * Plans the merged files against the deploy profile, then for every command target rehearses on
 * the resolved host (Orca worktree + terminal for an Orca host): clean checkout of the merge
 * commit, `fly auth whoami`, the foreign-release check, and lists every command a real deploy runs.
 */
import { readFileSync } from "node:fs";
import type { DeployProfile } from "@matrix/core";
import { parseDeployHosts, planDeploy, renderPlan } from "../integration/deploy-plan.js";
import { rehearse } from "../integration/deploy-stage.js";

const [profileFile, repo, sha, ...files] = process.argv.slice(2);
if (!profileFile || !repo || !sha || !/^[0-9a-f]{40}$/.test(sha)) {
  console.error("usage: deploy-dry-run.ts <profile.json> <owner/repo> <mergeSha> <file>...");
  process.exit(2);
}
const raw = JSON.parse(readFileSync(profileFile, "utf8")) as { deploy?: DeployProfile };
const profile = (raw.deploy ?? raw) as DeployProfile;
const hosts = parseDeployHosts(process.env.MATRIX_DEPLOY_HOSTS);
const plan = planDeploy({ profile, files, hosts, repo, mergeCommit: sha, dryRun: false });
// Every runnable step becomes a dry-run step on its resolved host.
const steps = plan.steps.map((s) =>
  s.action === "run" ? { ...s, action: "dry-run" as const } : s,
);
console.log(renderPlan({ ...plan, steps }, profile));
const o = {
  prs: { mergedInfo: async () => undefined },
  hosts,
  ...(process.env.MATRIX_ORCA_BINARY ? { orca: { binary: process.env.MATRIX_ORCA_BINARY } } : {}),
};
let ok = true;
for (const step of steps) {
  if (step.action !== "dry-run" || !step.host) continue;
  for (const r of await rehearse(o, { ...plan, steps }, step, profile)) {
    ok &&= r.ok;
    console.log(`${r.ok ? "ok" : "FAIL"}: ${r.summary}`);
    const tail = (r.data as { tail?: string } | undefined)?.tail;
    if (tail) console.log(tail.replace(/^/gm, "    | "));
  }
}
process.exit(ok ? 0 : 1);
