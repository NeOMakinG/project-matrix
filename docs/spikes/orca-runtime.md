# Spike: driving the Bosgame Orca runtime from Matrix (PR6 input)

- Date: 2026-10-22
- Orca: 1.4.220 on bosgame (`/opt/Orca`), CLI `orca` on the Mac (same build line)
- Scope: research only, no product code changed. One throwaway live test was run
  on a scratch repo (`~/Projects/orca-spike`) and cleaned up afterwards.
- Decision under study: every agent session runs through Orca (visible in Orca
  desktop/mobile); Linear (team NEO) stays the task/stage/context store; Matrix
  keeps gates and evidence (review independence, holdout QA, human merge).

## What is actually running on bosgame

| Fact | Evidence |
| --- | --- |
| Runtime is the full Electron app in serve mode, not `ops/bosgame/orca-serve.service` | `orca-ide --serve --serve-port 6768 --serve-pairing-address 100.69.91.71 --serve-mobile-pairing`, parent `orca-ide .../out/cli/index.js serve ...`, `DISPLAY=:100` (Xvfb), up 16 days |
| Port is 6768 on `0.0.0.0`, not 7420 | `ss -ltnp`: `0.0.0.0:6768 orca-ide` |
| Local transports | `~/.config/orca/orca-runtime.json` (0600, owner `neo`): `unix` `~/.config/orca/o-<pid>-<id>.sock` and `websocket ws://0.0.0.0:6768`, plus an `authToken` |
| PTY daemon | `~/.config/orca/daemon/daemon-v39.sock` + `.token` (0600) |
| Orchestration state | `~/.config/orca/orchestration.db` (SQLite, WAL) |
| No managed accounts | `orca account list`: claude and codex `accounts: []`, codex `authKind: none` |
| Mac pairing | `orca environment list` -> `Bosgame ws://100.69.91.71:6768` |

**Name collision (blocker for a naive adapter):** `/usr/bin/orca` on bosgame is
the GNOME Orca screen reader (Python). The Orca IDE CLI is
`~/.local/bin/orca` (wrapper to `/opt/Orca/resources/bin/orca-ide`).
`matrix-server`'s `PATH` (`~/.matrix-tools/bin:~/.bun/bin:/usr/bin:/bin`)
resolves `orca` to the screen reader. The adapter must take an absolute
`orcaBinary` (`/opt/Orca/resources/bin/orca-ide`).

## Q1. Can a process on bosgame drive the Bosgame runtime? Do results show on the Mac?

**Yes, verified.**

- `~/.local/bin/orca status --json` over plain SSH (no Orca terminal) returns
  `target.kind: local`, `runtime.state: ready`, runtimeId
  `d69bd85e-e42c-46ec-b614-59d09d6849b3`.
- `orca status --environment Bosgame --json` from the Mac returns the **same
  runtimeId**. One runtime, two clients.
- Everything created from bosgame (repo, Run, tasks, worktrees, terminals,
  dispatches) was visible from the Mac with `--environment Bosgame`:
  `worktree ps` listed `orca-spike refs/heads/spike-wt live:2` with the
  terminal preview; `orchestration run-list` listed `run_722d8ad8730e`;
  `orchestration worker-read --dispatch ctx_...` returned the transcript.
- Desktop/mobile UI: not screenshotted. They render the same runtime state the
  CLI reads, and mobile pairing is on (`--serve-mobile-pairing`), so this is
  expected but a human should eyeball it once. One caveat: `terminal create`
  returned `surface: background` with "Orca could not make it discoverable"
  (headless app has no window); `terminal focus` reveals it in a client.

The Mac is therefore not a dependency: Matrix on bosgame calls the local CLI,
which uses the local unix socket + token.

## Q2. Worker command and env control

**`worker-start` cannot run our own command. A bare-shell dispatch can, and
completion tracking still works. Verified.**

- `worker-start` needs `--agent <id>` (Orca launches the agent CLI with its own
  launch path; flags `--model`, `--effort`) or `--terminal <handle>` of a
  terminal already running a *recognized agent TUI*. A bash terminal is
  rejected: `agent_unconfigured: Terminal ... is not running a recognized agent`.
  There is no `--env` or `--command` on `worker-start`.
