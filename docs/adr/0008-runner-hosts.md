# 8. Runner hosts: implement and checks off the project host (via Orca)

Status: accepted (2026-10-27)

## Context
Every run executed on bosgame. miniforum (20 cores / 31 GB) and the MacBook (12 / 36 GB) sat idle,
and the Mac has no SSH (Remote Login off) and no container runtime.

## Decision
- `MATRIX_RUNNER_HOSTS` lists extra machines reached through their paired Orca runtime
  (`{ name, orca: { environment, repos }, cores, ramGb, phases, key, slots? }`). Light slots come
  from the same size formula as the project host (miniforum 2, Mac 3).
- The reconciler picks, per `implement` / `checks` run, the eligible host (phase allowed, repo
  checkout listed) with the most free light slots; the project host wins ties. Every other phase,
  heavy runs (QA, deploy) and the device/simulator locks never leave the project host.
- A remote run: bosgame pushes the clean worktree HEAD to a scratch branch `matrix-run/<run>`,
  the Orca route (ADR 0007) runs a fixed script in a throwaway worktree on the host: detached
  checkout verified by `rev-parse`, the project's `repo.setup`, then the runner/check argv under
  `env -i` (fresh HOME/TMPDIR, only the spec's env), stdin from a file. The gateway key never
  crosses Orca: env values equal to the run-token placeholder are filled on the host from its own
  key source (`secrets` wrapper on the Mac, `~/.config/claude-proxy/env` on miniforum), and the
  runner talks to claude-proxy (`MATRIX_GATEWAY_URL`) directly.
- Implement: the host commits and pushes `matrix-run/<run>-out`; bosgame applies
  `git diff --binary HEAD <out>` into the worktree and the unchanged host handover (approved paths,
  gitleaks, Matrix commit) decides. Checks return exit codes, output and the structured report.
  The patch and reports return inside the route payload (one framed attachment, never truncated with
  the logs), never through GitHub; only already handed-over commits are pushed as the scratch input,
  after a gitleaks pass. Scratch branches, the Orca terminal and worktree are always removed.
- Known limit: a run whose worktree has leftovers runs on the project host instead, while its slot
  was counted on the runner host (rare: checks always start clean).
- Limits: the prompt travels gzip+base64 in one exec argument (40 KB compressed cap, command checked
  under 120 KB); the attachment is capped at 4 MB raw and must fit the ~2000-line scrollback.

## Trade-off (accepted)
Runner hosts are NOT sandboxed: the agent and the checked code run as the host user with network
access (the Mac's own git credentials included). Mitigations: opt-in per host and per phase, an
isolated environment and HOME per job, nothing a remote run produces is trusted until the host-side
gates pass, and the gateway key is the only credential a job receives. Do not list a host whose
user account holds credentials you would not hand to a ticket.
