# 7. Deploy stage, health check and rollback per project (spike)

- Status: proposed (spike, 2026-10-27)
- Date: 2026-10-27

## Context

The core state machine already has `merge → deploy → verify` phases with `DeployPort` and
`VerifyPort` (`packages/core/src/ports-internal.ts`), autonomy gating (`requiresApproval`) and a
`verify` loop-back. The real runtimes (`native-runtime.ts`, `orca-runtime.ts`) only wire a merge
port; there is no deploy or verify port, so external-repo tickets stop after a human merge.

The owner now allows autonomous merge **and** deploy for some projects (project-matrix, EagleRay)
behind a strict gate, while others stay human (Travel Journal / wayline merges). Deploys need
credentials that only some machines hold, so a deploy job cannot simply run on bosgame.

Capability map, probed 2026-10-27 (identity only, no tokens read):

| Host | gh | fly | eas | railway | netlify / vercel / wrangler |
| --- | --- | --- | --- | --- | --- |
| Mac (MacBook-Pro-2) | NeOMakinG | yes | yes (0xm4king, vultisig, aicombinator) | yes | not installed |
| bosgame (Matrix server) | NeOMakinG | not installed | not installed | not installed | not installed |
| miniforum | NeOMakinG | not installed | not installed | not installed | not installed |

Netlify sites (EagleRay dashboard) deploy through Netlify's git integration on merge to `main`
and publish deploy previews (`deploy-preview-{pr}--<site>.netlify.app`, commit status
`deploy/netlify`), so they need no CLI credential.

## Decision

1. **Per-project deploy profile** in the stored project (`PATCH /v1/projects/{id}` `deploy`),
   trusted operator config, never ticket text:

   ```json
   "deploy": {
     "merge": "auto",                       // auto | human (default human)
     "targets": [
       { "name": "dashboard", "kind": "git-integration", "paths": ["apps/dashboard", "apps/docs"],
         "health": { "url": "https://dashboard.deltahealth.fit/", "expect": 200 },
         "waitStatus": "deploy/netlify" },
       { "name": "api", "kind": "command", "paths": ["apps/api"],
         "capability": "fly", "run": ["fly", "deploy", "-a", "eagleray-api", "--remote-only"],
         "health": { "url": "https://eagleray-api.fly.dev/health", "expect": 200 },
         "rollback": { "kind": "fly-releases", "app": "eagleray-api" },
         "holdOn": ["apps/api/prisma/**", "apps/api/scripts/migrate.mjs", "apps/api/scripts/seed.mjs",
                   "fly.toml", "Dockerfile", "apps/api/Dockerfile"],
         "coordinate": { "deck": true, "recentForeignDeployMinutes": 30 } }
     ]
   }
   ```

   A target runs only when the merged diff touches its `paths`. `holdOn` globs merge but hold
   that target and block the ticket for a human with the reason. They must cover everything that
   changes what a release does to shared state, not just new migration files: the schema, the
   migrate/seed scripts the Fly `release_command` runs, `fly.toml` itself (a changed
   `release_command` is always human) and the image build files. `run` is not free-form: the
   config write rejects any `run[0]` outside a host-side allowlist of deploy CLIs (`fly`, `eas`,
   `railway`, `gh`) with fixed subcommands, and the argv is never taken from the repo or ticket.
   `health.url` must be an `https://` public origin; the poller refuses private, link-local and
   tailnet addresses.

2. **Merge gate for `merge: "auto"`**: 0 open P1 review findings, every required GitHub check
   green on the validated head, and an agent QA PASS (for web: on the PR's deploy preview). The
   merge port then calls `gh pr merge --squash --match-head-commit <sha>` host-side; anything else
   stays the current "human merges, Matrix observes" flow. Matrix never pushes the base branch.

3. **Capability-routed deploy port**: host config (`MATRIX_DEPLOY_HOSTS`, not project config)
   maps capability names (`fly`, `eas`, `railway`, `gh`) to a host and a transport: `local`,
   `ssh <alias>` or `orca --environment <name>`. The deploy port picks the first host holding the
   target's capability, runs the argv in a clean checkout of the merged SHA on that host, with a
   per-target lock, and records the release id plus a redacted stdout tail (secret gate and
   key-pattern redaction before anything reaches a receipt or Linear) as a receipt. No credential is
   copied between hosts; a missing capability blocks the target with `no host has <cap>` and the
   ticket for a human, other targets continue.

4. **Verify + rollback**: verify first proves the merged SHA reached production (a production
   deploy receipt naming that SHA: the provider's release for `command` targets, the site's
   production deploy for `git-integration`, never a preview status), then polls the health URL
   (bounded retries). Deploy, verify and rollback share one per-target lock. Immediately before
   issuing the rollback it re-reads the provider's current release and aborts unless it is still
   this attempt's (the remaining check-then-act window is seconds; the coordination note in 5
   narrows it further); a newer release (human or
   another fleet) holds for a human instead. On failure it rolls back (`fly releases rollback <previous>` via the same host;
   git-integration targets: redeploy the previous production deploy or revert-PR, human) and
   fails the phase. Every outcome posts one Linear comment with the deploy receipt (target,
   release id, health result, rollback if any).

5. **Coordination** (shared infra): before a `coordinate` target deploys, Matrix logs a deck note
   and checks the provider's recent releases; a release by another actor in the last N minutes
   holds the deploy and retries later.

## Rollout

- Slice 1: deploy profile schema + `git-integration` target (production deploy of the merged SHA,
  health check)
  + auto-merge gate. Proves EagleRay dashboard end to end.
- Slice 2: `command` targets over `ssh`/`orca --environment` with Fly rollback and migration
  hold; EagleRay API.
- Slice 3: project-matrix self-deploy (backup DB, restart `matrix-server`, `/healthz`, roll back
  to the previous checkout) and EAS profiles for mobile (wayline builds stay human-merged).

## Consequences

- Deploy credentials stay on the hosts that already hold them; moving them into Infisical is a
  separate operator task.
- Autonomy for merge/deploy becomes per project and explicit; the default stays human.
- Until slice 1 lands, autonomous merges and deploys are done by an operator agent following the
  same gate by hand.
