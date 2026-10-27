# Agent QA lane (Android, iOS and web QA by a QA agent)

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

Rules: a ticket with no acceptance criteria (so an empty PR checklist) is BLOCKED `no acceptance
criteria` before the lane runs, and a PASS is never kept without criteria to check. A report that is missing, unparseable, claims PASS with fewer checked acceptance steps than
the ticket has criteria, or claims PASS while listing a P1/P2 finding or a failed step is never a
pass (invalid → BLOCKED, inconsistent PASS → FAIL). Every
lane error (busy beyond the wait, host overloaded, device missing, build failed, agent timeout)
is BLOCKED with that reason. There is no silent pass.

Labels: removals are written before additions (a failure midway never leaves `qa:passed` beside a
FAIL), and a failed label write is retried on every tick whatever the workflow's phase, until it
lands or a newer verdict for the ticket replaces it.

Handover: a ticket whose QA run handed off to a human before the project switched to
`driver: "agent"` goes through the lane once a human removes its `needs-human` label.

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
   then BLOCKED `device lane busy`. The lock also names its holder (`matrix-server@<host>` for the
   server); a restarted server reclaims a lock its dead predecessor still holds on startup (kills
   that job's steps and lane-user processes) instead of waiting out the 2 h stale limit. Locks of
   other holders are never reclaimed.
2. **Host precheck.** `load1 / nproc < 0.8` and `MemAvailable >= 6 GB`, else BLOCKED
   `device host overloaded`. The device (`adb -s <serial>`) must be `device`; with
   `bootEmulator` set the script boots the AVD once (`/root/boot-emulator.sh`) and waits for
   `sys.boot_completed`, else BLOCKED `device unavailable`.
3. **Build the PR head.** A cached clone per repo under `/srv/matrix-qa/repos/<owner>__<name>`,
   `git fetch origin pull/<n>/head`, `git checkout --detach <sha>`, `git clean -ffdx` (nothing,
`node_modules` included, carries over from an earlier checkout) (the exact SHA Matrix
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
      "build": "cd app && npm ci --no-audit --no-fund && node -e \"const fs=require('fs');const j=JSON.parse(fs.readFileSync('app.json'));j.expo.android.versionCode=Number(process.env.VERSION_CODE);fs.writeFileSync('app.json',JSON.stringify(j,null,2))\" && npx expo prebuild --platform android --no-install --clean && cd android && ./gradlew assembleRelease -PreactNativeArchitectures=$ABI --no-daemon",
      "apk": "app/android/app/build/outputs/apk/release/app-release.apk",
      "appId": "ai.traveljournal.app",
      "abi": "arm64-v8a"
    }
  }
}
```

The build runs with `ABI` and `VERSION_CODE` in its environment. `VERSION_CODE` (minutes since the
epoch) always exceeds earlier lane builds: use it as the Android `versionCode`, so each PR build
installs over the previous one keeping the app's data. The lane never uninstalls or wipes an app; a
newer build from elsewhere (a store or developer build) makes the install BLOCKED until a human
removes it.

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
- The agent's tools are `agent-device` (minus `install`) and a few read/drive-only `adb`
  subcommands (`logcat`, `shell input|svc|getprop|dumpsys|pm list`, `exec-out screencap`); no
  `adb push/pull/install`, so it cannot move host files to or from the device. The build user is
  kept off the adb server (`iptables -A OUTPUT -o lo -p tcp --dport 5037 -m owner --uid-owner
  matrixqa-build -j REJECT`, operator step, persist it with the host's firewall config).
- Residual risk, accepted: `agent-device`/`adb shell input` drive arbitrary UI on the **test
  device** (a dedicated QA phone/emulator), and PR code shares the `matrixqa-build` home (npm/Gradle caches) across jobs.
- Lock acquisition and stale reclamation run under `flock`; `unlock` kills every process of both
  lane users before releasing the lock.
- Deferred: an abort mid-step does not interrupt the remote step (it ends at its own hard
  timeout, at most 90 min); reconciler shutdown does not cancel a running lane job.
- Remote steps end on their own (`timeout` on the device host) before the Matrix side gives up, so
  the lock is not released under a still-running build.

- Ticket text is untrusted: it reaches the QA agent only as quoted data, the agent's tools are an
  allowlist (`agent-device`, `adb`, job-dir files), and the agent never sees the Linear or GitHub
  credential. Its report is parsed and length-bounded; screenshots must be PNG by magic bytes.
- Build commands come only from the operator's lane config, never from the repo or ticket.
- The remote script receives validated arguments only.

## Out of scope

Metro/dev-client builds, video upload, auto-merge on PASS.

## Surfaces: routing, Android pool, iOS, web (spike + implementation 2026-10-26)

Owner rule: QA is (almost) never a human. Android on the emulator or the Seeker, iOS on the
tapflow simulator, web in a dedicated Chrome. The human handoff is the last resort: a surface
whose every automated driver stays unavailable after retries is BLOCKED with that reason and
`needs-human` (the human tests it, or fixes the driver and removes `needs-human`).

### Routing (`packages/core/src/qa-surfaces.ts`)

Lane surfaces are `android`, `ios`, and `web` when `qa.driver` is `"agent"`. For a ticket:

1. Upper bound: the project's `qa.surfaces` (operator-trusted).
2. Declarations narrow: ticket labels (`ios`, `platform:android`, `surface:web`, `backend`) and the
   `QA: Surface:` body line. A declaration naming no configured surface is ignored (ticket text
   never escapes QA on its own).
3. The change narrows (host-computed diff from the review context): only `ios/`, `*.ios.tsx`,
   Podfile, Xcode files → ios; only `android/`, `*.android.ts`, Gradle → android; `*.web.tsx`,
   `web/`, `public/` → web; anything else UI-ish (`shared`) keeps every selected surface; a path
   for an unconfigured platform never removes a configured one.
4. **Backend-only**: when every changed path is backend/docs (`server/`, `backend/`, `api/`,
   `supabase/`, `functions/`, `migrations/`, `infra/`, `ops/`, `docs/`, `.github/`, `*.md`,
   `*.sql`, Dockerfiles), no lane runs: the QA phase runs the existing in-run QA (host/api
   probes, holdout scenarios, the checks that already passed). QA for a backend ticket means:
   checks + review + holdout scenarios proven by host-executed probes against the API.

A mobile ticket touching both platforms runs both drivers, one after the other
(`MultiSurfaceAgentQaLane`), and the merged report passes only when every surface passes: one
FAIL fails it, otherwise one BLOCKED blocks it. Each surface must check every acceptance
criterion with its own collected screenshot (a criterion seen on Android does not count for iOS).
Steps, findings and screenshots are prefixed per surface (`[iOS] …`, `ios-s1.png`).

### Android device pool

Lane config: `serial` (primary, e.g. `emulator-5554`) plus `fallbackDevices` tried in order when a
device is unavailable (exit 11), reserved (exit 13) or unreachable; one more round after
`retryDelayMs`. A fallback's `appIdSuffix` (default `.qa`) is appended to the app id and handed
to the build as `APP_ID`: the Seeker keeps its own `ai.traveljournal.app` (different signing key,
private data) untouched while `ai.traveljournal.app.qa` is installed beside it; the lane never
uninstalls or wipes. `busy` lists device-host-local `HHMM-HHMM` windows another tenant owns the
device (Daymark's X scan cron on the Seeker at :10 past 9, 11, 14, 16, 19 and 21 h with up to
30 min jitter).

### iOS (`ios-qa-lane.ts`, `ops/qa-lane/ios-qa.sh`)

- Simulator host: the Mac mini (`mini@100.105.165.15`), shared tapflow simulator by UDID (never
  a personal device). Single tenant: `mkdir` lock `/tmp/matrix-qa-ios.lock` (owner, holder,
  heartbeat, 2 h stale), plus this process's queue.
- Build on the mini: bare mirror fetched with the mini's `gh`, checkout at the exact head SHA
  (refused if the PR moved), then the operator's build command (wayline: `npm ci`,
  `qa-metro-env.mjs simulator <staging> ios` which refuses production, `EXPO_PUBLIC_QA_ENABLED=1`,
  `expo prebuild -p ios`, `pod install`, `xcodebuild … -sdk iphonesimulator -configuration
  Release`) with a cleared environment. The `.app`'s bundle id must equal the configured app id.
- Install with `simctl install` over the existing app (keeps its data), launch, first screenshot.
  Fixtures: `simctl addmedia` once per (simulator, fixture-set hash).
- The QA agent runs on the Matrix host (`ops/qa-lane/local-agent.sh`): `claude -p`, cleared env,
  throwaway HOME, tools = `./qa-ios` (`packages/qa/bin/qa-ios.mjs`: tap, swipe, type, key, home/lock
  over the tapflow relay WebSocket with the PAT header, locked to the job's UDID) and
  `./qa-shot <name>` (simctl screenshot over a fixed SSH step). The relay's own MCP server is not
  used: it connects without the PAT and this relay refuses it; its UI-tree and screenshot routes
  need a relay-installed build (a PAT with `builds:write`). Secrets: gateway key + tapflow PAT.
- Residual risk: PR build code runs as the mini's user (which holds a `gh` login); the PAT can
  drive the relay's other devices. Owner follow-up: a dedicated macOS build user on the mini.

### Web (`web-qa-lane.ts`, `packages/qa/bin/qa-browser.mjs`)

- Target: the PR's preview deploy (`previewUrl` template with `{pr}`, trusted only when the head
  SHA's commit status with `previewStatus` prefix is `success`, waits up to `previewWaitMs` while
  pending); otherwise a local build of the head SHA in a rootless podman container (no host
  mounts but the checkout, no host secrets), served on `127.0.0.1` (refused if the output holds
  symlinks). Neither → BLOCKED.
- Browser: `/usr/bin/google-chrome --headless=new` with a throwaway profile under the job dir and
  a DevTools port on 127.0.0.1 from `ports` (9300-9399), never 9222/9223 (the owner's Chromes).
- The agent's only tool is `./qa-browser` (open/snapshot/click/fill/press/viewport/screenshot/
  console/network), navigation limited to the target origin. A lane-owned recorder logs console
  errors, page errors, failed requests and 4xx/5xx responses; they become "Lane evidence" lines
  in the Linear report.
- Single tenant: `/tmp/matrix-qa-web.lock` (reclaimed when its process died).

### Lane config additions

```json
{
  "serial": "emulator-5554", "bootEmulator": true,
  "fallbackDevices": [{ "serial": "SM02E4072815934", "abi": "arm64-v8a", "appIdSuffix": ".qa",
    "busy": ["0900-1000", "1100-1200", "1400-1500", "1600-1700", "1900-2000", "2100-2200"] }],
  "ios": { "host": "mini@100.105.165.15", "udid": "<shared sim UDID>",
    "projects": { "<project-id>": { "repo": "NeOMakinG/wayline", "build": "…", "appId": "com.wayline.app",
      "app": "app/ios/build/Build/Products/Release-iphonesimulator/*.app" } } },
  "web": { "projects": { "<project-id>": { "repo": "owner/site",
    "previewUrl": "https://deploy-preview-{pr}--site.netlify.app", "previewStatus": "netlify/",
    "build": "npm ci && npm run build", "dist": "dist" } } }
}
```

Server env: `MATRIX_QA_NODE_DIR` (node for `qa-browser` and `tapflow-mcp`), optional
`MATRIX_QA_GATEWAY`, `MATRIX_QA_CLAUDE`, `MATRIX_QA_SECRETS`, `MATRIX_QA_TAPFLOW_MCP`.

iOS build sandbox, measured live (2026-10-26, wayline): the Seatbelt profile breaks Xcode tools
that sandbox themselves (`sandbox_apply: Operation not permitted` from coremlc; Swift macro
plugins and SwiftPM manifests likewise). `ios.sandboxBuild: false` runs the build as the mini's
user, the same exposure as the mini's existing manual lanes. The fix is a dedicated macOS build
account on the mini (needs the owner's sudo), then `sandboxBuild` can stay false safely.
