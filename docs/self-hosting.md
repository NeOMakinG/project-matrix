# Self-hosting (development preview)

This is an operator checklist, not a production deployment promise. The committed
`apps/server/src/main.ts` starts MemoryCore and an in-memory KeyStore. PostgreSQL
persistence and the integrated runner wiring are not selected by this entrypoint.
PR #27, #26 and #24 remain open and need actual QA. Do not expose the preview to
untrusted users or schedule autonomous merge/deploy.

## Locations and prerequisites

- **Local workstation:** review this checkout, run unit tests, connect the dashboard/MCP.
- **Linux host, unprivileged service account:** run Matrix, rootless Podman, the
  host-side credential broker and optional Orca. No sudo Matrix or rootful fallback.
- **Postgres container:** database only, on a persistent volume; never the runner's
  writable worktree. SQL/backup commands run here under a separately scoped DB role.
- **Runner container:** untrusted project code only. No host API/admin/gateway keys.

Install Bun, Git >=2.40 and gitleaks through reviewed host packages. A host
administrator must configure Podman subordinate UID/GID ranges and user namespaces;
use `podman info --format=json` **on the Linux host** to verify rootless mode. bwrap
is a Linux fallback, not equivalent container/cgroup isolation. macOS's Podman VM
and native Windows are not validated runtime targets; WSL2 needs kernel/mount QA.
Do not blindly apply the machine-specific scripts in `ops/bosgame` to another host.

Doctor **ignores inherited PATH**, including absolute external paths. Its Unix
default approval policy is `/usr/bin` and `/bin`, only when each directory and
binary is canonical, nonsymlink and not group/world-writable. A symlinked `/bin`
is skipped; `/usr/bin` remains independently checked. Windows has no default tools
directory. Only the currently running Bun executable is implicitly trusted after
the same file/path checks, not other tools beside it.

