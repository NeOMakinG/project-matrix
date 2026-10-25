# Agent QA lane (Android device QA by a QA agent)

Status: spike 2026-10-25, implemented in the same PR.

Operator quick start: set the project's `qa` to `{"surfaces":["android"],"driver":"agent"}`, write
the lane config below, start the server with `MATRIX_QA_LANE_CONFIG=/path/lane.json`. The Matrix
host needs key-based SSH to the device host; the device host needs `adb`, `agent-device`,
`claude`, `gh` (logged in), `secrets` (Infisical) and the Android SDK.

## Problem

A ticket whose QA surface is a device (Android today) cannot be verified by Matrix's host
probes. `packages/qa/src/mobile.ts` only had a `NotImplementedMobileDriver`, so
`manualQaPlan` returns `manual` (opt-in) or `unavailable`, and the ticket stops at Awaiting merge
with `needs-human` and a checklist (`docs/qa/manual-qa-handoff.md`). NEO-7 and NEO-8 (Travel
Journal, wayline PRs #3511 / #3512) sit there today.

Goal: a QA agent tests the draft PR the way a human tester would, and its verdict drives the
ticket: PASS continues, FAIL loops back to implement with the report, BLOCKED asks a human.

## Decisions

### 1. Where it plugs in: after the draft PR, not inside the QA phase

The QA phase runs before Matrix publishes anything, inside the run worktree. A device build of a
React Native app needs the device host (Android SDK, Gradle, the phone/emulator), not the
sandbox. The manual handoff already produces exactly what a tester needs: a pushed branch, a
draft PR, a checklist from the public acceptance criteria. So:

- New trusted project setting `qa.driver: "agent"`. The QA phase records the same core-produced
  handoff receipt as `manual` (provenance `matrix:manual-qa:v1`, plus `mode: "agent"`). Holdout
  scenarios stay hidden; the holdout judge does not run (unchanged from manual).
- The reconciler publishes the draft PR as today, then hands the PR to an `AgentQaPort` instead of
  announcing a human handoff. One job per (ticket, published head SHA).
- The merge approval stays pending in every outcome: merge is always human for device QA (also for
  PASS; `authorize` already forces it for handoffs).

### 2. Verdict handling (core, `packages/core/src/agent-qa.ts` + reconciler)

| Verdict | Ticket | GitHub PR | Workflow |
| --- | --- | --- | --- |
| PASS | report comment, `qa:passed` (removes `qa:failed`, `needs-human`) | `qa:passed` | stays at Awaiting merge, human merges |
| FAIL | report comment, `qa:failed` | `qa:failed` | `reject()` → loops back to implement (column Implement), report reaches the implementer as a ticket comment; counted against `maxLoops`; exhausted → blocked + `needs-human` (existing block effect) |
| BLOCKED | report comment with the reason, `needs-human` | none | stays at Awaiting merge; removing `needs-human` re-runs agent QA on the same head |

Rules: a report that is missing, unparseable, claims PASS with fewer checked acceptance steps than
the ticket has criteria, or claims PASS while listing a P1/P2 finding or a failed step is never a
pass (invalid → BLOCKED, inconsistent PASS → FAIL). Every
lane error (busy beyond the wait, host overloaded, device missing, build failed, agent timeout)
is BLOCKED with that reason. There is no silent pass.

Idempotency across restarts: every report comment starts with
`Matrix agent QA <VERDICT> for <sha>`. Before running, the reconciler reads the ticket comments:
an existing PASS/FAIL report for this head is never re-run; a BLOCKED one is re-run only once the
human removed `needs-human`.

### 3. The lane (`apps/server/src/integration/agent-qa-lane.ts`)

Runs on the Matrix host and drives the **device host** (miniforum, `root@100.90.255.43` over
Tailscale) over SSH. All values sent to the remote shell are validated (hex SHA, numeric PR,
`owner/name` repo, safe ids) and passed as quoted arguments to one committed script,
`ops/qa-lane/agent-qa.sh`, streamed over `ssh host bash -s --`.

Steps, each failure → BLOCKED with a short reason:

1. **Single tenant.** An in-process queue runs one job at a time; the remote script publishes a
   fully initialized lock directory with one atomic rename (`/tmp/matrix-qa-lane.lock`, owner +
   heartbeat). Every step of the holder refreshes the heartbeat; a lock is stale only after 2 h
   without one (every remote step is capped below that with `timeout`). A lock
   held by someone else (qaexplorer, a human) is waited on for up to `waitMs` (default 20 min),
   then BLOCKED `device lane busy`.
2. **Host precheck.** `load1 / nproc < 0.8` and `MemAvailable >= 6 GB`, else BLOCKED
   `device host overloaded`. The device (`adb -s <serial>`) must be `device`; with
   `bootEmulator` set the script boots the AVD once (`/root/boot-emulator.sh`) and waits for
   `sys.boot_completed`, else BLOCKED `device unavailable`.
3. **Build the PR head.** A cached clone per repo under `/srv/matrix-qa/repos/<owner>__<name>`,
   `git fetch origin pull/<n>/head`, `git checkout --detach <sha>` (the exact SHA Matrix
   validated, refused if the PR head moved). Then the project's build command from the lane
   config (operator-trusted, e.g. wayline: `npm ci` + `expo prebuild` + `gradlew assembleRelease`,
   the proven path from `/root/wayline-android/build-main.sh`). The build is a release APK
   (no Metro on the device host; the "Expo dev build" path needs a running bundler per job and
   is left out). Build log tail goes into the BLOCKED reason (redacted).
4. **Install + launch** with `adb install -r`, cold launch, first screenshot (`screencap`),
   device model / Android version / app version collected for the report.
5. **QA agent.** `claude -p` on the device host, cwd = an empty job dir, prompt = the
   `qa-tester-manual` skill + ticket (title, body, comments: untrusted data) + PR body checklist +
   acceptance criteria + diff stat. Tools are restricted to `agent-device`, `adb` and file
   read/write inside the job dir. It writes `report.json` and screenshots under `shots/`.
   Timeout 25 min.
6. **Collect.** `scp` the job's `report.json` and up to 12 screenshots (PNG, ≤ 3 MB each) back to
   the Matrix host; the core validates the report (zod) and uploads screenshots as Linear
   attachments embedded in the comment.

Reuse from qaexplorer (`/opt/qaexplorer`): the emulator boot script, the
`uiautomator dump` retry rule (per-process dump file, retry until it contains `<node`) used by
`AdbMobileDriver.uiTree`, the cold-start wait, and the false-crash double check
(`pidof` twice + `ps`). qaexplorer itself is an explorer, not a ticket tester; the lane calls
`agent-device` (installed on miniforum, has a `manual-qa` workflow) instead.

Device choice: the lane config names the serial. The miniforum phone (`SM02E4072815934`, arm64)
is the default device in the global rules; the `qa` AVD is x86_64 and needs an
`x86_64` build. Both are supported via `abi` in the lane config.

### 4. Mobile driver (`packages/qa/src/mobile.ts`)

`NotImplementedMobileDriver` is replaced for Android by `AdbMobileDriver`, which implements the
fixed `MobileDriver` interface over a `CommandRunner` (local `adb` or `ssh host adb`): install,
launch (`monkey -p <id> 1` + wait for `topResumedActivity`), tap (text/resource-id resolved from
the UI tree, or x/y), type, screenshot (sha256 receipt), screenrecord, uiTree. iOS keeps a
not-implemented driver. The lane uses it for install/launch/first screenshot; the agent drives
the rest through `agent-device`.

### 5. QA tester manual skill (`skills/qa-tester-manual/SKILL.md`)

What a human tester does, written for the agent: read the ticket and acceptance criteria, read
the PR checklist and changed files, plan; run every acceptance criterion as a scripted check;
exploratory checks around the change (empty/long input, back/rotate/background, offline,
permission denied, repeat taps); regression checks on neighbouring flows; evidence rules (a
screenshot per checked step, exact steps, expected vs actual, device + build); severity scale
(P1 blocks the feature / crash / data loss, P2 acceptance criterion not met or major
degradation, P3 minor/cosmetic); verdict rule (PASS only when every criterion passed and no
P1/P2; FAIL otherwise; BLOCKED when the app cannot be tested); report schema.

### 6. Linear report

```
Matrix agent QA FAIL for 1a2b3c4 (draft PR #3511)
Device: SM-xxx, Android 15 · Build: com.wayline 1.5.2 (release, arm64-v8a) · 14 min
Summary: ...
### Steps
1. ✅/❌ action — expected / actual — ![](shot)
### Findings
- P1 title — steps, expected, actual, screenshot
```

Attachments use Linear's `fileUpload` (signed PUT) and are embedded as images; when upload is
not supported by the tracker the comment lists the screenshot names only.

### 7. Configuration (host-level, trusted)

- Project: `PATCH /v1/projects/<id>` `{"qa":{"surfaces":["android"],"driver":"agent"}}`.
- Lane: `MATRIX_QA_LANE_CONFIG=/path/lane.json`:

```json
{
  "host": "root@100.90.255.43",
  "serial": "SM02E4072815934",
  "bootEmulator": false,
  "model": "claude-sonnet-5-5",
  "projects": {
    "<project-id>": {
      "repo": "NeOMakinG/wayline",
      "build": "cd app && npm ci --no-audit --no-fund && npx expo prebuild --platform android --no-install --clean && cd android && ./gradlew assembleRelease -PreactNativeArchitectures=$ABI --no-daemon",
      "apk": "app/android/app/build/outputs/apk/release/app-release.apk",
      "appId": "com.wayline.app",
      "abi": "arm64-v8a"
    }
  }
}
```

No credential lives in the config: GitHub (`gh`) is logged in on the device host, and the QA agent
reaches the model gateway (CLIProxyAPI `127.0.0.1:8317` on the device host) with
`secrets run -- …` (Infisical), mapping `CLIPROXY_API_KEY` to `ANTHROPIC_AUTH_TOKEN` inside the
child process only. Linear stays on the Matrix host.

## Security

- **Root never touches QA-owned paths.** Root runs git only in a root-owned bare mirror
  (`/srv/matrix-qa/mirrors`); the job dir and its prompt/settings are root-owned; only `out/`
  belongs to `matrixqa`, and the APK and report are copied out *as* `matrixqa`, so a planted
  symlink reaches nothing root-only.
- **Unprivileged build and agent.** Root only fetches (with its `gh` credential, never stored in the
  checkout) and resolves the gateway key. The build (`npm`/Gradle scripts are PR code) and the QA
  agent run as two different users, `matrixqa-build` and `matrixqa` (homes 0700), with cleared
  environments: neither reads root's files, Infisical or `gh`, and the build cannot reach the
  agent's home, key or `out/`. Every process of each user is killed after its step, so nothing a
  build starts survives into the agent's run. The agent's environment holds the gateway key only.
- Residual risk, accepted: the agent's `adb` access runs arbitrary shell commands on the **test
  device** (a dedicated QA phone/emulator), and PR code shares the `matrixqa-build` home (npm/Gradle caches) across jobs.
- Remote steps end on their own (`timeout` on the device host) before the Matrix side gives up, so
  the lock is not released under a still-running build.

- Ticket text is untrusted: it reaches the QA agent only as quoted data, the agent's tools are an
  allowlist (`agent-device`, `adb`, job-dir files), and the agent never sees the Linear or GitHub
  credential. Its report is parsed and length-bounded; screenshots must be PNG by magic bytes.
- Build commands come only from the operator's lane config, never from the repo or ticket.
- The remote script receives validated arguments only.

## Out of scope

iOS (tapflow on the Mac mini; an iOS surface is BLOCKED, never passed), Metro/dev-client builds,
video upload, auto-merge on PASS.
