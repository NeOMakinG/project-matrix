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
    apiKeyEnv: "LINEAR_API_KEY",    // optional, NAME of the host env var (must contain LINEAR)
  },
  // ...
}
```

Server-side, the stored project's `matrix.tickets` carries the same fields:
`{ kind: "linear", linear: { teamKey, projectLabel, readyState?, apiKeyEnv? } }`. Create such a
project over HTTP/SDK with `POST /v1/projects` and
`tickets: { kind: "linear", linear: { teamKey: "NEO", projectLabel: "project:demo" } }`. The API
rejects unknown fields (there is no field for the key) and `apiKeyEnv` must be an env var name
containing `LINEAR` (for example `LINEAR_API_KEY`, `TJ_LINEAR_KEY`). The init interview asks the
same four fields when Linear is the tracker; on the server the project's settings win.

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
- **Status mapping (coarse, used without a phase):** `open`→Todo, `ready`→Ready, `in_progress`→Implement,
  `review`→Review, `qa`→QA, `done`→Done, `closed`→Canceled. `blocked` keeps the current column
  and sets a flag in Matrix's hidden body block. Reading maps completed/canceled state types to
  `done`/`closed`, Spike/Implement and other started columns to `in_progress`, Awaiting merge to
  `review`, Backlog/Todo to `open`.
- **Board columns per phase:** while a workflow runs (or waits for approval) the issue follows it:
  spike→Spike, design/implement/checks→Implement, review→Review, qa→QA, merge (running or awaiting
  approval)→Awaiting merge, done→Done. Pending (queued/backing off) and blocked keep the current
  column; an issue a human moved to Done/Canceled is never pulled back. Override with
  `phaseColumns` on `LinearTicketStore`.
- **Live status comment:** one comment per issue (key `matrix-status`), created once and then
  edited in place with phase, status, attempt/review loops, the last error (redacted, one line),
  https links from run receipts (PR, evidence) and a timestamp. Its comment id rides in the hidden
  Matrix body block and is only trusted when it is Matrix's own comment on that same issue; a
  lost id is recovered by the `<!-- matrix-comment:matrix-status -->` marker, a deleted comment is
  recreated. Failed writes retry up to 3 times with backoff. Updates are debounced (1.5 s) and coalesced
  per issue, and nothing is written when the rendered status did not change.
- **Project label:** created on the team (if missing) on the project's first ticket sync.
- **Tracker outages never fail a workflow.** Every failed tracker write (status update, comment,
  column move, status comment, label) is logged as a structured warning
  (`{"level":"warn","event":"tracker.failed",...}`), published on the event bus as
  `tracker.failed`, and listed newest first by `GET /v1/projects/{id}/tracker/failures`.
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

## Guardrails

- **needs-human:** when Matrix blocks a ticket (retries or loops exhausted, tooling failure,
  per-ticket cap) it adds the `needs-human` label and comments the reason. Move the issue back to
  **Ready** (or, if it was blocked while in Ready, remove the label) to restart it in the same
  phase with fresh attempt/loop budgets; Matrix removes the label on restart. At most 3 restarts
  per ticket per UTC day (`maxRequeuesPerDay`), so a flapping board cannot loop the factory.
- **Own comments:** every comment Matrix posts carries a hidden `<!-- matrix:bot -->` marker. A
  comment counts as Matrix's only with that marker AND the API key's own identity, so a personal
  key does not hide the human's comments, and a pasted marker does not hide a human's either.
  Matrix never feeds its own comments back into prompts.
- **Untrusted prompt input:** title, body and human comments reach agents sanitized and fenced in
  `<<<UNTRUSTED TICKET CONTENT …>>>` markers the content cannot close.
- **Subscription quota** (`MATRIX_QUOTA`, JSON, server-wide): per provider (`claude`, `codex`)
  max concurrent runs (default 2), runs per rolling hour (20), runner minutes per rolling 5h
  (300), plus runner minutes per ticket (240; a `perTicketUsd` budget applies instead once runs
  report spend). A run failing with a 429 / usage-limit error puts its provider in cooldown
  (1 min doubling to 1 h), keeps the ticket queued without spending an attempt, emits
  `quota.cooldown`, and shows in `GET /v1/quota`. Example:
  `MATRIX_QUOTA='{"providers":{"codex":{"maxConcurrent":1}}}'`.

## Not yet

Webhooks (changes still arrive by polling) and retrying a failed status comment before the next
workflow change are follow-ups. Quota cooldowns live in memory (a restart forgets them; the
rolling limits still hold).

## Existing repos

A repo registered with `repo` on `POST /v1/projects` (see
[self-hosting](self-hosting.md#existing-repos-draft-prs-human-merge)) uses the same Linear
settings. Its runs stop at **Awaiting merge** with a draft GitHub PR linked in the live status
comment (`- Draft PR: ...`). The ticket moves to Done once a human merged that PR on GitHub and
approved the merge in Matrix. `PATCH /v1/projects/{id}` with `tickets` changes the team, label
or key env var name without recreating the project.
