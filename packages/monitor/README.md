# @matrix/monitor

The prod loop: production signals become grouped issues, get triaged, turn into tickets, and fixes are verified after deploy.

```
SignalSource (server webhook store, SentryPoller, PosthogPoller)
  → normalize (Sentry, GlitchTip, PostHog, OpenTelemetry/Alertmanager, Uptime Kuma)
  → ingest (dedupe by signal id, group by fingerprint)
  → triage (severity, impact, regression, code-graph hints, LLM fixability)
  → policy (auto-fix ticket "ready" for the loop, or needs-human ticket + notification)
  → markFixDeployed(fingerprint, release) from the deploy phase
  → verify (rate before vs after the fix deploy → close or reopen the ticket)
```

## Grouping

- Errors with in-app frames: exception type + top 3 in-app frames (file + function, no line numbers).
- Otherwise the provider's own fingerprint, otherwise the title with numbers, UUIDs and hex masked.

So the same bug reported by Sentry and PostHog lands in one issue.

## Triage

- **Severity:** level, users, rate per hour and regression; downtime and fatal are always critical.
- **Regression:** first seen after a deploy and absent from every earlier release, or recurring after a fix.
- **Fixability:** one LLM call through an OpenAI-compatible gateway (CLIProxyAPI), temperature 0, fixed seed, versioned prompt with a recorded hash, output validated with Zod, one retry, then a safe "needs a human" fallback. Files the model names that aren't in the stack or graph hints are dropped.

## Security

Production evidence is untrusted: client SDKs and public capture keys accept anyone's events.

- **Redaction at the single entry point** (`normalize` → `sanitize`): URL query strings and fragments dropped; emails, JWTs, bearer tokens, known key prefixes, `key=value` secrets, card-like numbers, IPs and long high-entropy tokens masked; configurable denylist for known secret values. User ids are hashed. Nothing unredacted is stored, sent to the LLM or put in a ticket.
- **Trust levels**: `client` (browser/mobile SDKs, PostHog), `server` (server SDK events, only from projects listed in `trustedServerProjects`), `infra` (alert rules, uptime).
- **Auto-fix needs more than fixability**: category `code`, fixability ≥ threshold, no instruction-like content (`injection.ts`), and corroboration: a `server`/`infra` signal, or ≥ 5 distinct users with stack frames the code graph confirms exist in the repo. Everything else is `needs-human`.
- **Evidence is fenced**: in the triage prompt (delimited, labelled as data, delimiters neutralized) and in tickets (`~~~text` blocks, inner fences neutralized, titles built from structured fields only, explicit note to the implementing agent).
- **Private tracker**: `requirePrivateTracker` (default on) refuses to file prod-fix tickets unless `trackerVisibility` is `private`.
- Notifications strip control characters; pollers refuse to send tokens over non-https origins.

## Reliability

- Ingest writes the occurrence (idempotent per signal id) and the issue before marking the signal seen; the cursor only advances after a successful ingest, with a 10-minute overlap absorbed by dedupe.
- Issues still `new`/`reopened` are retried every tick; failures are reported in `TickResult.errors` and stored as `lastError`.
- Tickets carry a `fp:<fingerprint>` label so a ticket created before a crash is found again instead of duplicated.
- Verify updates the ticket before the issue, so a tracker failure leaves the issue in `verifying` and the step is retried.
- Pollers paginate fully (Sentry `Link` header, PostHog keyset on `(timestamp, uuid)`), time out, and fail loudly when a backlog exceeds the page cap; `MergedSource` keeps a cursor per source.

## Verify window

Baseline: 24 h before the fix deploy. The after window is at least 6 h and grows (up to 72 h) until the baseline predicts ≥ 3 occurrences; silence after a too-small baseline ends as `inconclusive`, not `resolved`. Only occurrences from the fix release (or untagged) count against the fix; older releases are reported as stale clients.

## Ports

| Port | Purpose |
|---|---|
| `SignalSource` | Raw signals (server webhook store, pollers) |
| `IssueStore` | Issues and occurrences (`MemoryIssueStore` included) |
| `TicketStore` | From `@matrix/tickets` |
| `GraphPort` | Code-graph hints (`framesOnlyGraph` fallback) |
| `ReleasePort` | Deployment history |
| `LlmClient` | `GatewayLlm` for the CLIProxyAPI gateway |
| `Notifier` | `TelegramNotifier`, `EmailNotifier`, `MultiNotifier` |

## Live receipt

```
MATRIX_GATEWAY_URL=http://<gateway>/v1 MATRIX_GATEWAY_KEY=… bun src/live-triage.ts gpt-6.1-sol
```

Runs two recorded scenarios with a real model (a server-side bug, and the PR #5 review's injection payload from 5 client users) and prints the decisions (never the key).
