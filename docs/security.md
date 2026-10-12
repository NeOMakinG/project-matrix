# Security model (development preview)

Do not deploy Matrix as an autonomous production factory yet. Integration PR #27,
dashboard-init PR #26 and stack-packs PR #24 are open and await actual QA. The
executable server currently uses MemoryCore/in-memory keys. This document describes
committed defenses and known limits, not a penetration-test attestation.

## Assets, adversaries and boundaries

Protect host/admin/gateway credentials, repository history, host files/devices,
database/receipt integrity, deployment authority and local network services.
Assume a malicious repository, dependency hook, prompt-injected agent/tool result,
compromised worker, forged webhook and unauthorized remote client. The host operator,
reviewed toolchain, kernel/container runtime and credential broker are trusted
computing base; untrusted project code must not control them.

Separate: local client ↔ control plane; authenticated control plane ↔ project scope;
host broker ↔ sandbox run token; runner filesystem ↔ host files; network allowlist
↔ private/internal endpoints; artifact producer ↔ receipt validator. Review any
exception to these boundaries explicitly. An agent's self-reported success is not
a receipt or authorization.

## Committed controls and limits

- REST/MCP share scope/action/budget/rate-limit checks. Worker keys should be per
  project and least privilege, normally `read`/`tickets:write`; never admin by default.
  Key hashes are held by the server, but agent MCP configs/backups contain raw keys.
  Protect files (0600), backups and logs. Revocation is distinct from logout.
- Browser login accepts human keys; cookies are HttpOnly/Strict/Secure by default.
  Cookie writes require CSRF and origin checks. TLS, ingress firewall and operator
  origin configuration remain required; Tailscale routing is not application auth.
- Orca hook signing covers exact raw-body bytes with timestamp/nonce and HMAC-SHA256
  (`sha256=<hex>`), with replay protection. Persistent replay data needs protected
  storage. Hook scripts can observe process events and must themselves be reviewed.
- Podman argv uses `--network=none`, keep-id, dropped capabilities and
  no-new-privileges, plus configured limits. The broker's Unix socket bridge restores
  only reviewed LLM/egress routes. Rootless networking **does not alone prevent all
  host-resource access**: mounts, runtime sockets, files, kernel bugs and excess
  privileges are independent boundaries. Never mount host home, DB volumes, real
  keys, container-control sockets or sensitive devices in a runner.
- Host broker substitutes upstream auth for revocable run tokens and strips
  caller authorization. Egress allowlists restrict destination names/ports and
  reject private addresses by default. Keep `allowPrivate` off unless separately
  justified. Audit DNS rebinding, redirects, TOCTOU and revocation/in-flight races;
  an allowlist is not proof that every dependency or upstream payload is safe.
- bwrap is a fallback with namespaces/read-only system binds, not a promise of
  Podman-equivalent cgroup limits or kernel hardening. Rootless operation still
  depends on administrator-configured subordinate IDs, namespace policy, LSM and
  resource limits. Do not weaken global host policy or grant privileged containers
  just to make a failing diagnostic green. macOS/Windows/WSL bridges require QA.
- Root-bound/no-follow filesystem helpers and worktree checks reduce symlink/path
  escape risks; mutable parents, rename races, concurrent agent edits and platform
  differences remain review targets. A receipt hash protects bytes, not truthful
  provenance. Holdout tests and merge/deploy decisions need trusted validation.
- gitleaks must be present for the reviewed publish secret gate; absence blocks
  publishing. Doctor detecting its version is **not** a secret scan. Recheck staged
  and generated artifacts before publication; redact test/receipt/log output too.
  The sandbox secret-gate API has an explicit `skipGitleaks` opt-out: do not allow
  it for publication. Doctor's `publishBlocked` flag does not enforce every caller's
  policy or repair that downstream escape hatch.

## Known issue register: #13–#22

Coordinator-provided issue mappings (not closure or severity claims):

| Issue | Review area |
| --- | --- |
| #13 | Hardlinks |
| #14 | Parent swap |
| #15 | Redirect headers |
| #16 | Rollout weight |
| #17 | Dotted aliases |
| #18 | tsconfig extends |
| #19 | Partial replay |
| #20 | MCP OAuth |
| #21 | Gateway health probe |
| #22 | SSE previewer |

Treat the entire register as a deployment review gate, not as closed by these docs
or doctor tests. The coordinator must attach reviewed reproductions, patches and
adversarial regression evidence before claiming resolution.

Separately visible implementation gaps: MemoryCore and key/session state do not
survive restart; audit/replay files are not a durable recovery mechanism; live
sandbox/gateway/Orca and deploy verification have not been proven by unit fixtures.
Do not allow an API-triggered operation or green dashboard to imply a tested
production integration.

## Safe diagnostics and incident response

Doctor executes fixed trusted tool probes outside the project cwd, no shell or
project lifecycle hooks. Inherited PATH is **never** an approval source, including
absolute directories outside the project. Unix defaults are canonical, nonsymlink
`/usr/bin` and `/bin`; Windows has no default tools directories. Operators can
explicitly add canonical install directories with repeatable `--trusted-tools-dir`,
never through project config or environment. Entry paths and realpaths must agree,
directories/binaries cannot be symlinks or group/world-writable, and project-root
paths are rejected. Only the running Bun executable can establish implicit runtime
trust, subject to those file/path checks; its siblings are not approved. Child PATH
contains only validated approved directories. Approval assumes the host operator
protects these install trees from project writes; it is not a remedy for #13/#14
or compromised host installs. A tool that cannot be safely resolved fails closed. The
bwrap check runs only `/usr/bin/true` in a fresh namespace. No container/image pull,
configuration change, secret mutation, SQL authentication or inference is performed.
Process/network output is capped, checks have deadlines, external errors are
withheld rather than echoed, and models/auth/URLs are not printed. Configure only
operator-reviewed local gateway read-only health routes, not arbitrary HTTP actions.
No public paid API fallback exists. Tests use process/network fixtures, not quota.

On suspected compromise: **operator on the host/control-plane client** stops run
admission, revokes affected `/v1/keys/{id}` and broker grants, isolates worker
containers/worktrees, rotates upstream credentials through the secure secret
manager, and preserves redacted receipts/audit/replay evidence. Do not paste raw
keys into shell commands or public bug reports. Restart is not a substitute for
durable revocation; ensure no bootstrap or old config backup restores compromised
authority. Test clean-room recovery before reopening merge/deploy.

References: root `LICENSE` (Apache-2.0), `packages/sandbox/src/{podman,bwrap,broker,
secret-gate,safe-fs}.ts`, `packages/safe-fs/src`, `packages/qa/src/receipts.ts`,
`apps/server/src/auth`, `apps/server/src/http/routes-session.ts`, and
`packages/cli/src/orca/sign.ts`. Only committed repository sources are relied on;
no unverified third-party licensing or external security claims are reproduced.
