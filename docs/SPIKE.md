# Project Matrix: spike

A self-hostable software factory. It takes a project from business discovery to production and keeps it healthy: init interview, ADRs, tickets, implementation, review, QA, deploy, prod monitoring, bug fixing and measured self-improvement. One big machine hosts it. Any agent on any machine drives it through MCP or REST with a scoped API key.

## Decisions so far (2026-10-12)

| Topic | Decision |
|---|---|
| First milestone | Init interview + the full loop running on one project |
| Core stack | TypeScript on Bun/Node, Zod everywhere |
| Host | bosgame (32 cores, 122 GB RAM). miniforum stays the model gateway and device-QA host |
| Sandbox | Rootless Podman, one container per agent run. bwrap fallback where Podman is unavailable |
| Tickets | Adapter layer. beads by default, GitHub Issues, Linear and a markdown folder as adapters |
| Agent runners | Adapters over CLIs (Claude Code headless, Codex CLI, OpenCode), all routed through CLIProxyAPI |
| Autonomy | Asked during init (human merge, gated auto-merge, or fully autonomous) and changeable at any time |
| Pilot | A greenfield app whose idea comes out of the init interview itself |
| Dashboard look | Dark ops console with subtle Matrix nods |
| License | Apache-2.0, public repo `project-matrix` |

## Principles

1. **The orchestrator is deterministic code.** LLMs only run inside steps. Every step records its inputs, outputs, model and cost, so any run can be replayed.
2. **Business first.** The factory knows the product's users, value, pricing, distribution and GTM before it writes code. Every ticket traces back to a product goal.
3. **Evidence gates everything.** No phase completes without receipts: tests, review verdicts, screenshots, videos, curl logs, emulator traces.
4. **Verification beats more agents.** Types, lint, ADR rules, tests, multi-model review and holdout scenarios carry the weight.
5. **Everything lives in the repo.** Config, ADRs, product graph and rules are versioned files. The database is an index and a run log, never the only copy.
6. **Agents never see raw secrets.** Credentials are injected outside the sandbox and scoped per run.
7. **Self-improvement is measured.** A lesson becomes a rule only after it wins against replayed tickets.

## Prior art and what we borrow

| Source | Borrowed idea |
|---|---|
| OpenAI Symphony | Tracker as control plane, reconcile before dispatch, back-off, stall detection, proof of work |
| Gas Town + beads | Merge queue (agents never push to main), git-native issue graph as memory, supervisor roles |
| StrongDM Software Factory | Holdout scenarios hidden from the implementer, LLM-judged satisfaction, digital twins of third-party APIs |
| Every's Compound Engineering | Parallel specialist review lanes ranked P1 to P3, lessons written back into rules |
| Ralph loop | Small tasks per iteration, backpressure from types and tests |
| Matt Pocock skills | Grilling-style interview (design tree, recommended answers), `CONTEXT.md` + `docs/adr/` conventions |
| Sentry Seer | Root-cause analysis with a fixability score before attempting a fix |

Gaps nobody fills, which is where Matrix differs: the init interview producing enforced ADRs, QA receipts as merge gates, an open prod-to-fix-to-verify loop, a multi-tenant MCP control plane with scoped credentials, and measured self-improvement.

## Architecture

```
            agents anywhere ── MCP / REST (scoped API keys) ──┐
                                                               ▼
 dashboard (web) ── SSE ──►  matrix-server  ◄── webhooks (Sentry / PostHog / OTel / GitHub)
                              │
                              ├─ orchestrator: typed state machines + reconcile loop (Postgres)
                              ├─ tickets: adapter layer (beads, GitHub, Linear, markdown)
                              ├─ runners: Claude Code / Codex / OpenCode via CLIProxyAPI
                              ├─ sandbox: rootless Podman per run, worktree per ticket,
                              │           egress proxy injecting credentials
                              ├─ graphs: code graph, product graph, ADR index
                              ├─ rules: lint presets + ADR-tagged architecture checks
                              ├─ qa: Playwright / agent-browser, Maestro / agent-device (miniforum)
                              ├─ monitor: prod signals → triage → fix tickets → verify
                              ├─ compound: lessons → candidate rules → replay eval → promote
                              └─ watch: tech watch digests → proposal tickets
```

### Orchestrator

