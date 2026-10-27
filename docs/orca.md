# Orca integration

Orca is optional. The native factory loop is proven; the Orca runtime (below) is the
preferred way to watch agents. The CLI provides **hook file planning and project-scoped MCP registration**
for Claude Code, Codex and OpenCode on each of your machines. Orca-managed
workspaces remain an optional runtime choice; native-loop validation does not
certify every Orca installation. These steps require operator review and are not
performed by `matrix doctor`.

## Orca runtime (`MATRIX_RUNTIME=orca`)

With `MATRIX_RUNTIME=orca` every agent session Matrix starts runs in an Orca terminal, so you
can watch (and stop) it from Orca desktop or mobile. Linear stays the place for tasks, context
and outputs; Matrix keeps the gates (independent review model, holdout QA, merge gate).
`native` stays the default and the fallback.

Per ticket: one Orca worktree (`worktree create --no-parent --setup skip --linear-issue NEO-n`),
one parked bash coordinator terminal titled `matrix:NEO-n · <project>`, bound to one
orchestration Run with the same name. Per runner call (spike, implement, review, QA judge):
one orchestration task and one bash terminal titled `<phase> · <model>`, dispatched without
`--inject`. Matrix sends `bash '<script>'; exit` to that terminal.

The script lives in `$MATRIX_DATA_DIR/orca-scripts/` (0700 dir, 0600 file, deleted on exit).
It runs the **same rootless Podman command** as the native runtime: same image, read-only
mounts for review/QA, per-run broker token. The gateway key never reaches Orca, the script,
terminal history or argv. The prompt (untrusted ticket text) is fed from a 0600 stdin file and
is never interpolated into shell text; every other value is single-quoted. The script writes its
exit code to a file, sends `worker_done` itself and deletes itself.

Matrix drains the coordinator mailbox with `orchestration check --wait`, acks every Delivery
(unacked ones replay), answers worker `question`s with a fixed "unattended" reply, and treats the
exit file as completion when a message is lost. A phase that outlives its timeout is
interrupted and its container removed. Before a worktree is archived or a new one prepared,
Matrix stops any container still labelled with that ticket. `orchestration worker-read --source terminal` is stored
as a 0600 evidence file and a `log` receipt with `data.orca = {run, dispatch, task, terminal}`.
The Linear status comment shows `Orca: Run <id> · dispatch <id>`.

Cleanup: `orca worktree rm --force` deletes the branch, so Matrix first pins the worktree head
at `refs/matrix/archive/<branch>-<sha12>` in the canonical repo; without that ref it refuses to
remove. Orca sanitizes `/` in names, so the branch is `matrix-NEO-n`, not `matrix/NEO-n`; with
Orca's `branchPrefix: git-username` setting it becomes `<git-user>/matrix-NEO-n`. Matrix
records the branch Orca returns (host-side, per worktree) and its commit gate accepts exactly
that recorded name; the pushed PR branch stays `matrix-NEO-n-<slug>`. Each ticket keeps one
Orca Run: its id is kept in `<dataDir>/orca-runs.json`, and a retry or a server restart binds a
new coordinator to it with `orchestration run-use` (a new Run only when Orca no longer knows it).
Tasks are created with `--spec` (required since Orca 1.4); the spec carries only the phase label. Matrix never calls `orchestration reset` (it is global).

Configuration (server environment):

| Variable | Meaning |
| --- | --- |
| `MATRIX_RUNTIME=orca` | Use Orca worktrees/terminals; needs the same gateway/image settings as `native`. |
| `MATRIX_ORCA_BINARY` | Absolute Orca IDE CLI. Default `/opt/Orca/resources/bin/orca-ide`. Never rely on `orca` from `PATH`: on Linux `/usr/bin/orca` is often the GNOME screen reader. |
| `MATRIX_ORCA_ENVIRONMENT` | Not supported with `MATRIX_RUNTIME=orca` (startup fails): runner scripts and the sandbox env-file are host-local, so Matrix must run on the Orca host. |

Each repository must be registered once (`orca repo add --path <repo>`). Matrix must run as the
same user as the Orca runtime: the CLI authenticates with `~/.config/orca/orca-runtime.json`
(0600) and the local unix socket.

## Host runtime and pairing

The live runtime on a Linux host is the full Electron app in serve mode, started by the Orca
CLI (`orca-ide --serve --serve-port <port> --serve-pairing-address <tailnet-ip>
--serve-mobile-pairing`) under Xvfb, not the older `ops/bosgame/orca-serve.service` /
port 7420 setup (kept only as history). The websocket listens on **all interfaces**: restrict
its port to `tailscale0` before relying on it, for example:

```sh
sudo ufw allow in on tailscale0 to any port <port> proto tcp
sudo ufw deny <port>/tcp
ss -ltnp | grep <port>
```

