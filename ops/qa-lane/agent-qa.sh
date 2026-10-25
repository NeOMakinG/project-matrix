#!/usr/bin/env bash
# Matrix agent QA lane, device-host side. Streamed by the Matrix host: `ssh host bash -s -- <step> ...`.
# Every argument is validated by the caller AND here. Exit codes: 10 host overloaded, 11 device
# unavailable, 12 lane busy, 20 build failed, 21 install failed, 30 agent failed, 2 bad arguments.
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
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}" ANDROID_SDK_ROOT="${ANDROID_HOME:-/opt/android-sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

die() { echo "$2" >&2; exit "$1"; }
need() { [[ "$2" =~ $3 ]] || die 2 "invalid $1"; }
job_dir() { need job "$1" '^[a-z0-9-]{8,64}$'; echo "$ROOT/jobs/$1"; }
# Owner-only heartbeat: every step of the lock holder refreshes it, so a live job never goes stale.
beat() { [[ "$(cat "$LOCK/owner" 2>/dev/null || true)" == "$1" ]] && date +%s >"$LOCK/beat"; true; }
as_user() { local u="$1"; shift; runuser -u "$u" -- env -i HOME="/home/$u" PATH="/usr/local/bin:/usr/bin:/bin:$ANDROID_HOME/platform-tools" \
  ANDROID_HOME="$ANDROID_HOME" ANDROID_SDK_ROOT="$ANDROID_HOME" LANG=C.UTF-8 "$@"; }
as_qa() { as_user "$QA_USER" "$@"; }
as_build() { as_user "$BUILD_USER" "$@"; }

step="${1:-}"; shift || true
case "$step" in
  precheck)
    serial="$1" boot="$2" max_load_pct="$3" min_mem_mb="$4"
    need serial "$serial" '^[A-Za-z0-9._:-]{1,64}$'
    need boot "$boot" '^[01]$'; need load "$max_load_pct" '^[0-9]{1,3}$'; need mem "$min_mem_mb" '^[0-9]{1,6}$'
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
    job="$1" wait_s="$2"; need job "$job" '^[a-z0-9-]{8,64}$'; need wait "$wait_s" '^[0-9]{1,5}$'
    deadline=$(( $(date +%s) + wait_s ))
    while :; do
      # Build the lock fully, then publish it with one atomic rename: no half-initialized lock.
      tmp=$(mktemp -d /tmp/matrix-qa-lane.XXXXXX); echo "$job" >"$tmp/owner"; date +%s >"$tmp/beat"
      if mv -T "$tmp" "$LOCK" 2>/dev/null; then break; fi
      rm -rf "$tmp"
      beat_s=$(cat "$LOCK/beat" 2>/dev/null || date +%s)
      if (( $(date +%s) - beat_s > STALE_S )); then
        mv -T "$LOCK" "$LOCK.stale.$$" 2>/dev/null && rm -rf "$LOCK.stale.$$"; continue
      fi
      (( $(date +%s) < deadline )) || die 12 "device lane busy (held by $(cat "$LOCK/owner" 2>/dev/null || echo another tenant))"
      sleep 15
    done
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
  build)
    dir=$(job_dir "$1") repo="$2" pr="$3" sha="$4" abi="$5" timeout_s="$6"
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
        git checkout --quiet --force --detach "$4"; git clean -qfdx -e node_modules
        git log -1 --format="commit %H %s"' sh "$work" "$mirror" "$sha" "$sha"
      cd "$work" && as_build ABI="$abi" timeout -k 30 "$timeout_s" nice bash "$dir/build.sh"
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
    adb -s "$serial" install -r -g "$dir/app.apk" >"$dir/install.log" 2>&1 || { tail -c 500 "$dir/install.log" >&2; exit 21; }
    adb -s "$serial" shell dumpsys package "$app" | sed -n 's/^ *versionName=//p' | head -1
    ;;
  agent)
    dir=$(job_dir "$1") model="$2" timeout_s="$3" serial="$4"
    need model "$model" '^[a-z0-9.-]{3,60}$'; need timeout "$timeout_s" '^[0-9]{2,4}$'
    (( timeout_s <= 5400 )) || die 2 "timeout above the lock's stale limit"
    need serial "$serial" '^[A-Za-z0-9._:-]{1,64}$'
    beat "$1"
    install -d -o root -g root -m 755 "$dir/.claude"
    # Only these tools; writes only under out/. The user's broad settings are not loaded.
    cat >"$dir/.claude/settings.json.tmp" <<'JSON'
{"permissions":{"allow":["Bash(agent-device:*)","Bash(adb:*)","Read(./**)","Write(./out/**)","Glob(./**)"],"deny":["WebFetch","WebSearch","Agent","Task"],"defaultMode":"default"}}
JSON
    mv -f "$dir/.claude/settings.json.tmp" "$dir/.claude/settings.json"
    cd "$dir"
    pkill -KILL -u "$QA_USER" || true
    # Root resolves only the gateway key from Infisical; the agent runs as the QA user with a
    # cleared environment holding that key alone (no other secret, no gh, no root files).
    secrets run -- sh -c '
      exec env -i HOME="/home/$1" PATH="/usr/local/bin:/usr/bin:/bin:$4" LANG=C.UTF-8 ANDROID_SERIAL="$3" \
        ANTHROPIC_BASE_URL="${MATRIX_QA_GATEWAY:-http://127.0.0.1:8317}" ANTHROPIC_AUTH_TOKEN="$CLIPROXY_API_KEY" \
        runuser -u "$1" -- timeout -k 30 "$5" claude -p --model "$2" --setting-sources project --strict-mcp-config \
          --allowedTools "Bash(agent-device:*)" "Bash(adb:*)" "Read(./**)" "Write(./out/**)" "Glob(./**)" \
          --disallowedTools WebFetch WebSearch Agent Task' \
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
      n=0
      for f in shots/*.png; do
        [[ -f "$f" && ! -L "$f" ]] || continue
        (( $(stat -c %s "$f") <= 3145728 )) || continue
        n=$((n+1)); (( n <= 12 )) || break
        printf "%s\t%s\n" "$(basename "$f")" "$(base64 -w0 "$f")"
      done' sh "$dir"
    ;;
  cleanup)
    dir=$(job_dir "$1"); rm -rf "$dir"
    ;;
  *) die 2 "unknown step" ;;
esac
