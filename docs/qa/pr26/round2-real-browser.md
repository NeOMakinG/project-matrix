# PR #26 round 2: real browser against a real server

Date: 2026-10-13. Host: miniforum (isolated `/opt/matrix-qa-pr26`, Tailscale-only bind, port 8761).
Server: this branch merged with `feat/integration`, `MATRIX_RUNTIME=fake`, in-memory store, throwaway
state directory, single-use bootstrap key. Tracker: beads `bd` 1.3.1 (release SHA-256 verified).
Browser: Playwright Chromium from a separate machine over plain HTTP.

Result: `e2e-real/init-flow.spec.ts` passed in 9.5 s — sign in, create project, interview rounds,
contradiction and recovery, answer edits, autonomy step, generate project, board with the generated
backlog rendered in beads (6 tickets).

Bugs found by this run and fixed before it passed:

| Bug | Fix |
|---|---|
| `crypto.randomUUID` missing on plain-HTTP origins; project creation failed | `getRandomValues` idempotency keys |
| Replay log and webhook secrets defaulted to `$HOME/.matrix`; custom data dir crashed startup | Defaults under `MATRIX_DATA_DIR` |
| Missing `bd` returned an opaque 500 and left a partial repo | Typed 503 with remediation, fenced cleanup, doctor check |
| Run and overview views awaited `bd` for titles; endpoints froze after finalize | Local ticket snapshot with bounded background sync |
| 182 `bd` calls for 6 tickets (N+1 `show`, embedded-Dolt contention); finalize timed out | Per-repo queue, no redundant `show`, dispatch gated on finalize — 18 calls |
| Board assertion passed on a loading skeleton | Test requires rendered columns |

Post-run: `/v1/overview` and `/v1/runs` answer in about 1 ms. Not covered here: Postgres restart
persistence and native agent execution (tracked on PR #27).