- Each project runs workflows defined as typed state machines (TypeScript + Zod), not as prompts.
- A reconcile loop ticks every few seconds: it reads ticket state, decides what is dispatchable, and starts runs. Same loop restarts stalled runs with back-off.
- State lives in Postgres (Drizzle). Every step is idempotent and records inputs, outputs, model, tokens, cost and receipts.
- Concurrency limits per project, per model and per host, so rate limits and RAM are respected.

### The loop

```
ticket ready
  → spike        (plan + affected ADRs + test plan, written to the ticket)
  → implement    (runner in a container, worktree branch)
  → checks       (types, lint, ADR rules, unit tests: must pass to continue)
  → review       (specialist lanes on a different model than the implementer, P1–P3; any P1 loops back)
  → qa           (browser / emulator / API receipts + holdout scenarios judged outside the repo)
  → merge        (human, gated queue or autonomous, per the project's autonomy setting)
  → deploy       (per the hosting answers from init)
  → verify       (smoke checks + error rates after deploy)
  → compound     (lessons recorded as candidate rules)
```

### Tickets

- One `TicketStore` interface: create, update, link, comment, query by state, dependencies.
- Adapters: beads (default, git-native, works offline), GitHub Issues, Linear, markdown folder.
- Chosen during init, switchable later through a migration command.

### Runners and sandbox

- A runner adapter wraps one coding CLI in headless mode. Each phase picks its runner and model (for example, Fable implements, GPT reviews).
- All model traffic goes through CLIProxyAPI. Runners only see a dummy key; a proxy outside the container adds the real one.
- One rootless Podman container per run, with a git worktree for the ticket. Network allowed only to the gateway, the package registry and hosts listed in the project config.
- A credential broker mints short-lived, scoped tokens per run (GitHub token limited to the project repo and branch, never main).

### Knowledge graphs

- **Code graph:** symbols, imports, modules, owners. Regenerated in CI and after each merge. Exposed to agents through MCP (tokensave-style queries).
- **Product graph:** goals, personas, features, UX decisions, ADRs, tickets and code modules, linked. Stored as files under `.matrix/graph/`, indexed in Postgres, shown in the dashboard.
- **ADRs:** MADR files in `docs/adr/`, plus `CONTEXT.md` for the domain glossary.

### Rules

- Lint and format presets per stack, chosen during init.
- An ADR can declare machine-checkable rules (dependency-cruiser, eslint-plugin-boundaries, ast-grep, Semgrep). Every violation names the ADR it breaks.
- `matrix check` runs locally, in the loop's checks phase and in CI.

## Init interview

A grilling-style interview (design tree, rounds, a recommended answer for each question, facts looked up rather than asked). The question bank is data, organised in **packs** so new stacks plug in without touching the engine.

| Pack | Covers |
|---|---|
| Business | Problem, target customer, value, pricing, competitors, distribution and GTM, success metrics |
| Product | Personas, core features, MVP scope, product graph seed |
| Platforms | Web, iOS/Android, desktop (Tauri / Electron), CLI, API-only; any combination |
| Stack per platform | Framework, then deep library questions. Example for React: TanStack Router/Query/Table/Form, Zod, tRPC, Effect, gdp-ts, shadcn/ui, Tailwind, Motion, Vitest, Playwright |
| Backend | Runtime, framework, database, ORM, auth, payments, jobs, storage, email |
| Hosting | Vercel, Cloudflare, Fly, Railway, AWS, self-hosted; environments and domains |
| Observability | Analytics (PostHog), errors (Sentry / GlitchTip), OpenTelemetry, logs |
| Quality | Lint and format, test strategy, coverage, CI provider |
| Process | Ticket system, ADR location, branching, autonomy level, review lanes, budgets |
| Agent capabilities | Browser control, emulators, Figma MCP for design-first, extra CLIs (higgsfield, appllama, …) |
| Design | Art direction, brand, UI library, design references |

Outputs, all committed to the new project's repo:

- `matrix.config.ts`: the typed, Zod-validated answers.
- `docs/adr/`: one ADR per significant choice, with machine-checkable rules where possible.
- `CONTEXT.md` and `.matrix/graph/`: the domain glossary and the product graph seed.
- The initial backlog in the chosen ticket system.
- The scaffold, generated from stack templates or official generators (create-t3-app, better-t-stack, create-expo-app, create-tauri-app, …).

A contradiction check runs before tickets are created (for example, "offline-first" with a server-only data layer).

