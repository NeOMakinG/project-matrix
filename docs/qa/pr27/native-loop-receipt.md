# PR #27: native factory loop receipt

Date: 2026-10-13. Host: bosgame (isolated `~/Projects/matrix-qa`), rootless Podman runner image
`localhost/matrix-runner:sol-qa-20261012` (Bun 1.3.9 publisher SHA-256 verified, Codex 0.162.1),
local CLIProxyAPI gateway only (no paid provider). Harness: `ops/bosgame/native-qa.sh` on a
harmless fixture (`add(left, right)` returning 0), memory store, merge and deploy ports disabled.

Result (`tiny-ticket-aA4BCB`): `ok: true`, workflow at `merge / waiting_approval`, base branch
unchanged, checks, review and QA bound to the same committed SHA `33ce69ce`.

| Phase | Model | Evidence |
|---|---|---|
| spike | gpt-6.1-sol | plan recorded on ticket |
| implement | gpt-6.1-sol | one-file edit; host-owned snapshot secret scan passed |
| checks | — | tests exit 0; ADR rules; code graph up to date (host-derived); history secret scan |
| review | gpt-6-sol (distinct) | correctness-security lane: 0 P1, 0 P2, 0 P3 |
| qa | gpt-6-sol | 5/5 holdout scenarios, each backed by a host-executed probe in a read-only, network-none snapshot |

Runtime defects found and fixed while reaching this result: missing worktree directory used as
Git CWD; broker duplicating `/v1`; stale alternate-index stat data refusing identical content;
derived code graph not regenerated host-side; tooling failures burning implement loops; holdout
judge receiving only one-line summaries.

Also verified separately: Postgres 17 integration suites (store, init policy, restart persistence
of keys, sessions, CSRF and monitor) — 25 passed against a throwaway container.
