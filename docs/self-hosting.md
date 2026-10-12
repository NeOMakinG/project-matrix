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
