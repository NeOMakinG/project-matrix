# Orca integration

Orca is optional. Matrix's committed CLI implements **hook file planning and MCP
registration**, not a completed production workspace loop. See ADR 0006 for intent;
integration PR #27 still awaits actual runtime QA. These steps require operator
review and are not performed by `matrix doctor`.

## Host runtime and local pairing

**Linux host operator:** inspect the cached `ops/bosgame/orca-serve.service` and
`orca-serve.md` for the reviewed CLI shape; do not copy their machine-specific
account/host values. Check your installed Orca help/version before applying.
Create a dedicated unprivileged runtime account, private project root and a
protected service environment. Use a generic environment name such as
`matrix-host`, not a real account/host identity in public instructions.

The committed unit's invocation is `orca serve --port <port> --pairing-address
<operator-selected-address> --project-root <absolute-project-root>`. There is no
documented bind-address flag in that reviewed setup: it listens on all interfaces.
**Before starting on the host**, have the administrator restrict the runtime port
to the intended tailnet interface and trusted peers. Pairing address is advertised
routing, not an access-control rule. systemd IP filtering is defense in depth only
where the user manager actually enforces it; validate the listening socket and
firewall from an untrusted network. Do not expose pairing on the public Internet.

Review an adapted user unit with private paths and environment, then install/start
it using host `systemctl --user`; do not run these host changes from a runner
container. Read the one-time pairing code privately from the host service journal.
Never paste the code into this repo, issue tracker, logs shared for QA, or shell
history. On your **local Orca client machine**, the reviewed CLI shape is:

```text
orca environment add --name matrix-host --pairing-code <one-time-code>
orca environment list
```

The first line is a **syntax reference, not a paste-ready command**: it places the
code in process arguments and history if entered literally. Use Orca's secure
pairing UI/prompt if available in the installed version. The cached material does
not establish an env-file/stdin pairing-code flag; do not invent one. If CLI-only
pairing is necessary, coordinate a private, history-disabled operator session and
review process-argument exposure before proceeding. Verify the paired environment
and peer identity before granting any project access.

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

## MCP: a separate scoped key per agent

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

## Remove and verify

**Agent machine:** inspect `orca hooks uninstall` dry run, then `--apply` to remove
only Matrix-owned files. Manually remove Matrix's agent hook references. Revoke
MCP keys through `DELETE /v1/keys/{id}` before removing the MCP entries and protected
backups. **Host:** stop the reviewed Orca user service if retiring it. **Local
client:** the cached removal shape is `orca environment rm --environment matrix-host`;
verify installed CLI help before apply. Validate revoked access, removed hook
references and closed ports. Pairing/hooks/MCP success does not certify sandbox or
full factory readiness.
