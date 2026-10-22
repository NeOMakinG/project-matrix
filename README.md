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

[Self-hosting](docs/self-hosting.md) · [Linear tracker](docs/linear.md) · [MCP](docs/mcp.md) · [Orca](docs/orca.md) · [Architecture](docs/architecture.md) · [Security](docs/security.md) · [ADRs](docs/adr/)

## Stack packs

`matrix init` asks deep, stack-specific questions (each with a recommended answer and why) and scaffolds what you pick:

| Platform | Pack | Scaffold |
|---|---|---|
| Web | React + Vite SPA, Next.js App Router, TanStack Start | `apps/web` |
| API | TypeScript (Bun/Node, Hono, tRPC, Drizzle), Go (chi/echo/gin, sqlc, pgx, slog), or the full-stack framework's own server | `apps/api`, `services/api` |
| Mobile | Expo (expo-router, TanStack Query, NativeWind/Tamagui, EAS, Maestro) | `apps/mobile` |
| Desktop | Tauri v2 (updater, signing, least-privilege capabilities) | `apps/desktop` |

Go rules read imports through the Go toolchain (`go list` and `go/parser`) across every module, sqlc output is verified by regenerating it, and Tauri capabilities are resolved from every JSON, JSON5 and TOML source; a missing toolchain fails the rule instead of passing it. These rules are defence in depth alongside the multi-model review lanes, not a replacement for them.

Go/sqlc verification requires an offline OS sandbox (Linux `bwrap` or macOS `sandbox-exec`); unavailable or denied sandbox creation is an unverifiable violation. sqlc regeneration uses a disposable directory and compares exact bytes, including generator version stamps, without overwriting project files. On PRs, generated CI loads ADR policy from the base branch, never from the proposed changes.

Generated Go CI probes runner-provisioned bubblewrap before verification. If installation or sandbox creation is unavailable, it fails with instructions for an administrator-approved, executable-scoped policy on a dedicated runner; it never disables AppArmor globally.

It also asks which tools agents may use: browser driver (Orca browser, agent-browser, Playwright), emulator driver (Orca, agent-device, Maestro), the Figma MCP for design-first work, and extra CLIs. Each choice becomes an ADR, and ADR rules are enforced by `matrix check`.

## Agent skills

The repo is a Claude Code plugin. Install it with:

```
/plugin marketplace add NeOMakinG/project-matrix
/plugin install project-matrix@project-matrix
```

`matrix init` also copies the skills relevant to your stack into the project's `.claude/skills/` and lists them in `matrix.config.ts` (`agents.skills`): `matrix-loop`, `matrix`, `testing`, `security`, `accessibility`, plus `react`, `nextjs`, `tanstack-start`, `node-api`, `expo-react-native`, `tauri` or `go` as chosen.

## License

Apache-2.0