Pairing address is advertised routing, not access control. Pair clients with Orca's pairing
UI; never paste a pairing code into this repo, issue trackers or shell history. Anyone holding
the runtime token can act as any terminal handle, so the trust boundary is the runtime's Unix
user.

## Hooks: dry run before apply

Run **on the machine/home where the agent actually runs**, from the trusted checkout:

```sh
bun packages/cli/src/bin.ts orca hooks install --server http://127.0.0.1:8740
```

Review the exact proposed files/config changes. The default owned directory is
`~/.matrix/orca` (or `--dir <absolute-path>`). The helper does **not** alter agent
hook configurations. Apply only after you obtain a shared secret through a secure
prompt/editor and store it as a private 0600 file, matching the host server's
`MATRIX_ORCA_SECRET` (at least 16 characters):

```sh
bun packages/cli/src/bin.ts orca hooks install --server http://127.0.0.1:8740 --secret-file "$HOME/.config/matrix/orca-hook-secret" --apply
```

This writes `matrix-orca-hook.mjs` and a 0600 `hook.env` under the owned directory.
Alternatively use `MATRIX_ORCA_HOOK_SECRET` from a protected env-file; the generated
hook environment uses **`MATRIX_ORCA_SECRET`**, matching server verification.
Hooks execute Node, so review the installed script and supply a trusted Node
runtime. The hook receives event metadata; do not forward prompts or secrets.

For a **SOL/Codex-only setup**, apply only the printed Codex `notify` configuration
in the actual agent runtime's `config.toml`. The helper also prints Claude/OpenCode
examples; no Claude call occurs unless an operator separately enables/runs it.
Preserve Orca-managed entries. Code review is required before changing notifications
or adding a second handler: do not replace unrelated hooks blindly.

The script posts to **`POST /hooks/orca`**, not `/v1/hooks/orca`. Signing from
`packages/cli/src/orca/sign.ts` is HMAC-SHA256 over the exact bytes of
`<unix-seconds>.<nonce>.<raw-json-body>`, hex digest prefixed with `sha256=`.
Headers: `x-orca-timestamp`, `x-orca-nonce`, `x-orca-signature`. Nonce is 16–128
URL-safe characters. The receiver rejects stale/replayed signatures. Ordinary
Bearer keys do not replace webhook signing. Do not create hand-written signed
payload examples containing real secrets.

## MCP: a separate scoped key per agent and project

**On the agent machine**, first run the Codex-only plan:

```sh
bun packages/cli/src/bin.ts orca register-mcp --server http://127.0.0.1:8740 --project example-project --agents codex --actions read
```

Only after reviewing the plan, put `MATRIX_ADMIN_KEY` in a protected client env-file
and repeat with `--apply`:

```sh
bun --env-file="$HOME/.config/matrix/client.env" packages/cli/src/bin.ts orca register-mcp --server http://127.0.0.1:8740 --project example-project --agents codex --actions read --apply
```

Replace the example project with your actual project ID. `--home <dir>` selects
the agent runtime home when Orca uses an isolated copy. HTTPS is preferred; HTTP
is accepted for loopback, or reviewed Tailscale destinations only with explicit
`--allow-tailnet-http`. That switch does not secure an unrelated public route.
This edits MCP configuration, unlike the hook helper. See [MCP](mcp.md) for scopes,
credential backups, revocation and partial-failure cleanup. Never grant worker admin
or perform an inference/run as a connectivity probe.

Register more projects without losing access to earlier ones: repeat `--project`
or pass a comma-separated list, for example `--project travel-journal,example-project`.
IDs must start with a letter or digit and contain only letters, digits, `_` or `-`.
Each project gets `matrix-<projectId>` and one project-scoped key per selected
agent. Re-registering rotates only that project's entry and revokes its previous
key after writing the new config. Other projects and other machines' credentials
are untouched. Run registration separately on every agent machine; do not copy
tokens between machines. Legacy unqualified `matrix` entries are preserved;
explicitly revoke their keys and remove them after migration.

The init interview now asks for a model plan: Opus 5.5 for large/default work,
Sonnet 5.5 for small spike/implementation work, and Codex `gpt-6-sol` for independent
review. See [model routing](models.md) for gateway aliases and the inference-free
`matrix models check --gateway <url>` check.

## Remove and verify

**Agent machine:** inspect `orca hooks uninstall` dry run, then `--apply` to remove
only Matrix-owned files. Manually remove Matrix's agent hook references. Revoke
MCP keys through `DELETE /v1/keys/{id}` before removing the MCP entries and protected
backups. **Host:** stop the reviewed Orca user service if retiring it. **Local
client:** the cached removal shape is `orca environment rm --environment matrix-host`;
verify installed CLI help before apply. Validate revoked access, removed hook
references and closed ports. Pairing/hooks/MCP success does not certify sandbox or
full factory readiness.
