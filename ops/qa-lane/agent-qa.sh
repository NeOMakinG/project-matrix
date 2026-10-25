#!/usr/bin/env bash
# Matrix agent QA lane, device-host side. Streamed by the Matrix host: `ssh host bash -s -- <step> ...`.
# Every argument is validated by the caller AND here. Exit codes: 10 host overloaded, 11 device
# unavailable, 12 lane busy, 20 build failed, 21 install failed, 30 agent failed, 2 bad arguments.
set -euo pipefail

# Builds and the QA agent run as this unprivileged user: PR code and the agent never see root's
# credentials (gh, Infisical). Create it once: `useradd --create-home matrixqa`.
QA_USER="${MATRIX_QA_USER:-matrixqa}"
ROOT="${MATRIX_QA_ROOT:-/srv/matrix-qa}"
LOCK=/tmp/matrix-qa-lane.lock
STALE_S=7200
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}" ANDROID_SDK_ROOT="${ANDROID_HOME:-/opt/android-sdk}"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

die() { echo "$2" >&2; exit "$1"; }
need() { [[ "$2" =~ $3 ]] || die 2 "invalid $1"; }
job_dir() { need job "$1" '^[a-z0-9-]{8,64}$'; echo "$ROOT/jobs/$1"; }
# Owner-only heartbeat: every step of the lock holder refreshes it, so a live job never goes stale.
beat() { [[ "$(cat "$LOCK/owner" 2>/dev/null || true)" == "$1" ]] && date +%s >"$LOCK/beat"; true; }
as_qa() { runuser -u "$QA_USER" -- env -i HOME="/home/$QA_USER" PATH="/usr/local/bin:/usr/bin:/bin:$ANDROID_HOME/platform-tools" \
  ANDROID_HOME="$ANDROID_HOME" ANDROID_SDK_ROOT="$ANDROID_HOME" LANG=C.UTF-8 "$@"; }

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
    [[ "$(cat "$LOCK/owner" 2>/dev/null || true)" == "$job" ]] && rm -rf "$LOCK"
    true
    ;;
  write)
    dir=$(job_dir "$1"); name="$2"; need name "$name" '^[a-z][a-z0-9._-]{0,40}$'
    beat "$1"; mkdir -p "$dir/shots"; printf %s "$3" | base64 -d >"$dir/$name"; chown -R "$QA_USER:" "$dir"
    ;;
  build)
    dir=$(job_dir "$1") repo="$2" pr="$3" sha="$4" abi="$5" timeout_s="$6"
    need repo "$repo" '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$'; need pr "$pr" '^[0-9]{1,9}$'
    need sha "$sha" '^[a-f0-9]{40}$'; need abi "$abi" '^(arm64-v8a|x86_64|armeabi-v7a|x86)$'
    need timeout "$timeout_s" '^[0-9]{2,5}$'
    beat "$1"
    # The clone is fetched with root's gh credential, then owned by the QA user: the build never
    # runs as root and the checkout holds no credential (https remote, no stored token).
    src="$ROOT/repos/${repo/\//__}"; mkdir -p "$ROOT/repos" "$dir"
    {
      [[ -d "$src/.git" ]] || git clone --quiet --filter=blob:none "https://github.com/$repo.git" "$src"
      cd "$src"
      git -c credential.helper= -c "credential.helper=!gh auth git-credential" fetch --quiet origin "pull/$pr/head"
      [[ "$(git rev-parse FETCH_HEAD)" == "$sha" ]] || { echo "PR head moved: $(git rev-parse FETCH_HEAD) != $sha"; exit 3; }
      git checkout --quiet --force --detach "$sha"
      git clean -qfdx -e node_modules
      git log -1 --format='commit %H %s'
      chown -R "$QA_USER:" "$src" "$dir"
      cd "$src" && as_qa ABI="$abi" NODE_ENV=production timeout "$timeout_s" nice bash "$dir/build.sh"
    } >"$dir/build.log" 2>&1 || { tail -c 1500 "$dir/build.log" >&2; exit 20; }
    echo "$src" >"$dir/src"
    ;;
  install)
    dir=$(job_dir "$1") serial="$2" apk="$3" app="$4"
    need serial "$serial" '^[A-Za-z0-9._:-]{1,64}$'; need apk "$apk" '^[A-Za-z0-9._/-]{1,200}$'
    need app "$app" '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
    [[ "$apk" != *..* ]] || die 2 "invalid apk"
    beat "$1"; src=$(cat "$dir/src"); [[ -f "$src/$apk" ]] || die 21 "build produced no APK at $apk"
    adb -s "$serial" install -r -g "$src/$apk" >"$dir/install.log" 2>&1 || { tail -c 500 "$dir/install.log" >&2; exit 21; }
    adb -s "$serial" shell dumpsys package "$app" | sed -n 's/^ *versionName=//p' | head -1
    ;;
  agent)
    dir=$(job_dir "$1") model="$2" timeout_s="$3" serial="$4"
    need model "$model" '^[a-z0-9.-]{3,60}$'; need timeout "$timeout_s" '^[0-9]{2,5}$'
    need serial "$serial" '^[A-Za-z0-9._:-]{1,64}$'
    beat "$1"
    mkdir -p "$dir/.claude" "$dir/shots"
    # Only these tools, only inside the job dir: the user's broad settings are not loaded.
    cat >"$dir/.claude/settings.json" <<'JSON'
{"permissions":{"allow":["Bash(agent-device:*)","Bash(adb:*)","Read(./**)","Write(./**)","Glob(./**)"],"deny":["WebFetch","WebSearch","Agent","Task"],"defaultMode":"default"}}
JSON
    chown -R "$QA_USER:" "$dir"
    cd "$dir"
    # Root resolves only the gateway key from Infisical; the agent runs as the QA user with a
    # cleared environment holding that key alone (no other secret, no gh, no root files).
    secrets run -- sh -c '
      exec env -i HOME="/home/$1" PATH="/usr/local/bin:/usr/bin:/bin:$4" LANG=C.UTF-8 ANDROID_SERIAL="$3" \
        ANTHROPIC_BASE_URL="${MATRIX_QA_GATEWAY:-http://127.0.0.1:8317}" ANTHROPIC_AUTH_TOKEN="$CLIPROXY_API_KEY" \
        runuser -u "$1" -- timeout "$5" claude -p --model "$2" --setting-sources project --strict-mcp-config \
          --allowedTools "Bash(agent-device:*)" "Bash(adb:*)" "Read(./**)" "Write(./**)" "Glob(./**)" \
          --disallowedTools WebFetch WebSearch Agent Task' \
      sh "$QA_USER" "$model" "$serial" "$ANDROID_HOME/platform-tools" "$timeout_s" \
      <"$dir/prompt.md" >"$dir/agent.log" 2>&1 || { tail -c 800 "$dir/agent.log" >&2; exit 30; }
    [[ -s "$dir/report.json" && ! -L "$dir/report.json" ]] || die 30 "QA agent wrote no report.json"
    ;;
  collect)
    dir=$(job_dir "$1"); beat "$1"
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
