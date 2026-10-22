# Linear ticket tracker

Matrix can use Linear issues as a project's ticket store (`LinearTicketStore`,
`packages/tickets/src/adapters/linear.ts`). One Linear team can host several Matrix projects:
each project is a **label** (for example `project:travel-journal`) inside the team.

## Configure

Project config (`matrix.config.ts`):

```ts
process: {
  tickets: "linear",
  linear: {
    teamKey: "NEO",                 // Linear team key
    projectLabel: "project:personal", // label that scopes this Matrix project
    readyState: "Ready",            // optional, default "Ready"
    apiKeyEnv: "LINEAR_API_KEY",    // optional, NAME of the host env var
  },
  // ...
}
```

Server-side, the stored project's `matrix.tickets` carries the same fields:
`{ kind: "linear", linear: { teamKey, projectLabel, readyState?, apiKeyEnv? } }`.

Put the personal API key in the **host** environment of the Matrix server (for example the
protected env file from [self-hosting](self-hosting.md)): `LINEAR_API_KEY=lin_api_...`.
Config only ever holds the variable name. The key is read per request, sent as the raw
`Authorization` header to `https://api.linear.app/graphql`, and is never passed to sandboxes,
runner environments, logs or error messages.

## Behaviour

- **Scope:** `list`/`get` only see issues of the team that carry the project label. Issue ids
  are Linear identifiers (`NEO-42`). `create` always adds the project label (missing labels are
  created on the team).
- **Pickup:** `ready()` returns only issues in the `readyState` column, with the project label,
  without the Matrix `blocked` flag and with no unresolved blocking relation (blocker not
  Done/Canceled). No other open issue is picked up.
- **Status mapping (coarse):** `open`→Todo, `ready`→Ready, `in_progress`→Implement,
  `review`→Review, `qa`→QA, `done`→Done, `closed`→Canceled. `blocked` keeps the current column
  and sets a flag in Matrix's hidden body block. Reading maps completed/canceled state types to
  `done`/`closed`, Spike/Implement and other started columns to `in_progress`, Awaiting merge to
  `review`, Backlog/Todo to `open`.
- **Links:** `blocks` and `related` become Linear issue relations; `parent` sets the issue parent.
- **Priority:** Matrix 0..4 maps to Linear 1 (urgent)..4 (low); Linear "no priority" reads as unset.
- **Untrusted text:** titles, bodies, labels and assignee names are stripped of zero-width,
  bidi, tag and other invisible characters on read.
- **Resilience:** cursor pagination (100 per page); 429/`RATELIMITED`/5xx/network errors retry
  with backoff (honours `Retry-After`), then surface as `LinearApiError`.

## Live smoke test

Read-only and skipped by default:

```sh
MATRIX_LINEAR_LIVE=1 LINEAR_API_KEY=... bunx vitest run packages/tickets/src/adapters/linear.live.test.ts
```

`MATRIX_LINEAR_TEAM` / `MATRIX_LINEAR_LABEL` override the team (`NEO`) and label
(`project:personal`).

## Not yet

Per-phase column mapping, a live status comment, the `needs-human` label, webhooks, and choosing
Linear from the HTTP/SDK create-project endpoint are follow-ups.
