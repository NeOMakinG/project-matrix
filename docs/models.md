# Project model routing

`matrix init` asks `models.plan` as a JSON model plan, including runner/model pairs
for each tier and phase. Recommendations are large `claude-code/claude-opus-5-5`,
small `claude-code/claude-sonnet-5-5`, and reviewer `codex/gpt-6-sol`. Finalizing the
server interview also saves this plan into the stored project used by the factory.

Example `models` section in `matrix.config.ts`:

```json
{
  "tiers": {
    "large": { "runner": "claude-code", "model": "claude-opus-5-5" },
    "small": { "runner": "claude-code", "model": "claude-sonnet-5-5" }
  },
  "smallEstimateThreshold": 3,
  "implement": { "runner": "claude-code", "model": "claude-opus-5-5" },
  "review": { "runner": "codex", "model": "gpt-6-sol" },
  "qa": { "runner": "codex", "model": "gpt-6-sol" },
  "aliases": { "claude-opus-5-5": "claude-opus-4-7" }
}
```

Spike and implementation use the small tier when the ticket has `size:small` or a
finite, nonnegative numeric `estimate` below `smallEstimateThreshold` (default 3).
The boundary is exclusive; missing estimates default to large. Estimates use the
project's own units; memory/markdown tickets preserve them, and label-based routing
works with every adapter. Other phases use their configured phase default or fall
back to `implement`. Existing configurations without tiers retain phase selection.

Reviewer, holdout scenario writer, probe planner and judge must differ from the
implementer. Reviewer fallbacks are checked after alias resolution too: changing
runner or logical name cannot disguise the same gateway model. If no independent
model is configured, the factory fails closed instead of self-reviewing.

Aliases map logical IDs directly to gateway IDs at runner invocation; they are not
recursive. Workflow implementation identity records the resolved ID used by the
runner so later alias changes cannot enable self-review. The example alias
supports this deployment's CLIProxyAPI v8.0.8 routing of Opus 5.5 as
`claude-opus-4-7`; configure aliases explicitly for your gateway, not globally.

```sh
matrix models check --gateway http://127.0.0.1:8317
matrix models check --gateway https://gateway.example --config matrix.config.json
```

The check statically reads generated config/JSON (never executes TypeScript), lists
logical → resolved IDs, and makes only `GET /v1/models`. It does not infer or start
runs. A gateway base ending in `/v1` is also accepted. Exit 0 means all resolved IDs
are listed; exit 2 means IDs are missing. Listing failures produce an error. This
checks advertised availability, not successful inference or alias semantics.
If needed, set `MATRIX_GATEWAY_TOKEN` through a protected environment file; do not
put credentials in URLs or command-line arguments. Authenticated requests require
HTTPS or loopback HTTP and do not follow redirects.
