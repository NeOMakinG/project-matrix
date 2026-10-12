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
