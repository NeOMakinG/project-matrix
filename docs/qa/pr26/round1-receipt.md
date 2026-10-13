# PR26 round 1 recovery receipt

Date: October 12, 2026. Branch: `feat/dashboard-init-flow`.

## Explicit integration dependency

PR26 is stacked on **PR27 / `feat/integration` at
`2220c495a5a72bd21d10ef8f568dde3eff124590`**. This commit is already an
ancestor of the recovered worktree. PR27 must merge before PR26; do not rebase
onto a base without these endpoints or replace them with production mocks.

The dashboard imports generated `@matrix/sdk` `paths` / `components` directly.
The descriptor extension is currently present in the integration owner's
uncommitted source and generated SDK, not in the ancestry commit above. Only
`packages/sdk/openapi.json` and `packages/sdk/src/schema.d.ts` were overlaid from
that worktree, byte-for-byte (SHA-256 prefixes `222c686f` and `36b2e481`).

Superseded: this branch now merges `feat/integration`, so the SDK arrives through
history instead of an overlay. See `round2-real-browser.md`.

PR27 must include this descriptor extension and generated SDK before PR26 is
rebased/merged. This is a real unmerged dependency, not a mock replacement.
No server, operations, SDK generator, rules, templates, routing configuration,
paid service, or user configuration files were changed during recovery.
The pre-existing executable-bit edit to `packages/watch/src/bin.ts` is preserved
and deliberately excluded from the dashboard commits.

## Prior issues / status

| Priority / issue | Implementation status | Evidence / remaining verification |
| --- | --- | --- |
| P1: confirmed answers cannot be edited | Visible Edit actions and PATCH revision; server session/progress replaces cached interview | `src/test/init-recovery.test.tsx` exercises PATCH and removed dependency announcement; real-server recovery pending |
| P1: invalidated answers silently disappear | Persistent interview-level announcement lists `dropped` question IDs | Component regression passes; real screenshot pending |
| P1: partial autonomy save looks successful | One atomic policy PUT using the captured project GET ETag; 428 blocks submission without ETag, 412 stays on the form with explicit reload/retry | Component regression verifies a single PUT, If-Match, failure, and no finalize transition |
| P1: retries duplicate projects | Stable request keys per unchanged submission, separate project/init keys | Component regression retries init failure after successful project creation and checks both keys |
| P1: fake finalize success | Generated SDK response; only `result.status=ok` reveals artifacts/backlog link; absent/invalid result and missing endpoint stay visibly unsuccessful | Component success test passes; live artifact/backlog verification pending |
| P1: contradicted finalize cannot recover | Server contradictions and 409 details expose Re-ask; confirmed answers remain editable | Real journey includes intentional ORM/database contradiction but has not run |
| P2: client pack fallback diverges | Removed client engine, recommendations, previews, and contradiction calculation; displays server `progress.round`, `contradictions`, previews and ADRs | Presentation tests use a server-defined unknown question; production bundle contains no pack fallback |
| P2: list newlines disappear | Raw multiline draft retained; parse only at round/revision submission | Submission unit test passes |
| P2: permissions and stale responses | Session scope controls mutation UI; older-generation API responses are rejected; existing whole-cache auth clearing retained | Permission unit tests and existing auth regressions pass |
| P2: live stream reopens after terminal close | Terminal close is permanent; late events/errors ignored; frame, message, metadata, replay keys and log buffering bounded | SSE regression suite passes, including multibyte frame and late terminal callbacks |
| P2: visual/keyboard/empty/loading/error states | Existing screen structure retained; narrow-width interview stacks; existing focus-visible controls, loading, alerts and empty states retained | Component suite passes; seven-screen visual parity and live keyboard journey not certified |

## Confirmed-question descriptor contract

