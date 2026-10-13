# Matrix MCP

The committed server exposes Streamable HTTP MCP at **`/mcp`**, alongside REST
`/v1/*` and unauthenticated liveness `GET /healthz`. This is not a stdio command or
an `/sse` connection URL. PR #27 is merged and the native factory loop is proven.
Use the durable production runtime described in [self-hosting](self-hosting.md);
in-memory/demo runtimes are not a restart-durable deployment.

## Connect from your local agent machine

Start the reviewed server **on the host** as in [self-hosting](self-hosting.md).
Keep it loopback-only behind TLS ingress or a reviewed tunnel. The examples use
`http://127.0.0.1:8740`, never a private host identity or invented public service URL.
Use the scoped project ID from your own control plane; `example-project` is a
placeholder, not a project created by this guide.

From the **local agent machine's trusted checkout root**, first inspect a dry run:

```sh
bun packages/cli/src/bin.ts orca register-mcp --server http://127.0.0.1:8740 --project example-project --agents codex --actions read
```

For apply, put the admin key in `MATRIX_ADMIN_KEY` in a **0600 protected env-file**
using a secure editor/prompt, not a literal shell-key assignment. Review the target
home and intended agent configuration first:

```sh
bun --env-file="$HOME/.config/matrix/client.env" packages/cli/src/bin.ts orca register-mcp --server http://127.0.0.1:8740 --project example-project --agents codex --actions read --apply
```

This calls `POST /v1/keys`, creates an **agent** key per selected agent and project,
and writes `~/.codex/config.toml` with a `matrix-<projectId>` MCP table pointing to
`/mcp` and a Bearer header. Only the selected project's entry is **replaced** with
new credentials; other project entries and unrelated
configuration is preserved, existing files backed up and outputs written 0600.
Preview the dry-run replacement plan and review a token-redacted diff of intended
configuration changes before `--apply`. Dry run creates no key and writes nothing.

Replacement revokes the exact previous credential's key through
`DELETE /v1/keys/{id}` **after the new config is written**, not by its shared agent
name. Rotation only revokes credentials belonging to the same server URL. If
revocation fails, registration reports failure but keeps the newly installed
credential valid; use a reviewed authorized client to inspect `GET /v1/keys` and
retry revocation. There is no standalone CLI revoke command documented here.
The 0600 backup may still contain the old token. Protect configs/backups and exclude
them from version control, logs and shared archives; never print or copy tokens
into terminal output, shell arguments or history. If apply fails, the helper
attempts to revoke newly created keys that were not installed; inspect `GET /v1/keys` and revoke
leftovers through the reviewed API if cleanup fails.

Other supported configuration targets are `~/.claude.json` and
`~/.config/opencode/opencode.json`; default helper selection includes all three.
Explicit `--agents codex` limits this workflow to Codex and does not call Claude
or any model. Orca-managed agent homes can differ; use a reviewed `--home` target.

For multiple projects, use `--project travel-journal,example-project` or repeat
`--project travel-journal --project example-project`. Duplicate IDs are registered
once. IDs must match `[A-Za-z0-9][A-Za-z0-9_-]*`; unsafe IDs are rejected rather than
normalized into potentially colliding names. Every minted key still covers exactly
one project. Register on each machine independently; rotating a local entry does
not revoke other machines' keys. Legacy `matrix` entries are left untouched: revoke
their credentials explicitly and remove the entry when migrating.

## Scope and authority

API tokens have format `mx_<12 lowercase alphanumeric>_<43 base64url>`. The server
stores hashes and returns a newly minted token once. Never invent a token by
typing a sample string. All MCP tools go through the same Operations/Guard layer
as REST, with project scope, action checks, per-key rate limits and mutation/run
budgets. Available actions in committed source are `read`, `tickets:write`,
`runs:start`, `runs:approve`, `merge`, `deploy`, `admin`. The last actions are not
safe defaults for an untrusted agent. Budgets are not a guarantee of model spend
accounting or a paid-provider fallback policy.

Use `read` first for each project; add `tickets:write` only after review. Do not
grant `admin` or all-project scope to workers. `list_projects` and `get_project`
are read tools; mutating tools do not become safe just because an MCP client
describes them as such. Do not start runs as a connectivity check.

## Revoke and browser authentication

**Authorized operator on the local control-plane client:** use `GET /v1/keys` to
identify the key ID, then `DELETE /v1/keys/{id}` with an authorized Bearer admin
key to revoke it. These are REST paths, not undocumented CLI subcommands. Use a
reviewed client which reads authorization from a secure prompt/env-file; never
put the key in curl arguments. Revoke before removing the local agent config and
its credential-bearing backups. Server revocation invalidates associated browser
sessions and active run SSE streams; verify reconnection is denied.

Dashboard login is `POST /auth/login` with JSON `{ "token": <human-key> }` over
protected transport. Agent keys cannot open dashboard sessions. `GET /auth/session`
returns the current session and CSRF token; `POST /auth/logout` clears it.
Cookie-authenticated writes need `x-csrf-token` and allowed origins; Bearer API
requests use the API guard rather than cookie CSRF. Cookies are HttpOnly,
SameSite=Strict and Secure by default. Do not disable secure cookies on an exposed
host. Logout is not key revocation.

Source of truth: `apps/server/src/mcp.ts`, `apps/server/src/auth/keys.ts`,
`apps/server/src/http/routes-session.ts`, `apps/server/src/http/routes-admin.ts`,
and `packages/cli/src/orca/mcp.ts`. No external endpoints/auth paths are assumed.