- `--agent claude` would start claude with whatever auth the host has (no
  managed accounts, no gateway env in the runtime's environ). Not used for
  inference here, so gateway routing via `--agent` is **unproven**; it would
  rely on ambient `~/.claude/settings.json` / `~/.codex/config.toml` (today
  codex there points to `127.0.0.1:8318`, not the 8317 gateway).
- Working path (what the live test did):
  1. `terminal create --worktree path:<wt> --title <phase> --command bash`
  2. `orchestration dispatch --task <t> --to <handle> --from <coordinator>`
     (no `--inject`; the skill documents this for bare shells)
  3. `terminal send --text "<runner script> <task> <dispatch>; exit" --enter`
  4. The script runs `ANTHROPIC_BASE_URL=http://100.90.255.43:8317
     ANTHROPIC_API_KEY=<from protected file> claude -p ... --model
     claude-haiku-4-5-20251001 --output-format json`, then
     `orca orchestration send --type worker_done --task-id ... --dispatch-id ...
     --outcome succeeded|failed --body ...` from inside the worker terminal.
  - Result: `check --wait` on the coordinator returned the `worker_done`
    (`rc=0 result=OK`, cost about $0.035); `dispatch-show` -> `status:
    completed`, capability revoked.
- Output capture options, all observed:
  - `orchestration worker-read --dispatch <id>` returned `source: transcript,
    provider: claude` with the exact user/assistant messages, even for
    `claude -p` launched by our script (Orca's shell wrapper/hooks pick up the
    session). Cursor-paginated.
  - `terminal read --terminal <h> --json` gives the raw tail.
  - `terminal wait --for exit` exists for process exit.
  - The `worker_done` body is free text; structured results belong in a file
    Matrix reads (or `--report-path`), not in the message.
- Secrets: put only `$(cat <file>)`-style expansion, never the key, in the
  `terminal send` text, because Orca persists terminal history
  (`~/.config/orca/terminal-history`). Prefer a 0600 runner script/env file
  that Matrix writes outside the worktree.
- codex on bosgame lives at `~/.local/share/pnpm/bin/codex`, not on the Orca
  runtime's `PATH` (`~/.local/bin:/usr/local/bin:/usr/bin:/bin`); the runner
  script must use an absolute path.

## Q3. Worktrees vs Matrix's evidence model

**Compatible with two adapter changes. Verified.**

- `worktree create --repo id:<r> --name <n> [--base-branch <ref>] --no-parent
  --setup skip --linear-issue NEO-123 --comment <text> --json` returned
  `path: ~/orca/workspaces/<repo-name>/<n>`, `branch: refs/heads/<n>`,
  `head: <sha of base>`, `baseRef`, `linkedLinearIssue`. Path root is Orca's
  workspace dir, not Matrix's `MATRIX_DATA_DIR`.
- **Branch names are sanitized:** `--name matrix/neo-2-slash` produced branch
  and directory `matrix-neo-2-slash`. Matrix branch conventions with `/`
  cannot round-trip; `OrcaWorkspace.prepare` already flattens `/` to `-`, so
  PR6 must record the Orca-returned branch as the run's branch, not the
  requested one.
- Orca writes git config `branch.<n>.base refs/heads/main` in the shared repo
  config. The worktree itself stayed clean: `git status --porcelain --ignored`
  empty, only the `.git` file. No stray artifacts in the tree.
- `--setup skip` matters: repo hook settings default to
  `setupRunPolicy: run-by-default`.
- Without `--no-parent`, Orca records lineage from the caller context.
- `worktree rm --worktree path:<wt> --force` removed the directory **and the
  branch** (`git branch -a` showed only `main` afterwards). Matrix must push or
  record the evidence SHA before `cleanup()`.
- Matrix `NativeWorkspace` (packages/workspace/src/native.ts) does
  `git worktree add -b <branch> <workdir> <base>`, verifies `HEAD` is on the
  branch and records `baseSha`. With Orca, the same checks still apply to the
  returned path (`rev-parse HEAD^{commit}`, `symbolic-ref`), and
  `TrustedWorktrees` can still record the gitdir from the canonical repo.
  The single-commit-SHA-per-run rule is unaffected: Orca does not commit.
- `OrcaWorkspace` already exists (packages/workspace/src/orca.ts) but uses
  `--issue <number>` (GitHub). PR6 should switch to `--linear-issue` and add
  `--no-parent --setup skip`, and pin `ORCA_REQUIRED_COMMANDS` to the
  orchestration commands too.

## Q4. Messaging scope

**Messages are Run-scoped and enforced. Matrix can coordinate programmatically.
Verified.**

- `run-create` from a non-Orca process fails with `no_active_sender_terminal`.
  It works with `--from <handle>` of any live Orca terminal. Matrix needs a
  coordinator terminal inside Orca (a parked bash tab per Run).
- **One coordinator terminal is bound to one Run at a time.** Creating a second
  Run with the same `--from` rebinds it; `check` on the first Run then fails
  with `consumer_fenced: ... bound to run_c4f..., not run_722...`. Rebind with
  `run-use --id <run>`. PR6 needs one coordinator terminal per concurrent
  ticket Run (or serialised rebinding, which bumps `consumer_generation`).
- Cross-Run send from a worker is rejected: `send --to run:<other>` from a
  dispatched terminal -> `dispatch_run_mismatch: Dispatch ctx_... belongs to Run
  run_722..., not run_c4f...`. Workers cannot message other Runs/projects.
  Coordinator-to-coordinator messaging across Runs was not tested.
- ask/reply round trip from bosgame SSH: worker ran `orchestration ask
  --question "proceed?" --options yes,no`; coordinator `check --wait` returned
  it as `type: question, from dispatch:ctx_...`; `reply --id <msg> --body yes
  --from <coordinator> --run <run>` unblocked it (`answer: yes, timedOut:
  false`). `check --ack <delivery>` is required, otherwise the same Delivery
  (including the earlier `worker_done`) replays first, even with `--types`.
- Any process with the runtime token can pass any `--from` handle; there is no
  per-terminal authentication beyond the dispatched-pane check on
  `worker_done`. Trust boundary = the `neo` user.

## Q5. Auth, pairing, socket permissions

- Local access needs read access to `~/.config/orca/orca-runtime.json` (0600)
  and the unix socket, i.e. the same uid as the runtime (`neo`).
  `matrix-server` runs as `neo` (user unit), so it works today. A separate
  service user would need its own runtime or pairing via websocket
  (`ORCA_PAIRING_CODE`/`--environment`), which is not set up.
- Websocket listens on `0.0.0.0:6768`; restricting it to tailscale0 is still
  an operator task (see orca-serve.md, whose port/unit no longer match reality).
- No managed Claude/Codex accounts exist, so `--agent` launches would use ambient
  CLI auth. Keep inference on the gateway with explicit env.
- `orca repo` has no remove command in the CLI; Runs have no delete either
  (only `orchestration reset`, which is global and would wipe unrelated Runs
  such as `run_a1bcef209f92`). Never call `reset` from Matrix.

## Recommended PR6 architecture

1. Matrix server calls `/opt/Orca/resources/bin/orca-ide` locally on bosgame
   (no `--environment`), JSON envelope as today.
2. Per ticket: `worktree create --linear-issue NEO-n --no-parent --setup skip`;
   record returned path/branch/head; bash coordinator terminal in that worktree
   titled `matrix:<NEO-n>`; `run-create --objective "<NEO-n> <title>" --from
   <coord>`.
3. Per phase: `task-create --run --from --task-title <phase>`, a new bash
   terminal titled `<phase>:<model>`, `dispatch` (no inject), `terminal send` a
   0600 runner script that Matrix wrote outside the worktree. The script runs
   the existing `claude-code`/`codex` runner command (gateway env, `-p`/`exec
   --json`), writes the parsed result file, then sends `worker_done`.
4. Matrix waits with `check --wait --types worker_done,escalation,question`
   per coordinator, answers `question` via `reply`, acks every Delivery, uses
   `worker-read` for the transcript as evidence. Linear gets the summary.
5. Review/QA phases get their own terminals (and models) in the same worktree,
   so independence stays enforced by Matrix, not Orca.
6. Cleanup: record SHA/push, `terminal close` the phase terminals, then
   `worktree rm --force` only after the PR branch is pushed.

Optional later: replace bash+script with `worker-start --agent claude --model`
once ambient gateway config is proven, to get Orca's injected preamble and
`worker-release` archiving (bare-shell dispatches report
`retained: no_owned_resource` on release).

## Live test log (all on scratch repo, cleaned up)

- Repo `b091a582-...` = `~/Projects/orca-spike` (empty commit `d753f78`).
- Run `run_722d8ad8730e` and `run_c4f5d5016dd9`, tasks `task_15af212f0612`,
  `task_62af307bbaac`, dispatches `ctx_5d07bbad1449`, `ctx_a633f71bc221`.
- Removed: both worktrees + branches, all spike terminals, the runner script.
- Left behind (no CLI delete): the repo registration, the empty scratch repo
  folder, and the two completed Run records. Remove the repo from the Orca UI.
- Host load before test: load average 0.43, 77 GB RAM available.