The same interview, minus scaffolding, onboards an **existing** codebase: it reads the repo, proposes answers and asks only what it can't infer.

## Prod loop

1. Signals arrive by webhook or polling: Sentry / GlitchTip, PostHog error tracking, OpenTelemetry alerts, uptime checks.
2. Triage dedupes, groups by root cause, scores fixability and severity, and links the code graph.
3. Fixable issues become tickets and enter the normal loop. Others are filed for humans.
4. After deploy, the verify phase checks that the error rate actually dropped before closing the ticket.

## Self-improvement and tech watch

- **Compound:** after each ticket, the agent proposes lessons (a new rule, a skill tweak, a prompt change). Each candidate is replayed against past tickets and promoted only if it improves results.
- **Tech watch:** collectors for HN, GitHub trending, RSS, arXiv and the changelogs of each project's dependencies. A weekly digest, plus proposal tickets for upgrades and ideas.

## Control plane

- **matrix-server:** REST API and MCP server (MCP TypeScript SDK) on the same core.
- **API keys:** scoped per project and per action (read, create tickets, start runs, merge, deploy), with budgets and an audit log.
- **Dashboard:** web app (Vite, React, TanStack Router/Query/Table, shadcn/ui, SSE for live runs). Desktop shell (Tauri) later.
- **Notifications:** Telegram (existing Hermes gateway) and email.

## Repository layout

```
project-matrix/
  apps/
    server/        orchestrator daemon, REST API, MCP server, webhooks
    dashboard/     web control panel
  packages/
    core/          workflow state machines, reconcile loop, run log
    config/        matrix.config schema (Zod) and loaders
    tickets/       TicketStore + adapters (beads, github, linear, markdown)
    runners/       CLI runner adapters (claude-code, codex, opencode)
    sandbox/       Podman / bwrap sandboxes, credential broker, egress proxy
    graph/         code graph and product graph
    rules/         lint presets, ADR rule engine, `matrix check`
    qa/            browser, emulator and API QA drivers, receipts
    monitor/       prod signal ingestion, triage, verify
    compound/      lessons, replay evaluation, promotion
    watch/         tech watch collectors and digests
    cli/           `matrix` command line
  packs/           init interview packs (business, product, stacks, hosting, …)
  skills/          agent skills shipped as a Claude Code plugin
  templates/       stack templates used by the scaffold step
  docs/
    adr/
    SPIKE.md
```

## Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | Foundations | Repo, ADRs for the decisions above, dashboard designed in Figma, Podman ready on bosgame |
| M1 | Init interview | `matrix init` runs the interview, writes config + ADRs + backlog and scaffolds a React web + Node API project |
| M2 | Core loop | spike → implement → checks → review → QA → draft PR runs on one ticket, with receipts, in a container |
| M3 | Control plane | Dashboard v1 (projects, board, live runs, receipts, ADRs, approvals) plus REST and MCP with scoped keys |
| M4 | Pilot | A greenfield app goes from interview to a deployed MVP through the factory |
| M5 | Prod loop | A real prod error becomes a ticket, gets fixed, deployed and verified automatically |
| M6 | Compound + watch | First promoted rule backed by replay results; weekly tech-watch digest |
| M7 | More stacks + Wayline | Expo and Tauri packs; Wayline onboarded through the existing-codebase interview |

## Risks

- **Rate limits** on subscription models stall runs. Mitigation: per-model concurrency limits, fallbacks across runners, queue with back-off.
- **Agents gaming tests.** Mitigation: holdout scenarios outside the repo, review on a different model, checks the agent can't edit.
- **Scope.** This is huge. Each milestone has to run end to end before the next starts.
- **Secrets.** Mitigation: credentials injected outside containers, secret scanning before every push (reuse the missions gates).
- **bosgame load** (ComfyUI, Hermes, browsers). Mitigation: per-host concurrency limits and a resource check before heavy runs.

## Resolved in round 2 (2026-10-12)

- **Database:** Postgres in a rootless Podman container on bosgame, Drizzle migrations.
- **Default review lanes:** correctness + security, architecture/ADR, UX/product, performance. Lanes stay configurable per project.
- **Stack packs after React web + Node API:** Expo, Next.js / TanStack Start, Tauri, Go backend.
- **Publishing:** the public repo goes up once the Figma design lands.

## Still open

- Where web QA runs: bosgame browsers or miniforum.
