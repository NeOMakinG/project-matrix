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