The integration owner has supplied the requested descriptor extension.
`InitProgress.answered[]` now contains `questionId`, `label`, display `value`, and
all RoundQuestion fields: `id`, `pack`, `kind`, `prompt`, `rationale`,
`recommended`, `options`, `dependsOn`. The dashboard validates and prioritizes
these authoritative descriptors for editing after refresh. Display values are
never used as editable values: controls initialize from raw `session.answers`.
Raw JSON is retained only for legacy/incomplete descriptor responses, with an
explicit metadata-unavailable explanation and no inferred question kind.
Known required lists remain nonempty; confirmed multiselect arrays may be empty.

## Validation actually performed

- Dashboard component suite: 93 tests passing in 13 files after descriptor integration.
- Workspace typecheck and Biome lint: passing.
- Production dashboard build: passing. No MSW worker/browser import in output.
- `bun run check`: attempted; 598 tests passed, 29 skipped, 7 failed across
  four unrelated workspace suites, with 7 uncaught socket errors. QA/watch
  fixture servers and sandbox broker cannot bind sockets (`EPERM`); sandbox
  gitleaks assertions also fail. Those files were not modified.
- Remote access attempt: sandbox denies SSH transport. No service was restarted,
  no remote project/user was touched, and no backend was started for browser QA.
- One browser launch attempt failed under the local sandbox before any journey
  or API interaction. The real test now skips at module level unless an existing
  same-origin target, isolated credential and explicit exclusive QA lease exist.
  No further browser launch was attempted.

## Queued real QA / evidence paths

Run on the authorized QA host only after the integration worker releases its
browser slot. Use an isolated human admin test credential supplied privately,
`MATRIX_E2E_BASE_URL`, `MATRIX_E2E_TOKEN`, and
`MATRIX_E2E_HOST_LEASE=pr26`; never commit credentials or target addresses.
`bun run --cwd apps/dashboard test:e2e:real` connects to the existing deployment,
does not start/restart a backend, and creates only uniquely prefixed `pr26-qa-*`
projects with the UI's stable idempotency keys. Coordinate the lease outside
this test; the environment flag alone is not a distributed host lock.

The test requires login, business-first rounds, intentional contradiction,
visible Edit recovery, autonomy, successful finalize, artifacts and a nonempty
board. Tracing/video/automatic screenshots are disabled to avoid credential
capture. Only authenticated journey screenshots are requested under
`docs/qa/pr26/screenshots/`: `01-round.png`, `01b-contradiction.png`,
`01c-recovered.png`, `02-autonomy.png`, `03-finalize.png`, `04-board.png`.
**These screenshots do not exist yet. No live flow or visual parity pass is claimed.**

Keep PR26 draft/not ready until PR27 deployment, live journey evidence and
remaining confirmed-question metadata coverage have been reviewed. No merge or
ready-state change was requested or performed.

## Commit / push blocker

The worktree's Git administrative directory is outside the writable sandbox.
Both scoped `git add` and `git commit` fail creating `index.lock` with
`Operation not permitted`. No hooks were bypassed, no alternative Git directory
was created, and no files from other workers were staged. Consequently there
are no recovery commits to push; HEAD remains
`63ad3bac2143cc43ba4879d640a988f9a34d2587`.

Suggested scoped chunks once normal Git access is available: API/session/SSE
contracts and regressions; interview/revision/autonomy/finalize UI and component
tests; real-journey runner and this receipt. Every recovery commit must retain
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
Push only `HEAD:refs/heads/feat/dashboard-init-flow` with normal hooks enabled.
GitHub PR/review retrieval is also network-blocked, so this table maps the
user-supplied prior issue list, not independently retrieved review comments.
The receipt has not been posted to PR26.

## Independent review follow-up

Dashboard-only follow-up preserves all earlier saved edits. Confirmed questions
without descriptors now use explicit raw JSON editing, not a fabricated list,
text, number or confirm descriptor. Empty restored multiselect arrays can be
submitted. Known server-described required lists still use the unchanged
nonempty-list validation. The new review-lanes component regression calls the
actual server `reviseAnswer` function in-process, verifies
acceptance of `[]`, and checks rejection of an invalid lane. This is component
evidence, not a running-server or live-browser pass.

