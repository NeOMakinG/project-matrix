# Project Matrix

A self-hostable, evidence-gated software factory under active development. The goal is to turn product intent into reviewed software, with receipts and human-controlled authority.

Status (October 12, 2026): implemented packages and a development control plane, **not a production-ready end-to-end factory**. Integration PR #27, dashboard-init PR #26 and stack-packs PR #24 remain open and await actual QA. [SPIKE](docs/SPIKE.md) describes the intended design, not a completion checklist.

## Available In This Checkout

- CLI interview/config/ADR/backlog generation, existing-repo onboarding, `check`, `graph`, and read-only `doctor` diagnostics.
- Workflow, runner, sandbox/broker and QA receipt modules with unit fixtures; not proof of a deployed loop.
- REST/MCP scoped keys, browser sessions, SSE and webhook handlers; the server entrypoint currently uses **MemoryCore and in-memory keys**.
- Dashboard screens and Orca hook/MCP configuration helpers (dry-run by default).

Gaps: durable control-plane wiring, integrated host/container/gateway QA, broader stack validation, and verified deployment/production auto-fix. No default paid API fallback; configure an operator-owned local gateway.

## Quickstart

On your **local development machine**, from the checkout root, after reviewing dependency scripts:

```sh
bun install --frozen-lockfile --ignore-scripts
bun packages/cli/src/bin.ts --help
bun packages/cli/src/bin.ts doctor --json
bun packages/cli/src/bin.ts init ./example-project --no-scaffold
```

Doctor can return exit 2 when prerequisites/configuration are missing; it never installs tools or proves runtime readiness. Init interviews you in an interactive terminal; noninteractive use requires an answers file (`--answers`). `--no-scaffold` generates files without running a project generator. Do not run generators/hooks from an untrusted checkout. See [self-hosting](docs/self-hosting.md) for protected environment configuration and development-server startup.

## Screens And Guides

Implemented dashboard captures (not live QA receipts): [overview](docs/design/implemented/01-overview.png), [board](docs/design/implemented/02-board.png), [run detail](docs/design/implemented/03-run-detail.png), [init](docs/design/implemented/04-init-interview.png), [knowledge](docs/design/implemented/05-knowledge.png), [monitor](docs/design/implemented/06-prod-monitor.png), [settings](docs/design/implemented/07-settings.png).

[Self-hosting](docs/self-hosting.md) · [MCP](docs/mcp.md) · [Orca](docs/orca.md) · [Architecture](docs/architecture.md) · [Security](docs/security.md) · [ADRs](docs/adr/)

## License

Apache-2.0
