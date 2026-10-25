#!/usr/bin/env bash
# Matrix agent QA lane, device-host side. Streamed by the Matrix host: `ssh host bash -s -- <step> ...`.
# Every argument is validated by the caller AND here. Exit codes: 10 host overloaded, 11 device
# unavailable, 12 lane busy, 20 build failed, 21 install failed, 30 agent failed, 2 bad arguments.
set -euo pipefail

ROOT="${MATRIX_QA_ROOT:-/root/matrix-qa}"
LOCK=/tmp/matrix-qa-lane.lock
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}" ANDROID_SDK_ROOT="${ANDROID_HOME:-/opt/android-sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

die() { echo "$2" >&2; exit "$1"; }
need() { [[ "$2" =~ $3 ]] || die 2 "invalid $1"; }
job_dir() { need job "$1" '^[a-z0-9-]{8,64}$'; echo "$ROOT/jobs/$1"; }

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
    while ! mkdir "$LOCK" 2>/dev/null; do
      started=$(cat "$LOCK/started" 2>/dev/null || echo 0)
      if (( $(date +%s) - started > 7200 )); then rm -rf "$LOCK"; continue; fi
      (( $(date +%s) < deadline )) || die 12 "device lane busy (held by $(cat "$LOCK/owner" 2>/dev/null || echo unknown))"
      sleep 15
    done
    echo "$job" >"$LOCK/owner"; date +%s >"$LOCK/started"
    ;;
  unlock)
    job="$1"; need job "$job" '^[a-z0-9-]{8,64}$'
    [[ "$(cat "$LOCK/owner" 2>/dev/null || true)" == "$job" ]] && rm -rf "$LOCK"
    true
    ;;
  write)
    dir=$(job_dir "$1"); name="$2"; need name "$name" '^[a-z][a-z0-9._-]{0,40}$'
    mkdir -p "$dir/shots"; printf %s "$3" | base64 -d >"$dir/$name"
    ;;
  build)
    dir=$(job_dir "$1") repo="$2" pr="$3" sha="$4" abi="$5"
    need repo "$repo" '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$'; need pr "$pr" '^[0-9]{1,9}$'
    need sha "$sha" '^[a-f0-9]{40}$'; need abi "$abi" '^(arm64-v8a|x86_64|armeabi-v7a|x86)$'
    src="$ROOT/repos/${repo/\//__}"; mkdir -p "$ROOT/repos" "$dir"
    {
      [[ -d "$src/.git" ]] || gh repo clone "$repo" "$src" -- --filter=blob:none
      cd "$src"
      git fetch --quiet origin "pull/$pr/head"
      [[ "$(git rev-parse FETCH_HEAD)" == "$sha" ]] || { echo "PR head moved: $(git rev-parse FETCH_HEAD) != $sha"; exit 3; }
      git reset --quiet --hard && git clean -qfdx -e node_modules
      git checkout --quiet --detach "$sha"
      git log -1 --format='commit %H %s'
      export ABI="$abi" NODE_ENV=production
      nice bash "$dir/build.sh"
    } >"$dir/build.log" 2>&1 || { tail -c 1500 "$dir/build.log" >&2; exit 20; }
    echo "$src" >"$dir/src"
    ;;
  install)
    dir=$(job_dir "$1") serial="$2" apk="$3" app="$4"
    need serial "$serial" '^[A-Za-z0-9._:-]{1,64}$'; need apk "$apk" '^[A-Za-z0-9._/-]{1,200}$'
    need app "$app" '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
    [[ "$apk" != *..* ]] || die 2 "invalid apk"
    src=$(cat "$dir/src"); [[ -f "$src/$apk" ]] || die 21 "build produced no APK at $apk"
    adb -s "$serial" install -r -g "$src/$apk" >"$dir/install.log" 2>&1 || { tail -c 500 "$dir/install.log" >&2; exit 21; }
    adb -s "$serial" shell dumpsys package "$app" | sed -n 's/^ *versionName=//p' | head -1
    ;;
  agent)
    dir=$(job_dir "$1") model="$2" timeout_s="$3" serial="$4"
    need model "$model" '^[a-z0-9.-]{3,60}$'; need timeout "$timeout_s" '^[0-9]{2,5}$'
    need serial "$serial" '^[A-Za-z0-9._:-]{1,64}$'
    mkdir -p "$dir/.claude" "$dir/shots"
    # Only these tools: the user's broad settings are not loaded (project settings only).
    cat >"$dir/.claude/settings.json" <<'JSON'
{"permissions":{"allow":["Bash(agent-device:*)","Bash(adb:*)","Read","Write","Glob"],"deny":["WebFetch","WebSearch","Agent","Task"],"defaultMode":"default"}}
JSON
    cd "$dir"
    export ANDROID_SERIAL="$serial"
    timeout "$timeout_s" secrets run -- sh -c '
      ANTHROPIC_BASE_URL="${MATRIX_QA_GATEWAY:-http://127.0.0.1:8317}" ANTHROPIC_AUTH_TOKEN="$CLIPROXY_API_KEY" \
      exec claude -p --model "$0" --setting-sources project --strict-mcp-config \
        --allowedTools "Bash(agent-device:*)" "Bash(adb:*)" Read Write Glob \
        --disallowedTools WebFetch WebSearch Agent Task \
        <prompt.md' "$model" >"$dir/agent.log" 2>&1 || { tail -c 800 "$dir/agent.log" >&2; exit 30; }
    [[ -s "$dir/report.json" ]] || die 30 "QA agent wrote no report.json"
    ;;
  collect)
    dir=$(job_dir "$1")
    printf 'report.json\t%s\n' "$(base64 -w0 "$dir/report.json")"
    n=0
    for f in "$dir"/shots/*.png; do
      [[ -f "$f" && ! -L "$f" ]] || continue
      (( $(stat -c %s "$f") <= 3145728 )) || continue
      n=$((n+1)); (( n <= 12 )) || break
      printf '%s\t%s\n' "$(basename "$f")" "$(base64 -w0 "$f")"
    done
    ;;
  cleanup)
    dir=$(job_dir "$1"); rm -rf "$dir"
    ;;
  *) die 2 "unknown step" ;;
esac