Revision cancels init reads before PATCH, passes AbortSignal to both GETs,
tracks per-client/per-session generations, cancels reads again before cache
installation, and checks authentication generation before installing the
authoritative response. Deferred-read regressions cover both a pre-PATCH
refetch and a focus-style refetch started during PATCH; neither can resurrect
dropped answers. Cross-project sessions render an explicit mismatch error with
no interview mutation controls, including for globally scoped admin sessions.

Focused follow-up checks: 11 recovery/presentation tests pass; the dashboard's
full 90-test component suite, dashboard typecheck, dashboard source lint and
production build pass. No Git write, SSH, GitHub, backend-start, or browser-QA
retry was attempted during follow-up.

Backend descriptor contract requested: expose an authoritative confirmed-question
descriptor keyed by `questionId` (reuse the generated round descriptor for
`id`, `pack`, `kind`, `prompt`, `options`, `recommended`, `rationale`, `dependsOn`)
and authoritative required/cardinality constraints where applicable. Publish
it through progress or a generated lookup endpoint. Until then, unknown
descriptors remain raw-value editing with validation delegated to the server.
The P1 finalize overwrite of saved human autonomy is handled by the integration
owner; no server/operations file was changed here.

## Descriptor integration and async-fixture diagnosis

Answered descriptors now take precedence over previously cached round metadata.
The refreshed ORM edit regression checks that display `Drizzle` remains raw
`drizzle`, renders the real select options, and PATCHes the changed raw option ID.
The refreshed review-lanes regression clears a real multiselect control and uses
server revision validation. Separate tests cover required-list nonemptiness and
explicit legacy descriptor omission.

The observed first-render DOM was still a Loading/Suspense state, not a missing
answer or wrong-project error. Tests now await route/chunk and init-query
readiness before finding controls. The login-return test awaits the monitor
route's resolved event and its actual monitor query before checking the incident.
No test timeouts, artificial sleeps, or assertion weakening were added.

An independent fixture-isolation defect was also found: `makeRouter` registered
an unauthorized listener that survived renderer cleanup, keeping old routers and
query clients alive. The listener now belongs to AppShell's effect lifecycle and
unsubscribes on unmount, with a regression proving it cannot navigate an unmounted
router. Teardown cancels/clears rendered query clients and advances the auth
generation before resetting handlers/data, preventing old responses from affecting
the next fixture.

The correct dashboard fixture includes all descriptor fields explicitly and
never infers kind from a stored array/string. Focused descriptor/auth/recovery
tests: 30 passing; dashboard components: 93 passing; dashboard typecheck and
workspace lint pass. Sequential full-workspace check result is recorded below.

One sequential full check was run as
`bun run typecheck && bun run lint && bun run test -- --no-file-parallelism`.
Workspace typecheck and lint passed; every dashboard test passed. Overall:
606 tests passed, 8 failed, 29 skipped, with 7 uncaught socket errors
(72 files passed, 5 failed, 1 skipped). Existing QA/watch/broker fixtures cannot
bind sockets in this sandbox; the two sandbox gitleaks assertions still fail.
The additional SDK OpenAPI-parity test fails because the exact PR27 SDK overlay
includes confirmed descriptors while this worktree's intentionally untouched
backend still has the older schemas. That parity failure is the explicit
unmerged backend dependency, not justification to modify backend source or
regenerate away the new SDK. No full-check retry was performed.

The coordinator-authorized identical fixture copy to the integration worktree
was attempted once but denied by the filesystem sandbox. That worktree's fixture
is unchanged. The coordinator must copy
`apps/dashboard/src/mocks/data/init.ts` to the same path in integration; no backend
source or other integration file was touched. No Git/SSH/network or live-QA retry
was made during descriptor integration.