For operator-managed installs, explicitly pass repeatable `--trusted-tools-dir`
with a reviewed, canonical absolute install directory. No environment/project
configuration grants approval. Symlinked launchers (including package-manager
shims) are rejected: approve the actual protected binary install directory instead,
not a directory obtained blindly from inherited PATH. Project paths and
group/world-writable installs are rejected even with the flag. Do not approve
temporary directories or trees writable by projects. Child tools receive only
validated approved directories as PATH; unresolved probes fail closed. These
checks do not remove filesystem races or hardlink risks (#13/#14).

## Protected environment and development server

**On the host**, create a private configuration directory (0700) and an environment
file (0600), using a secure editor or secret manager. Do not paste keys into shell
assignments, CLI arguments, chat or history. Use an absolute protected env-file with
Bun's `--env-file` or systemd `EnvironmentFile`. Values are configuration, not a
request to fetch secrets. Do not source an untrusted environment file as shell code.

Supported server variables from the entrypoint:

| Variable | Purpose |
| --- | --- |
| `MATRIX_HOST`, `MATRIX_PORT` | Defaults `127.0.0.1`, `8740`; keep behind authenticated TLS ingress |
| `MATRIX_BOOTSTRAP_TOKEN` | Human admin bootstrap; token format `mx_<12 lowercase alphanumeric>_<43 base64url>` |
| `MATRIX_AUDIT_FILE`, `MATRIX_REPLAY_LOG` | Protected persistent audit/replay paths; default replay under `~/.matrix` |
| `MATRIX_DASHBOARD_ORIGINS` | Comma-separated exact browser origins |
| `MATRIX_INSECURE_COOKIES` | `1` only for isolated local HTTP development; secure cookies default |
| `MATRIX_ORCA_SECRET` | Shared signed-hook secret; other webhook secrets have their own variables |

For first bootstrap, this command writes a generated token **on the host**, without
printing it to the terminal (the protected file must not already exist):

```sh
umask 077
(set -C; bun apps/server/src/gen-token.ts > "$HOME/.config/matrix/bootstrap-token")
```

Transfer its value using the secure editor into the protected server env-file and
the dashboard's human-key login; do not use `echo`, command-line interpolation or
logs to convey it. The directory must exist with the permissions described above.
Delete the temporary token file securely according to your storage policy.

From the **reviewed checkout root on the host**:

```sh
bun install --frozen-lockfile --ignore-scripts
bun --env-file="$HOME/.config/matrix/server.env" apps/server/src/main.ts
```

`GET /healthz` confirms HTTP liveness, not database/runner readiness. Keys, sessions,
settings and project/run state in MemoryCore are lost on restart; the audit/replay
files do not reconstruct them. New keys created through `/v1/keys` are shown once.
Do not mistake a reachable dashboard for durable factory operation.

## Postgres and systemd

**On the Linux host**, use an operator-reviewed rootless Postgres container/Quadlet
with a pinned image, named persistent volume, loopback-only published port and a
protected password file (`POSTGRES_PASSWORD_FILE` in the official container).
Have an administrator review storage ownership, SELinux labels and subordinate IDs.
Create separate application/backup roles. Do not mount its secrets or volume in
runner containers. This prepares storage; it does **not** connect MemoryCore to it.
No committed migration/deployment command is documented as production-ready here.

An example **host user unit**, installed only after review, with operator-adjusted
absolute Bun and checkout paths:

```ini
[Unit]
Description=Matrix development control plane
After=network-online.target

[Service]
WorkingDirectory=%h/matrix/project-matrix
EnvironmentFile=%h/.config/matrix/server.env
ExecStart=%h/.bun/bin/bun apps/server/src/main.ts
Restart=on-failure
NoNewPrivileges=yes
PrivateTmp=yes
UMask=0077

[Install]
WantedBy=default.target
```

Use `systemctl --user daemon-reload` then `systemctl --user enable --now matrix`
**on the host**, for a reviewed `matrix.service`. Administrator-managed lingering,
firewall and TLS are separate steps. These commands change host state; doctor does
not run them. Restrict journal access and review error redaction before collecting logs.

## Local gateway and keybroker

Configure an operator-owned, local/subscription-backed gateway. Matrix's broker
accepts `gatewayUrl` and `gatewayKey: CredentialSource` in code; these are **not**
server entrypoint environment switches. Wire and review the broker before runners
are enabled. Prefer `{ file: protectedPath }` or `{ env: variableName }`; never
put credentials in repository config. Credential command sources execute on the
host and therefore require explicit review, not project-provided commands.

The broker gives each run a revocable token, strips caller auth, substitutes host
auth, and exposes only reviewed LLM routes through a Unix-socket bridge. Egress uses
a separate broker/allowlist; restrict destinations and ports, keep private-address
access off, and do not make arbitrary upstream endpoints available. Rootless
network isolation alone is not a complete host-resource boundary. See [security](security.md).
Do not configure paid fallback or trigger inference as a readiness probe.

## Doctor

**On the actual Linux host**, from a trusted checkout/project directory:

```sh
bun --env-file="$HOME/.config/matrix/doctor.env" packages/cli/src/bin.ts doctor --json
```

If tools are deliberately installed in a protected, canonical user install
directory, the **host operator** can add it explicitly, for example
`--trusted-tools-dir "$HOME/.bun/bin"` only after verifying that directory and
its binaries satisfy the policy above. Approve other install directories separately;
this flag is an execution trust grant, not merely a search-path convenience.

In that protected file, configure `MATRIX_DOCTOR_POSTGRES_URL` (or `DATABASE_URL`),
`MATRIX_DOCTOR_GATEWAY_URL` as a loopback HTTP(S) **origin**, and optionally
`MATRIX_DOCTOR_GATEWAY_TOKEN` and `MATRIX_DOCTOR_GATEWAY_HEALTH_URL` (the gateway's
documented read-only endpoint on the same origin). Remote local gateways need a
reviewed loopback tunnel. Doctor never accepts public/paid gateway origins, follows
redirects, or calls inference routes. Health route semantics belong to the gateway.
Models are checked with `GET /v1/models`; model names and auth are not printed.

Postgres receives only an SSLRequest protocol probe, not a login or SQL query;
reachability is not TLS/auth/migration validation. Checks have a 3-second timeout,
20-second total deadline, and 16KiB process/HTTP output caps. All external errors
are withheld. Exit 2 indicates blocked/unsupported prerequisites. Missing gitleaks
sets `publishBlocked`; finding it is not a completed secret scan. Optional Orca and
Tailscale version checks require `--optional`; pairing/auth are not checked.
Headroom target is 4GiB free host RAM and 10GiB available disk at cwd, not a promise
about VM/cgroup capacity. `runtimeVerified` is always false: reviewed runtime QA
must still test images, broker, mounts, receipts and cleanup.

## Backups and upgrades

**Host operator:** quiesce runs; preserve repository config/ADRs/tickets, worktrees,
receipt files, audit/replay files and separately encrypted credential material.
**Postgres container/backup role:** take `pg_dump` backups to restricted host storage,
and test `pg_restore` into a separate database before trusting recovery. Do not copy
a live database volume as a consistent backup. MemoryCore state/key revocations
are not durable snapshots; restarts require rebootstrap and scoped-key re-registration.

Pin/review upgrades, back up first, test in staging, then stop the host user unit,
deploy a reviewed checkout/dependencies and restart. Schema migrations belong to
the eventual durable integration; do not invent a `matrix migrate` command. Keep
rollback checkout and restore evidence. Re-run doctor and operator runtime QA;
passing unit tests does not mark PR #27/#26/#24 ready.

## Existing repos (draft PRs, human merge)

Matrix can work on a repo that already exists on the host (for example `~/Projects/wayline`)
instead of creating an empty one. The feature is off until the operator allowlists where such
repos may live:

```sh
MATRIX_REPO_ROOTS=/home/neo/Projects   # colon-separated absolute dirs; empty = off
MATRIX_GH=/usr/bin/gh                  # optional; gh must be authenticated on the host
```

Register with an admin key (`POST /v1/projects`; the API key is never sent, only the env var NAME):

```json
{
  "name": "Travel Journal",
  "workspace": "orca",
  "repo": {
    "path": "/home/neo/Projects/wayline",
    "baseBranch": "main",
    "remote": "origin",
    "editablePaths": ["app", "docs", "designs"]
  },
  "tickets": {
    "kind": "linear",
    "linear": { "teamKey": "NEO", "projectLabel": "project:travel-journal", "apiKeyEnv": "LINEAR_API_KEY" }
  },
  "models": {
    "implement": { "runner": "claude-code", "model": "claude-opus-4-7" },
    "review": { "runner": "codex", "model": "gpt-6-sol" },
    "qa": { "runner": "codex", "model": "gpt-6-sol" }
  }
}
```

The server checks that the real path (symlinks resolved) sits under `MATRIX_REPO_ROOTS`, is a
canonical git repo (a `.git` directory, not a worktree), is not already registered, that the base
branch exists and that the remote points at `github.com`. With `MATRIX_RUNTIME=orca` it also
registers the repo in Orca (`orca repo add --path`) when missing. Only `linear` or `github`
trackers are accepted, and nothing is written into the repo: no init interview, no config files,
no tech-watch digests. The project config lives in the Matrix database.

- **Checks**: `checks` is optional. By default Matrix reads the committed `package.json` on the
  base branch and runs its `typecheck`, `lint` and `test` scripts with the package manager named
  by the lockfile (`bun`, `pnpm`, `yarn`, else `npm`). No scripts means no checks: set them.
- **Editable paths**: `repo.editablePaths` lists what agents may change (here `app/`, `docs/`,
  `designs/`). Default: every tracked top-level directory on the base branch plus the usual
  manifests (`package.json`, lockfiles, tsconfig, ...) and root-level Markdown docs
  (`README.md`, `SPECS.md`, `CHANGELOG.md`, ...). Dot paths (`.git`, `.github/workflows`,
  `.env`, `.matrix`) stay denied whatever the list says. Change it with
  `PATCH /v1/projects/{id}` and `{"repo": {"editablePaths": [...]}}`.
- **Dependency setup**: run worktrees start without `node_modules`, so before checks (and, best
  effort, before implement) Matrix installs dependencies in the sandbox. `repo.setup` lists the
  steps (argv, no shell, `cwd` relative to the repo), for example
  `[{"cwd": "app", "run": ["npm", "ci", "--no-audit", "--no-fund", "--ignore-scripts"]}]`.
  Unset, Matrix detects one frozen install per directory that has a `package.json` and a
  lockfile: the root plus every directory a check runs in (`npm --prefix app`, `pnpm -C app`,
  `yarn --cwd app`): `package-lock.json` → `npm ci`, `pnpm-lock.yaml` →
  `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --frozen-lockfile`, `bun.lock` →
  `bun install --frozen-lockfile`. `[]` disables setup; `null` (PATCH) resets to detection.
  - *Network*: setup runs with the sandbox `allowlist` policy: an HTTPS CONNECT proxy on the host
    (the credential broker's `egress.sock`) only tunnels to `registry.npmjs.org`,
    `registry.yarnpkg.com` and `repo.yarnpkg.com` on port 443, private addresses refused. Git or
    tarball dependencies hosted elsewhere fail: vendor them. Checks themselves keep `network: none`.
  - *Lifecycle scripts*: detected installs pass `--ignore-scripts`. `npm ci` would otherwise run
    every dependency's `preinstall`/`postinstall` plus the repo's own `prepare` with registry
    egress and the run's gateway token: a compromised package or an agent-edited lockfile could
    exfiltrate through the gateway or poison the cache. The cost: packages that build native code
    or download binaries in `postinstall`, and `patch-package`, do not run. Opt in per project with
    `repo.setupScripts: true`, or list explicit steps (they run exactly as given), e.g. an
    `--ignore-scripts` install followed by `["npx", "--no-install", "patch-package"]`.
  - *Cache*: a successful install is copied to `$MATRIX_DATA_DIR/deps-cache/<project>/<key>`,
    keyed by project, `cwd`, argv and the exact `package.json`, lockfile and package-manager
    config bytes (`.npmrc`, `.yarnrc.yml`, `pnpm-workspace.yaml`, ...; the 3 most recently used
    per project are kept). Only installs done before checks, on the cleaned committed tree, are
    stored; the best-effort install before implement may restore but never writes the cache. Later runs copy it into the worktree (`cp -a`, reflinks where supported)
    instead of reinstalling; the cache is never mounted into a sandbox, so a run cannot alter it.
  - *Never committed*: untracked `node_modules` are disposable: excluded from the commit gate and
    the handover fingerprint, and wiped right before checks so nothing an agent planted there
    survives; setup then reinstalls from the committed lockfile.
  - *Failures*: a failed setup, or a check that clearly could not run (exit 126/127, a shell
    `not found` line, `spawn X ENOENT`, a missing `node_modules/.bin` entry), is an
    **environment** failure: the
    ticket blocks for a human (needs-human, reason in the status comment) without going back to
    implement and without consuming implement attempts.
- **Matrix artifacts stay host-side**: the derived code graph is written to
  `$MATRIX_DATA_DIR/projects/<id>/graph/`, never committed; the publisher refuses to push a run
  branch that touches `.matrix/` or `.github/workflows/`.
- **Models**: per phase (`spike`, `design`, `implement`, `review`, `qa`, plus
  `reviewerFallbacks`). Review must use a different model than implement. When the gateway
  answers `GET /v1/models`, unknown ids are rejected: use gateway ids (for example
  `claude-opus-4-7` for Opus 5.5, `claude-sonnet-5-5`, `gpt-6-sol`). Setting `implement` or `spike` drops the
  size tiers.
- **Later changes**: `PATCH /v1/projects/{id}` with any of `repo.editablePaths`, `repo.setup`,
  `repo.setupScripts`, `tickets`,
  `checks`, `models`.

### How a run ends

After checks, review and QA pass, and before the merge approval is requested, the server
(host-side, never in a sandbox) pushes exactly the QA-validated commit to
`matrix-<ticket>-<slug>` on `https://github.com/<owner>/<repo>.git`, then opens a **draft** PR
with `gh pr create --draft`. The PR body has the summary, evidence links, `Linear: NEO-n` and a
Matrix footer. Ticket text is treated as untrusted: hidden characters stripped, `@` mentions,
`#n` refs, links, images and closing keywords neutralized. The PR link goes into the live Linear
status comment and the issue sits in **Awaiting merge**. PRs are recorded in
`$MATRIX_DATA_DIR/pull-requests.json`.

Matrix never merges, never force-pushes and never pushes the base branch. Merge the PR on
GitHub, then approve the merge in Matrix: the merge phase only checks that the PR was merged at
the validated head and finishes the ticket (approving earlier just waits again). A PR merged with
extra commits blocks the ticket for a human. Retries reuse the open PR for the branch; a diverged
branch or an already merged/closed PR moves to `matrix-<ticket>-<slug>-2`, and so on. Pushes are
refused when the repo config has `url.*.insteadOf` rewrites, and the secret gate scans the pushed
range first. Push or `gh` failures never fail the workflow: they show up under
`/v1/projects/{id}/tracker/failures` and are retried every 5 minutes.
