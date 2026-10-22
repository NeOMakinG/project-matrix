# 6. Orca as the preferred workspace layer

- Status: accepted
- Date: 2026-10-12

## Context
The maintainer runs agents through Orca (stablyai/orca, MIT), a desktop agentic development environment. Orca already manages worktrees, terminals, coding agents (Claude Code, Codex, OpenCode, Cursor, Amp, Droid, Grok), orchestration tasks with decision gates, a built-in browser, iOS simulator and Android emulators, artifacts, and a headless remote runtime (`orca serve`). Matrix must stay usable without Orca because it is a public project.

## Decision
Matrix has a **workspace adapter** layer next to the ticket and runner adapters:

- **orca adapter (preferred when Orca is available):** each ticket run becomes an Orca worktree (`orca worktree create --agent … --prompt … --issue …`) on an `orca serve` runtime hosted on bosgame. Loop phases map to Orca orchestration tasks, and human approvals map to Orca decision gates. QA uses Orca's browser and emulator commands; receipts are attached to the ticket and can be shared as Orca artifacts.
- **native adapter:** Matrix creates worktrees and rootless Podman containers itself (ADR 0002).

In both modes Matrix stays the source of truth for workflow state, receipts, graphs and policy. Orca is the place a human watches or takes over a run.

Every agent session launched by Orca gets the Matrix MCP server and a `matrix` skill, so any agent can read tickets, ADRs and graph context and report status back.

## Consequences
- Matrix depends on Orca's CLI contract (`orca agent-context --json`); the adapter pins and checks the Orca version.
- Container isolation still applies in Orca mode: the Orca runtime on bosgame launches agents inside the Matrix sandbox.
- The dashboard links every run to its Orca worktree.

## Addendum (2026-10-22): Orca runtime for every agent session

Spike: `docs/spikes/orca-runtime.md` (PR #40). Decision: with `MATRIX_RUNTIME=orca` all agent
work runs through Orca so a human sees every session in Orca desktop/mobile. Linear stays the
store for tasks, context and outputs; Matrix keeps gates and evidence.

- Matrix drives the **local** Orca runtime through an absolute CLI path
  (`/opt/Orca/resources/bin/orca-ide` by default), never `orca` from `PATH`.
- Ticket → Orca worktree (`--linear-issue`, `--no-parent`, `--setup skip`) + one coordinator
  terminal bound to one orchestration Run (`NEO-n · <project>`). Messaging stays Run-scoped.
- Phase → orchestration task + bash terminal + dispatch running a 0600 script. The script runs
  the unchanged Podman sandbox command, so isolation, read-only review/QA mounts and the
  credential broker are the same as `native`; this supersedes the original idea of letting Orca
  launch agents itself (`worktree create --agent/--prompt`, `worker-start --agent`), which would
  bypass the sandbox and gateway routing. No secret ever enters Orca messages, titles, argv or
  terminal history.
- Matrix waits for `worker_done` (exit-file fallback, timeout + interrupt), acks every Delivery,
  answers questions with a fixed unattended reply and stores `worker-read` output as evidence.
  Phase results map to the existing `RunResult`/receipt types, so gates are unchanged.
- Before `worktree rm --force` (which deletes the branch) the head is pinned under
  `refs/matrix/archive/`.
- Orca decision gates are not used: human approvals stay Matrix approvals.

Consequences: Matrix must run as the Orca runtime's user; the runtime's websocket must be
firewalled to the tailnet; Run records accumulate (Orca has no Run delete) and are never reset
by Matrix.
