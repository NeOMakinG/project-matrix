---
name: node-api
description: Quality rules for the TypeScript API (Bun/Node, Hono, tRPC, Drizzle, better-auth) in a Matrix project. Use when writing or reviewing API routes, procedures, database access, auth or background jobs.
---

# Node API quality

## Structure

- `src/routes` or `src/trpc` hold transport only: parse input, call a service, map errors.
- `src/services` hold business logic; pure functions where possible, unit tested.
- `src/db` is the only place that imports the ORM (ADR rule). Services take a repository.

## Input and output

- Every input is parsed with Zod at the boundary; never trust `c.req.json()` shapes.
- Return typed errors (`TRPCError` codes or a `Result`), not thrown strings. Map them once to HTTP.
- Never leak stack traces, SQL or internal ids in responses.

## Data

- Migrations are generated (`drizzle-kit generate`) and committed; never edit an applied migration.
- Multi-row changes run in a transaction. Money is integer cents.
- Every query on tenant data filters by tenant id; add a test proving another tenant gets nothing.

## Auth

- Sessions are verified on every request by middleware, not per handler.
- Authorization is explicit per procedure; deny by default.
- Webhooks (Stripe etc.) verify signatures on the raw body and are idempotent (store event ids).

## Reliability

- Outbound calls have timeouts and retries with backoff; jobs are idempotent.
- Log with structured fields and the trace id; never log secrets, tokens or personal data.
- OpenTelemetry spans around external calls and DB transactions.
