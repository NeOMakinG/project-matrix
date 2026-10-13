---
name: matrix
description: Use the Project Matrix MCP server from any agent (Claude Code, Codex, Orca sessions) to read tickets, ADRs and graphs, start runs and report status. Use when a project has matrix.config.ts or the user mentions Matrix, the factory, tickets, runs or approvals.
---

# Matrix MCP

Matrix exposes the factory over MCP (`/mcp`) and REST (`/v1`). Your API key's scopes decide what you can do; a denied call means ask a human, not retry with another key.

## Reading context

- `list_tickets`, `get_ticket`: work items and their phase.
- `adrs_for_path`, `get_adr`: decisions governing a file or folder.
- `graph_query`: who imports a module, which features a ticket touches, what a change impacts.
- `get_run`, `list_receipts`: what a run did and its evidence.

## Acting

- `create_ticket` for follow-ups you discover (scope creep goes here).
- `start_run` only with `runs:start`. The orchestrator assigns phases; you don't skip them.
- `decide_approval` is for humans. Agent keys cannot approve merges or deploys, and nobody approves their own run.

## In Orca

Each Matrix run is an Orca worktree. Report progress through the Orca hook; the Matrix server records it in the run log. A human may take over the worktree at any time; stop and summarise when they do.

## Etiquette

- Prefer narrow queries (`adrs_for_path`) over dumping the whole graph.
- Quote ticket ids (`MX-142`) in commits and PR titles.
- Budget errors mean stop and report, not split work to dodge the limit.
