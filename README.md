# Project Matrix

A self-hostable software factory. It interviews you about the business and the stack, writes the ADRs and the backlog, then builds, reviews, tests, ships and monitors the software with AI agents, and fixes what breaks in production.

Status: design phase. See [docs/SPIKE.md](docs/SPIKE.md) and [docs/adr/](docs/adr/).

## What it does

- **Init interview:** business, product, platforms, stack and libraries, hosting, analytics, design, process and autonomy.
- **Loop:** spike, implement, checks, multi-model review, QA with receipts, merge, deploy, verify.
- **Prod loop:** errors become tickets, get fixed and are verified after deploy.
- **Knowledge:** code graph, product graph and ADRs enforced by rules.
- **Control plane:** dashboard, REST API and MCP server with scoped API keys.

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
