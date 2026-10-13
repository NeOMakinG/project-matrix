# Architecture and implementation boundaries

Matrix is a TypeScript/Bun monorepo licensed Apache-2.0 (root `LICENSE`). The
[SPIKE](SPIKE.md) and [ADRs](adr/) describe the target system. They are not evidence
that each phase is wired into the executable server. Integration PR #27,
dashboard-init PR #26 and stack-packs PR #24 remain open pending actual QA.

## Packages

| Area | Committed responsibility |
| --- | --- |
| `packages/cli`, `packs` | Interview, project artifacts/scaffolding, `check`, `graph`, Orca plans, `doctor` |
| `packages/config`, `packages/rules` | Zod configuration schema and repo/ADR checks |
| `packages/core` | Workflow phases, guardrails, reconciliation and storage abstractions |
| `packages/tickets`, `packages/graph` | Ticket adapters and code/product knowledge |
| `packages/workspace`, `packages/safe-fs` | Worktree operations and filesystem safety helpers |
| `packages/runners` | CLI runner adapters; credentials and subscription behavior need operator review |
| `packages/sandbox` | Rootless Podman/bwrap argv, process execution, host credential/egress broker, secret gate |
| `packages/qa` | Browser/API/mobile drivers and artifact-bound receipts |
| `packages/monitor`, `packages/compound`, `packages/watch` | Signal/triage, lessons/replay, collectors; not proof of production auto-fix |
| `packages/sdk` | Generated OpenAPI types and client helpers |
| `apps/server` | Hono REST, MCP, browser sessions, SSE, webhook ingress and Operations authorization |
| `apps/dashboard` | React dashboard views; captures under `docs/design/implemented` |

## Control plane

```text
local dashboard / scoped agent
       | HTTPS or reviewed loopback tunnel
       v
REST /v1/* + MCP /mcp + session /auth/*
       | shared Operations + Guard (scope, budgets, audit)
       v
CorePort -- current entrypoint: MemoryCore, in-memory keys/sessions
       |
       + target durable core/reconciler + reviewed workspace/runner integration
            | untrusted run token (not host key)
            v
         rootless sandbox -- Unix socket bridge --> host credential broker
            |                                     | allowed model routes
            + egress broker/allowlist              v
                                              local gateway
```

`apps/server/src/main.ts` instantiates `new MemoryCore()` and `new KeyStore()`;
it does not load a Postgres URL, start an Orca workspace adapter, or wire a
production runner/deployment loop. API responses alone do not prove those actions
ran. Audit/replay files have optional/default paths but do not turn memory into a
durable database. `GET /healthz` is HTTP liveness only.

Bearer API keys and dashboard human-key sessions are separate authentication
paths. Cookie mutations add origin/CSRF checks. MCP tools share REST authorization,
not a second privileged bypass. `/hooks/orca` uses raw-body HMAC signing and replay
defense, not agent Bearer auth. See [MCP](mcp.md) and [Orca](orca.md) for exact paths
and [security](security.md) for boundaries and residual risks.

## Workflow and receipts

The phase model is spike → implement → checks → review → QA → merge → deploy →
verify. Intended autonomy is explicit and evidence-gated, not an instruction to
grant all actions to agents. Run admission, approved budgets, secret scans, artifact
integrity and human authority must all be reviewed before a deployed factory loop.

`packages/qa/src/receipts.ts` creates receipts containing `kind`, `ok`, `summary`,
artifact `path`, `sha256`, and optional `data`. Hashes bind an artifact's bytes;
they are **not cryptographic attestations that a trustworthy test ran**. For
agent-produced files, root-bound reads prevent following symlinks outside the
root. Keep holdout expectations, validation authority and archived receipts outside
the agent's writable scope. Screenshots in `docs/design/implemented` show UI
implementation; they are not per-run acceptance receipts or end-to-end QA.

## What remains to validate

Durable storage/migrations, container/VM path bridges, credential revocation and
egress under races, run cleanup/resource accounting, dashboard interview integration,
stack generator outputs, deployment rollback and production error verification all
need actual integration evidence. Unit adapters intentionally avoid live model
quota. Doctor checks prerequisites and configured local reachability, never proves
this whole graph works. No full factory/prod autofix completion is claimed here.

Source references are repository-relative committed modules under the root license;
the prior-art names in SPIKE are inspiration, not bundled licensed implementations
or verified external deployment instructions.
