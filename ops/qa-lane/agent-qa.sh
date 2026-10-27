#!/usr/bin/env bash
# Matrix agent QA lane, device-host side. Streamed by the Matrix host: `ssh host bash -s -- <step> ...`.
# Every argument is validated by the caller AND here. Exit codes: 10 host overloaded, 11 device
# unavailable, 12 lane busy, 13 device reserved (busy window), 20 build failed, 21 install failed, 30 agent failed, 2 bad arguments.
# A device that drops offline (install, seeding, before launch) is reconnected or, for an emulator
# this host boots, restarted once before the step gives up with 11.
set -euo pipefail

# Two unprivileged users: PR build code runs as BUILD_USER, the QA agent (which holds the gateway
# key) as QA_USER. Neither sees root's credentials (gh, Infisical); the build cannot reach the
# agent's home, key or output. Create them once:
#   useradd --create-home matrixqa && useradd --create-home matrixqa-build
#   chmod 700 /home/matrixqa /home/matrixqa-build
QA_USER="${MATRIX_QA_USER:-matrixqa}"
BUILD_USER="${MATRIX_QA_BUILD_USER:-matrixqa-build}"
ROOT="${MATRIX_QA_ROOT:-/srv/matrix-qa}"
LOCK=/tmp/matrix-qa-lane.lock
STALE_S=7200 # > longest step: 2 x 300 s git + 5400 s build (+ kill grace)
# Package-manager network failures worth one build retry (see `build`).
NET_ERR='EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|socket hang up|getaddrinfo|ERR_SOCKET_TIMEOUT|npm (ERR!|error) (network|code E5[0-9][0-9])|npm (ERR!|error) .*50[234] (Bad Gateway|Service Unavailable|Gateway Time-?out)|ERR_PNPM_(META_FETCH_FAIL|FETCH_5[0-9][0-9])'
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}" ANDROID_SDK_ROOT="${ANDROID_HOME:-/opt/android-sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

die() { echo "$2" >&2; exit "$1"; }
need() { [[ "$2" =~ $3 ]] || die 2 "invalid $1"; }
job_dir() { need job "$1" '^[a-z0-9-]{8,64}$'; echo "$ROOT/jobs/$1"; }
# Owner-only heartbeat: every step of the lock holder refreshes it, so a live job never goes stale.
beat() { [[ "$(cat "$LOCK/owner" 2>/dev/null || true)" == "$1" ]] && date +%s >"$LOCK/beat"; true; }
# Private TMPDIR per user: shared /tmp caches (Metro) owned by others break builds and leak state.
as_user() { local u="$1"; shift; /usr/sbin/runuser -u "$u" -- mkdir -p "/home/$u/.tmp"
  /usr/sbin/runuser -u "$u" -- env -i HOME="/home/$u" TMPDIR="/home/$u/.tmp" PATH="/usr/local/bin:/usr/bin:/bin:$ANDROID_HOME/platform-tools" \
  ANDROID_HOME="$ANDROID_HOME" ANDROID_SDK_ROOT="$ANDROID_HOME" LANG=C.UTF-8 "$@"; }
as_qa() { as_user "$QA_USER" "$@"; }
as_build() { as_user "$BUILD_USER" "$@"; }
online() { [[ "$(adb -s "$1" get-state 2>/dev/null || true)" == device ]]; }
booted() { [[ "$(adb -s "$1" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; }
# Brings an offline device back once: reconnect, then (an emulator this host boots) a restart.
# A device that went offline mid-job otherwise blocks the run on an adb hiccup, not the app.
revive() {
  local serial="$1"
  adb -s "$serial" reconnect >/dev/null 2>&1 || true
  for _ in $(seq 1 15); do online "$serial" && booted "$serial" && return 0; sleep 2; done
  [[ "$serial" == emulator-* && -x /root/boot-emulator.sh ]] || return 1
  echo "restarting $serial" >&2
  adb -s "$serial" emu kill >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do online "$serial" || break; sleep 1; done
  /root/boot-emulator.sh >/dev/null || return 1
  timeout 180 adb -s "$serial" wait-for-device >/dev/null 2>&1 || true
  for _ in $(seq 1 90); do booted "$serial" && return 0; sleep 2; done
  return 1
}
ensure_device() { online "$1" && return 0; echo "$1 offline, reviving" >&2; revive "$1"; }
# adb's own words for "the device went away", as opposed to an APK the device refused.
lost_device() { grep -qiE "device .*(offline|not found)|no devices/emulators|device offline|\bclosed\b|protocol fault|connection reset" "$1"; }

step="${1:-}"; shift || true
case "$step" in
  precheck)
    serial="$1" boot="$2" max_load_pct="$3" min_mem_mb="$4" busy="${5:-}"
    need serial "$serial" '^[A-Za-z0-9._:-]{1,64}$'
    need boot "$boot" '^[01]$'; need load "$max_load_pct" '^[0-9]{1,3}$'; need mem "$min_mem_mb" '^[0-9]{1,6}$'
    need busy "$busy" '^([0-9]{4}-[0-9]{4})?(,[0-9]{4}-[0-9]{4}){0,23}$'
    # Device-host local time windows another tenant owns the device (e.g. a cron scan): skip it.
    now=$((10#$(date +%H%M)))
    for w in ${busy//,/ }; do
      from=$((10#${w%-*})) to=$((10#${w#*-}))
      # A window may cross midnight (2300-0100).
      if (( from <= to ? (from <= now && now < to) : (now >= from || now < to) )); then die 13 "device $serial reserved by another tenant until ${w#*-}"; fi
    done
    cores=$(nproc); load=$(cut -d' ' -f1 /proc/loadavg)
    mem=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
    if awk -v l="$load" -v c="$cores" -v m="$max_load_pct" 'BEGIN{exit !(l*100 > c*m)}'; then
      die 10 "device host overloaded: load $load on $cores cores"
    fi
    (( mem >= min_mem_mb )) || die 10 "device host overloaded: ${mem} MB available, need ${min_mem_mb} MB"
    if [[ "$(adb -s "$serial" get-state 2>/dev/null || true)" != device ]]; then
      if [[ "$boot" == 1 && -x /root/boot-emulator.sh ]]; then
        /root/boot-emulator.sh >/dev/null
        adb -s "$serial" wait-for-device >/dev/null 2>&1 &
        for _ in $(seq 1 90); do
          [[ "$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]] && break
          sleep 2
        done
      fi
      [[ "$(adb -s "$serial" get-state 2>/dev/null || true)" == device ]] || die 11 "device $serial unavailable"
    fi
    echo "model=$(adb -s "$serial" shell getprop ro.product.model | tr -d '\r')"
    echo "android=$(adb -s "$serial" shell getprop ro.build.version.release | tr -d '\r')"
    echo "load=$load cores=$cores mem_mb=$mem"
    ;;
  lock)
    job="$1" wait_s="$2" holder="${3:-unknown}"; need job "$job" '^[a-z0-9-]{8,64}$'; need wait "$wait_s" '^[0-9]{1,5}$'
    need holder "$holder" '^[A-Za-z0-9._@-]{1,64}$'
    deadline=$(( $(date +%s) + wait_s ))
    # Acquisition and stale reclamation are serialized by a kernel lock: no waiter can act on an
    # observation another waiter already invalidated.
    exec 9>/tmp/matrix-qa-lane.flock
    while :; do
      flock 9
      # Build the lock fully, then publish it with one atomic rename: no half-initialized lock.
      tmp=$(mktemp -d /tmp/matrix-qa-lane.XXXXXX); echo "$job" >"$tmp/owner"; echo "$holder" >"$tmp/holder"; date +%s >"$tmp/beat"
      if mv -T "$tmp" "$LOCK" 2>/dev/null; then flock -u 9; break; fi
      rm -rf "$tmp"
      beat_s=$(cat "$LOCK/beat" 2>/dev/null || date +%s)
      if (( $(date +%s) - beat_s > STALE_S )); then
        rm -rf "$LOCK"; flock -u 9; continue
      fi
      flock -u 9
      (( $(date +%s) < deadline )) || die 12 "device lane busy (held by $(cat "$LOCK/owner" 2>/dev/null || echo another tenant))"
      sleep 15
    done
    ;;
  reclaim)
    # The Matrix process named <holder> just started: a lock it holds belongs to a predecessor that
    # died mid-job (its ssh session is gone, its remote step may still run). Kill that job's
    # processes and release the lock now instead of after the 2 h stale limit. Locks of any other
    # holder (qaexplorer, a human, another Matrix host) are never touched.
    holder="$1"; need holder "$holder" '^[A-Za-z0-9._@-]{1,64}$'
    exec 9>/tmp/matrix-qa-lane.flock; flock 9
    if [[ -d "$LOCK" && "$(cat "$LOCK/holder" 2>/dev/null || true)" == "$holder" ]]; then
      owner=$(cat "$LOCK/owner" 2>/dev/null || echo unknown)
      # The dead job's own root steps first (so none starts a new build or agent), then its users.
      [[ "$owner" =~ ^[a-z0-9-]{8,64}$ ]] && { pkill -KILL -f "^bash -s -- [a-z]+ $owner( |\$)" || true; }
      pkill -KILL -u "$BUILD_USER" || true; pkill -KILL -u "$QA_USER" || true
      rm -rf "$LOCK"
      [[ "$owner" =~ ^[a-z0-9-]{8,64}$ ]] && rm -rf "$ROOT/jobs/$owner"
      echo "reclaimed $owner"
    fi
    flock -u 9
    ;;
  unlock)
    job="$1"; need job "$job" '^[a-z0-9-]{8,64}$'
    if [[ "$(cat "$LOCK/owner" 2>/dev/null || true)" == "$job" ]]; then
      # Nothing of this job survives the lock: a build or agent still running (caller gave up) dies.
      pkill -KILL -u "$BUILD_USER" || true; pkill -KILL -u "$QA_USER" || true
      rm -rf "$LOCK"
    fi
    true
    ;;
  write)
    # Job dir and everything root writes stay root-owned; only out/ belongs to the QA user, and
    # root never writes into, or reads through, a path the QA user controls.
    dir=$(job_dir "$1"); name="$2"; need name "$name" '^[a-z][a-z0-9._-]{0,40}$'
    beat "$1"
    if [[ ! -d "$dir" ]]; then
      # Created once, before any PR code runs; root never traverses out/ afterwards.
      install -d -o root -g root -m 755 "$ROOT" "$ROOT/jobs"
      mkdir -m 755 "$dir"
      mkdir -m 700 "$dir/out" && mkdir -m 700 "$dir/out/shots"
      chown "$QA_USER:" "$dir/out/shots" && chown "$QA_USER:" "$dir/out"
    fi
    [[ -d "$dir" && ! -L "$dir" && "$(stat -c %U "$dir")" == root ]] || die 2 "job dir not root-owned"
    printf %s "$3" | base64 -d >"$dir/$name.tmp" && mv -f "$dir/$name.tmp" "$dir/$name"
    ;;
  append)
    # The next chunk of a file `write` started (one ssh argument stays far under 128 KiB).
    dir=$(job_dir "$1"); name="$2"; need name "$name" '^[a-z][a-z0-9._-]{0,40}$'
    beat "$1"
    [[ -d "$dir" && ! -L "$dir" && "$(stat -c %U "$dir")" == root ]] || die 2 "job dir not root-owned"
    [[ -f "$dir/$name" && ! -L "$dir/$name" ]] || die 2 "append before write"
    printf %s "$3" | base64 -d >>"$dir/$name"
    ;;
  seed)
    # Test data the project's QA needs, put on the device before the agent starts: every fx-<name>
    # file of the job lands as <devdir>/<name>. Idempotent: a file already there with the same
    # bytes is left alone.
    # The set's manifest (name + sha256 per file) is kept on the device. When it differs from the
    # last one seeded (first seed, a fixture regenerated, renamed or dropped): files the old manifest
    # listed and the new one does not are deleted, and the app's data is cleared. A replaced or
    # deleted file gets a new MediaStore id or none, and an app that indexes the gallery keeps the
    # old ids as photos it can no longer load (Travel Journal showed every third photo of the
    # seeded trip as a blank tile after the set was regenerated).
    dir=$(job_dir "$1") serial="$2" devdir="$3" app="${4:-}"
    need serial "$serial" '^[A-Za-z0-9._:-]{1,64}$'; need devdir "$devdir" '^/sdcard/[A-Za-z0-9._/-]{1,100}$'
    [[ "$devdir" != *..* ]] || die 2 "invalid devdir"
    [[ -z "$app" ]] || need app "$app" '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$'
    beat "$1"
    ensure_device "$serial" || die 11 "device $serial unavailable"
    adb -s "$serial" shell mkdir -p "$devdir"
    manifest="$dir/fixtures.manifest"; : >"$manifest"
    for f in "$dir"/fx-*; do
      [[ -f "$f" && ! -L "$f" ]] || continue
      name=$(basename "$f"); name=${name#fx-}; need fixture "$name" '^[a-z][a-z0-9._-]{0,40}$'
      printf '%s %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$name" >>"$manifest"
    done
    printf 'app %s\n' "${app:--}" >>"$manifest"
    mark="/data/local/tmp/matrix-fixtures$(printf %s "$devdir" | tr / _).manifest"
    old=$(adb -s "$serial" shell cat "$mark" 2>/dev/null | tr -d '\r' || true)
    changed=0; [[ "$old" == "$(cat "$manifest")" ]] || changed=1
    removed=0
    if ((changed)); then
      while read -r kind oname; do
        [[ "$kind" != app && "$oname" =~ ^[a-z][a-z0-9._-]{0,40}$ ]] || continue
        cut -d' ' -f2 "$manifest" | grep -qxF "$oname" && continue
        adb -s "$serial" shell rm -f "$devdir/$oname" </dev/null && removed=$((removed + 1))
      done <<<"$old"
    fi
    pushed=0 kept=0
    for f in "$dir"/fx-*; do
      [[ -f "$f" && ! -L "$f" ]] || continue
      name=$(basename "$f"); name=${name#fx-}
      want=$(sha256sum "$f" | cut -d' ' -f1)
      got=$(adb -s "$serial" shell sha256sum "$devdir/$name" 2>/dev/null | tr -d '\r' | cut -d' ' -f1 || true)
      if [[ "$got" == "$want" ]]; then kept=$((kept + 1)); continue; fi
      adb -s "$serial" push "$f" "$devdir/$name" >/dev/null || die 11 "could not push $name to $serial"
      pushed=$((pushed + 1))
    done
    # Scanned every run, not only after a push: a scan that failed once would otherwise leave the
    # files on disk but out of MediaStore (invisible to the app) on every later run.
    adb -s "$serial" shell content call --uri content://media --method scan_volume --arg external_primary >/dev/null 2>&1 \
      || die 11 "media scan failed on $serial"
    cleared=0
    if ((changed)); then
      if [[ -n "$app" ]] && adb -s "$serial" shell pm path "$app" >/dev/null 2>&1; then
        adb -s "$serial" shell pm clear "$app" >/dev/null || die 11 "could not clear $app data on $serial"
        cleared=1
      fi
      adb -s "$serial" push "$manifest" "$mark" >/dev/null 2>&1 || die 11 "could not record fixtures on $serial"
    fi
    echo "seeded pushed=$pushed present=$kept removed=$removed app_cleared=$cleared"
    ;;
  build)
    dir=$(job_dir "$1") repo="$2" pr="$3" sha="$4" abi="$5" timeout_s="$6" app_id="${7:-}"
    need app_id "$app_id" '^([A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+)?$'
    need repo "$repo" '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$'; need pr "$pr" '^[0-9]{1,9}$'
    need sha "$sha" '^[a-f0-9]{40}$'; need abi "$abi" '^(arm64-v8a|x86_64|armeabi-v7a|x86)$'
    need timeout "$timeout_s" '^[0-9]{2,4}$'; (( timeout_s <= 5400 )) || die 2 "timeout above the lock's stale limit"
    beat "$1"
    mirror="$ROOT/mirrors/${repo/\//__}.git" work="$ROOT/build/${repo/\//__}"
    install -d -o root -g root -m 755 "$ROOT/mirrors"
    install -d -o "$BUILD_USER" -g "$BUILD_USER" -m 755 "$ROOT/build"
    # errexit is ignored inside `cmd || handler`: run the block in a plain subshell instead.
    set +e
    (
      set -e
      # Root-owned bare mirror: the only place root runs git, fetched with root's gh credential.
      [[ -d "$mirror" ]] || git init --quiet --bare "$mirror"
      timeout -k 10 300 git --git-dir "$mirror" -c credential.helper= -c "credential.helper=!gh auth git-credential" \
        fetch --quiet "https://github.com/$repo.git" "+refs/pull/$pr/head:refs/matrix/pr-$pr"
      [[ "$(git --git-dir "$mirror" rev-parse "refs/matrix/pr-$pr")" == "$sha" ]] \
        || { echo "PR head moved: $(git --git-dir "$mirror" rev-parse "refs/matrix/pr-$pr") != $sha"; exit 3; }
      # The QA user checks out and builds in its own working copy (PR code never runs as root).
      as_build bash -c 'set -e; [[ -d "$1/.git" ]] || git init --quiet "$1"; cd "$1"
        git config --global --get-all safe.directory | grep -qxF "$2" || git config --global --add safe.directory "$2"
        timeout -k 10 300 git fetch --quiet --no-tags "file://$2" "$3"
        git checkout --quiet --force --detach "$4"; git clean -qffdx
        git log -1 --format="commit %H %s"' sh "$work" "$mirror" "$sha" "$sha"
      cd "$work"
      build_once() { as_build ABI="$abi" APP_ID="$app_id" VERSION_CODE="$(( $(date +%s) / 60 ))" timeout -k 30 "$1" nice bash "$dir/build.sh"; }
      started=$(date +%s)
      # npm/pnpm network errors (DNS, resets, registry 5xx) get one retry when they hit early (the
      # install, first 10 min), so a transient blip is not reported; any other failure fails now.
      if ! build_once "$timeout_s"; then
        (( $(date +%s) - started < 600 )) || exit 1
        tail -c 6000 "$dir/build.log" | grep -qE "$NET_ERR" || exit 1
        pkill -KILL -u "$BUILD_USER" || true
        echo "matrix-qa: network error during the build install; retrying once in 30 s"
        sleep 30; beat "$1"
        # Both builds together stay within timeout_s (the lock and SSH limits assume one build).
        build_once "$(( timeout_s - ($(date +%s) - started) - 30 ))"
      fi
    ) >"$dir/build.log" 2>&1
    rc=$?
    set -e
    if (( rc != 0 )); then pkill -KILL -u "$BUILD_USER" || true; tail -c 1500 "$dir/build.log" >&2; exit 20; fi
    # Nothing the build started survives into the QA agent's run.
    pkill -KILL -u "$BUILD_USER" || true
    echo "$work" >"$dir/src"
    ;;
  install)
    dir=$(job_dir "$1") serial="$2" apk="$3" app="$4"
    need serial "$serial" '^[A-Za-z0-9._:-]{1,64}$'; need apk "$apk" '^[A-Za-z0-9._/-]{1,200}$'
    need app "$app" '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
    [[ "$apk" != *..* && "$apk" != /* ]] || die 2 "invalid apk"
    beat "$1"; src=$(cat "$dir/src")
    # Copied out by the build user: root never opens a path inside the build-owned checkout.
    as_build cat "$src/$apk" >"$dir/app.apk" 2>/dev/null || die 21 "build produced no APK at $apk"
    ensure_device "$serial" || die 11 "device $serial unavailable before install"
    ok=0
    for attempt in 1 2; do
      # 2 x 420 s + revive (<= ~7 min) stays inside the caller's 25 min budget for this step.
      if timeout -k 10 420 adb -s "$serial" install -r -g "$dir/app.apk" >"$dir/install.log" 2>&1; then ok=1; break; fi
      # One retry, only when the device itself dropped (offline, gone): never for a refused APK.
      if (( attempt == 1 )) && { lost_device "$dir/install.log" || ! online "$serial"; }; then
        echo "install lost $serial, reviving and retrying once" >&2
        revive "$serial" || die 11 "device $serial went offline during install and did not come back"
        continue
      fi
      break
    done
    if (( ok == 0 )); then
      # Nothing on the device is ever uninstalled or wiped here: Android keeps the version code of
      # a package uninstalled with its data, so no data-keeping path exists for a downgrade.
      # Builds avoid it by using $VERSION_CODE (always above earlier lane builds, see `build`).
      if grep -q INSTALL_FAILED_VERSION_DOWNGRADE "$dir/install.log"; then
        die 21 "a newer $app is installed: make the build use \$VERSION_CODE as its Android versionCode, or uninstall $app by hand"
      fi
      tail -c 500 "$dir/install.log" >&2; exit 21
    fi
    # The configured app must now BE this artifact: a PR that changes the application id would
    # otherwise install beside it and leave the agent testing an older build of "$app".
    installed=$(adb -s "$serial" shell pm path "$app" 2>/dev/null | sed -n 's/^package://p' | grep 'base\.apk$' | head -1 | tr -d '\r')
    [[ "$installed" =~ ^/[A-Za-z0-9._/=~+-]+$ ]] || die 21 "$app is not installed after install (application id changed?)"
    want=$(sha256sum "$dir/app.apk" | cut -d' ' -f1)
    got=$(adb -s "$serial" shell sha256sum "$installed" 2>/dev/null | tr -d '\r' | cut -d' ' -f1)
    [[ "$got" == "$want" ]] || die 21 "installed $app does not match the built APK (application id changed?)"
    adb -s "$serial" shell dumpsys package "$app" | sed -n 's/^ *versionName=//p' | head -1
    ;;
  agent)
    dir=$(job_dir "$1") model="$2" timeout_s="$3" serial="$4"
    need model "$model" '^[a-z0-9.-]{3,60}$'; need timeout "$timeout_s" '^[0-9]{2,4}$'
    (( timeout_s <= 5400 )) || die 2 "timeout above the lock's stale limit"
    need serial "$serial" '^[A-Za-z0-9._:-]{1,64}$'
    beat "$1"
    # The agent's first act is launching the app: a device that dropped since install is revived
    # once here rather than reported as an app that would not start.
    ensure_device "$serial" || die 11 "device $serial unavailable before launch"
    install -d -o root -g root -m 755 "$dir/.claude"
    # Only these tools; writes only under out/. The user's broad settings are not loaded.
    cat >"$dir/.claude/settings.json.tmp" <<'JSON'
{"permissions":{"allow":["Bash(agent-device:*)","Bash(adb logcat:*)","Bash(adb shell input:*)","Bash(adb shell svc:*)","Bash(adb shell getprop:*)","Bash(adb shell dumpsys:*)","Bash(adb shell pm list:*)","Bash(adb exec-out screencap:*)","Read(./**)","Edit(./out/**)"],"deny":["Bash(agent-device install:*)","Bash(agent-device install-from-source:*)","Bash(adb push:*)","Bash(adb pull:*)","Bash(adb install:*)","WebFetch","WebSearch","Agent","Task"],"defaultMode":"default"}}
JSON
    mv -f "$dir/.claude/settings.json.tmp" "$dir/.claude/settings.json"
    cd "$dir"
    pkill -KILL -u "$QA_USER" || true
    # Claude ignores an untrusted workspace's settings (the allow/deny list above): trust this job
    # dir in the QA user's own config, written as that user. Edit(...) is the rule that covers the
    # Write tool; a Write(...) rule matches nothing and the agent could not write its report.
    as_qa python3 -c 'import json,os,sys
p=os.path.expanduser("~/.claude.json")
try: c=json.load(open(p))
except Exception: c={}
c.setdefault("projects",{}).setdefault(sys.argv[1],{})["hasTrustDialogAccepted"]=True
ps=c["projects"]
for k in [k for k in ps if k.startswith(sys.argv[2]) and k!=sys.argv[1]]: del ps[k]
json.dump(c,open(p+".tmp","w")); os.replace(p+".tmp",p)' "$dir" "$ROOT/jobs/"
    # Root resolves only the gateway key from Infisical; the agent runs as the QA user with a
    # cleared environment holding that key alone (no other secret, no gh, no root files).
    timeout -k 30 $((timeout_s + 300)) secrets run -- sh -c '
      exec env -i HOME="/home/$1" TMPDIR="/home/$1/.tmp" PATH="/usr/local/bin:/usr/bin:/bin:$4" LANG=C.UTF-8 ANDROID_SERIAL="$3" \
        ANTHROPIC_BASE_URL="${MATRIX_QA_GATEWAY:-http://127.0.0.1:8317}" ANTHROPIC_AUTH_TOKEN="$CLIPROXY_API_KEY" \
        /usr/sbin/runuser -u "$1" -- timeout -k 30 "$5" claude -p --model "$2" --setting-sources project --strict-mcp-config \
          --allowedTools "Bash(agent-device:*)" "Bash(adb logcat:*)" "Bash(adb shell input:*)" "Bash(adb shell svc:*)" \
            "Bash(adb shell getprop:*)" "Bash(adb shell dumpsys:*)" "Bash(adb shell pm list:*)" "Bash(adb exec-out screencap:*)" \
            "Read(./**)" "Edit(./out/**)" \
          --disallowedTools "Bash(agent-device install:*)" "Bash(agent-device install-from-source:*)" \
            "Bash(adb push:*)" "Bash(adb pull:*)" "Bash(adb install:*)" WebFetch WebSearch Agent Task' \
      sh "$QA_USER" "$model" "$serial" "$ANDROID_HOME/platform-tools" "$timeout_s" \
      <"$dir/prompt.md" >"$dir/agent.log" 2>&1 || { pkill -KILL -u "$QA_USER" || true; tail -c 800 "$dir/agent.log" >&2; exit 30; }
    # No agent process outlives its run (it could rewrite a report after collection).
    pkill -KILL -u "$QA_USER" || true
    ;;
  collect)
    dir=$(job_dir "$1"); beat "$1"
    # Read as the QA user: a planted symlink can only reach what that user can read anyway.
    as_qa bash -c 'set -e; cd "$1/out"
      [[ -f report.json && ! -L report.json ]] || { echo "QA agent wrote no out/report.json" >&2; exit 30; }
      printf "report.json\t%s\n" "$(head -c 200000 report.json | base64 -w0)"
      # The screenshots the report cites come first (they are the evidence Matrix checks), then
      # the others, 24 at most: a long run takes more than 12 and cites its later ones.
      cited=$(head -c 200000 report.json | grep -oE "\"screenshot\"[[:space:]]*:[[:space:]]*\"[A-Za-z0-9][A-Za-z0-9._-]{0,80}\\.png\"" \
        | sed -E "s/.*\"([^\"]+)\"\$/\\1/" | awk "!seen[\$0]++" || true)
      n=0 sent=" "
      for f in $(printf "shots/%s\n" $cited) shots/*.png; do
        [[ -f "$f" && ! -L "$f" ]] || continue
        b=$(basename "$f"); [[ "$sent" == *" $b "* ]] && continue
        size=$(stat -c %s "$f"); (( size <= 3145728 )) || continue
        n=$((n+1)); (( n <= 24 )) || break
        total=$((${total:-0} + size)); (( total <= 25165824 )) || break
        sent="$sent$b "
        printf "%s\t%s\n" "$b" "$(base64 -w0 "$f")"
      done' sh "$dir"
    ;;
  cleanup)
    dir=$(job_dir "$1"); rm -rf "$dir"
    ;;
  *) die 2 "unknown step" ;;
esac
