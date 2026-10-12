# 4. Agent runners are adapters over coding CLIs

- Status: accepted
- Date: 2026-10-12

## Context
Subscriptions are available through CLIProxyAPI for Claude, GPT and GLM models. Different models are better at different phases.

## Decision
Runners wrap headless coding CLIs (Claude Code, Codex CLI, OpenCode). Each workflow phase chooses a runner and model. All traffic goes through CLIProxyAPI; containers only hold a dummy key and a proxy outside injects the real credential.

## Consequences
New CLIs plug in as adapters. Run output is normalised into a common event and receipt format.
