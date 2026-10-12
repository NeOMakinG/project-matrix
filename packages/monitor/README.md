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

Runs the loop on a recorded Sentry event with a real model and prints the triage and generated ticket (never the key).
