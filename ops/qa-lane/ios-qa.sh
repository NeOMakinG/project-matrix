#!/usr/bin/env bash
# Matrix agent QA lane, iOS simulator host side (the Mac mini that runs the tapflow relay + agent).
# Streamed by the Matrix host: `ssh mini@host bash -s -- <step> ...`. Every argument is validated by
# the caller AND here. Exit codes: 10 host overloaded, 11 simulator unavailable, 12 simulator busy
# (another tenant holds its lock or its tapflow session), 20 build failed, 21 install failed,
# 2 bad arguments.
# The QA agent does not run here: it runs on the Matrix host and drives the simulator through the
# tapflow relay (taps, typing, UI tree); this script builds, installs, seeds and takes screenshots.
set -euo pipefail

# Never probe /Volumes/External by default: a sleeping external disk hangs every step.
ROOT="${MATRIX_QA_ROOT:-$HOME/matrix-qa.noindex}"
# The simulator lock is SHARED with every other tenant of the mini (agents, scripts): one directory
# per simulator UDID, same protocol as ops/qa-lane/sim-lock.sh (installed on the mini as `sim-lock`).
# A holder beats at least every 5 minutes; a lock silent for STALE_S is reclaimed. A live tapflow
# session on the simulator (a person in the dashboard, tapflow-mcp, a flow run) also counts as busy.
LOCKS="${MATRIX_SIM_LOCK_DIR:-/Users/Shared/sim-lock}"
LEGACY_LOCK=/tmp/matrix-qa-ios.lock
STALE_S=1200
TENANT=matrix-qa
RELAY_WS="${MATRIX_QA_RELAY_WS:-ws://127.0.0.1:4000}"
NODE_BIN="${MATRIX_QA_NODE_BIN:-$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)}"
# Never an empty PATH entry (it would put the PR checkout's own binaries first).
[[ -n "$NODE_BIN" && -d "$NODE_BIN" ]] || { echo "no node found (set MATRIX_QA_NODE_BIN)" >&2; exit 2; }
BASE_PATH="$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH="$BASE_PATH"

die() { echo "$2" >&2; exit "$1"; }
need() { [[ "$2" =~ $3 ]] || die 2 "invalid $1"; }
job_dir() { need job "$1" '^[a-z0-9-]{8,64}$'; echo "$ROOT/jobs/$1"; }
udid_ok() { need udid "$1" '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$'; }
# The lock (if any) this job holds; steps after `lock` only know the job id. Always exits 0 (it is
# used in assignments under set -e): test its output. tapflow_state needs Node >= 22 (WebSocket).
held_lock() {
  local l
  for l in "$LOCKS"/*.lock; do
    [[ -d "$l" && "$(cat "$l/owner" 2>/dev/null || true)" == "$1" ]] && { echo "$l"; return 0; }
  done
  return 0
}
# Ownership check and heartbeat under the guard (a busy guard skips this beat; the next one counts).
beat() {
  local l
  guard || return 0
  l=$(held_lock "$1"); [[ -n "$l" ]] && write_beat "$l"
  unguard
}
# Steps that touch the shared build dir or the simulator refuse to run without the lock.
owns() { [[ -n "$(held_lock "$1")" ]] || die 12 "simulator busy: this job no longer holds its lock"; beat "$1"; }
mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || date +%s; }
# A stale lock is moved aside atomically, and only if it is still the one judged stale.
# Beats are published atomically; an unreadable beat falls back to the lock directory's age.
beat_of() { local b; b=$(cat "$1/beat" 2>/dev/null || true); [[ "$b" =~ ^[0-9]+$ ]] && echo "$b" || mtime "$1"; }
write_beat() { date +%s >"$1/beat.$$" && mv -f "$1/beat.$$" "$1/beat"; }
# Every change of a lock's owner (acquire, release, stale reclaim) happens under one guard, so a
# reclaimer never removes a lock that was released and re-acquired after it judged it stale.
guard() {
  local g="$LOCKS/.guard" n=0
  (umask 000; mkdir -p "$LOCKS")
  until mkdir "$g" 2>/dev/null; do
    (( $(date +%s) - $(mtime "$g") > 60 )) && rm -rf "$g" && continue
    (( ++n < 300 )) || return 1
    sleep 0.2
  done
}
unguard() { rm -rf "$LOCKS/.guard"; }
# Under the guard: a lock silent for STALE_S is removed. Returns 0 when it was.
reclaim_stale() {
  local l="$1"
  [[ -d "$l" ]] && (( $(date +%s) - $(beat_of "$l") > STALE_S )) || return 1
  echo "reclaimed a stale simulator lock (holder $(cat "$l/holder" 2>/dev/null || echo unknown))" >&2
  rm -rf "$l"
}
# Under the guard: create the lock with all its fields, or fail if it exists (reclaiming a stale one).
take() {
  local l="$1" owner="$2" holder="$3" tenant="$4" tmp
  reclaim_stale "$l" || true
  [[ -d "$l" ]] && return 1
  tmp="$l.new.$$"; rm -rf "$tmp"; mkdir "$tmp"
  echo "$owner" >"$tmp/owner"; echo "$holder" >"$tmp/holder"; echo "$tenant" >"$tmp/tenant"
  date +%s >"$tmp/beat"; date +%s >"$tmp/since"
  mv "$tmp" "$l"
}
# tapflow's own occupancy: free | busy | absent | error. The relay answers local sockets without a
# token. MATRIX_QA_TAPFLOW_STATE_FILE replaces the query (tests only).
tapflow_state() {
  if [[ -n "${MATRIX_QA_TAPFLOW_STATE_FILE:-}" ]]; then cat "$MATRIX_QA_TAPFLOW_STATE_FILE"; return 0; fi
  node -e '
    const [url, udid] = process.argv.slice(1);
    const done = (s) => { console.log(s); process.exit(0); };
    setTimeout(() => done("error"), 8000);
    let ws; try { ws = new WebSocket(url); } catch { done("error"); }
    ws.onerror = () => done("error");
    ws.onopen = () => ws.send(JSON.stringify({ type: "agents:list" }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type !== "agents:listed") return;
      const d = (m.sessions ?? []).flatMap((s) => s.devices ?? []).find((x) => x.id === udid);
      done(!d ? "absent" : d.busy ? "busy" : "free");
    };' "$RELAY_WS" "$1" 2>/dev/null || echo error
}
# Wait (up to $2 s) until nobody holds the simulator's tapflow session.
wait_tapflow_free() {
  local udid="$1" deadline=$(( $(date +%s) + $2 )) st
  while :; do
    st=$(tapflow_state "$udid")
    case "$st" in
      free|absent) return 0 ;;
      error) die 11 "tapflow relay unreachable on the simulator host" ;;
    esac
    (( $(date +%s) < deadline )) || die 12 "simulator busy: someone holds its tapflow session"
    sleep 15
  done
}
# Another Matrix job (any simulator) holds a lock: the build dir and build HOME are shared.
# Fails closed: without the guard the lock stays (it goes stale and is reclaimed later).
release() { guard || return 0; [[ "$(cat "$1/owner" 2>/dev/null || true)" == "$2" ]] && rm -rf "$1"; unguard; }
lane_running() {
  local l
  for l in "$LOCKS"/*.lock; do
    [[ -d "$l" && "$(cat "$l/tenant" 2>/dev/null || true)" == "$TENANT" ]] || continue
    (( $(date +%s) - $(beat_of "$l") > STALE_S )) && continue
    [[ -n "${1:-}" && "$(cat "$l/owner" 2>/dev/null || true)" == "$1" ]] && continue
    return 0
  done
  return 1
}
booted() { xcrun simctl list devices booted | grep -q "($1) (Booted)"; }

step="${1:-}"; shift || true
case "$step" in
  precheck)
    udid="$1" boot="$2" max_load_pct="$3" min_free_gb="$4"
    udid_ok "$udid"; need boot "$boot" '^[01]$'; need load "$max_load_pct" '^[0-9]{1,3}$'
    need disk "$min_free_gb" '^[0-9]{1,4}$'
    cores=$(sysctl -n hw.ncpu); load=$(sysctl -n vm.loadavg | awk '{print $2}')
    if awk -v l="$load" -v c="$cores" -v m="$max_load_pct" 'BEGIN{exit !(l*100 > c*m)}'; then
      die 10 "simulator host overloaded: load $load on $cores cores"
    fi
    mkdir -p "$ROOT"
    free_gb=$(df -g "$ROOT" | awk 'NR==2 {print $4}')
    # Leftover build output of an interrupted job is ours to drop (never while a job holds the lock).
    if (( free_gb < min_free_gb )) && ! lane_running; then
      for w in "$ROOT"/build/*; do [[ -d "$w/.git" ]] && git -C "$w" clean -qffdx; done
      free_gb=$(df -g "$ROOT" | awk 'NR==2 {print $4}')
    fi
    (( free_gb >= min_free_gb )) || die 10 "simulator host overloaded: ${free_gb} GB free, need ${min_free_gb} GB"
    xcrun simctl list devices | grep -q "($udid)" || die 11 "simulator $udid not found"
    if ! booted "$udid"; then
      [[ "$boot" == 1 ]] || die 11 "simulator $udid is not booted"
      xcrun simctl boot "$udid" 2>/dev/null || true
      xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || die 11 "simulator $udid did not boot"
    fi
    line=$(xcrun simctl list devices | grep "($udid)" | head -1)
    runtime=$(xcrun simctl list devices | awk -v u="($udid)" '/^-- /{r=$0} index($0,u){print r; exit}' | sed -E 's/^-- (.*) --$/\1/')
    echo "model=$(echo "$line" | sed -E 's/^ *(.*) \([0-9A-F-]{36}\).*/\1/' | cut -c1-60)"
    echo "os=$(echo "$runtime" | cut -c1-30)"
    echo "load=$load cores=$cores free_gb=$free_gb"
    ;;
  lock)
    job="$1" wait_s="$2" holder="$3" udid="${4:-}"
    need job "$job" '^[a-z0-9-]{8,64}$'; need wait "$wait_s" '^[0-9]{1,5}$'
    need holder "$holder" '^[A-Za-z0-9._@-]{1,64}$'; udid_ok "$udid"
    (umask 000; mkdir -p "$LOCKS")
    L="$LOCKS/$udid.lock"
    deadline=$(( $(date +%s) + wait_s ))
    while :; do
      # tapflow first (a live tester or agent), then the shared lock; mkdir is atomic.
      wait_tapflow_free "$udid" $(( deadline - $(date +%s) > 0 ? deadline - $(date +%s) : 0 ))
      guard || die 12 "simulator lock guard busy"
      if take "$L" "$job" "$holder" "$TENANT"; then
        unguard
        st=$(tapflow_state "$udid")
        # One Matrix job at a time across simulators: they share the checkout and build HOME.
        lane_running "$job" && st=lane
        case "$st" in
          free|absent) exit 0 ;;
          error) release "$L" "$job"; die 11 "tapflow relay unreachable on the simulator host" ;;
          *) release "$L" "$job" ;;
        esac
      else
        unguard
      fi
      (( $(date +%s) < deadline )) || die 12 "simulator busy (lock held by $(cat "$L/holder" 2>/dev/null || echo "a tapflow session"))"
      sleep 15
    done
    ;;
  beat)
    job="$1"; need job "$job" '^[a-z0-9-]{8,64}$'
    [[ -n "$(held_lock "$job")" ]] || die 12 "this job no longer holds the simulator lock"
    beat "$job"
    ;;
  reclaim)
    holder="$1"; need holder "$holder" '^[A-Za-z0-9._@-]{1,64}$'
    guard || die 12 "simulator lock guard busy"
    for l in "$LOCKS"/*.lock "$LEGACY_LOCK"; do
      if [[ -d "$l" && "$(cat "$l/holder" 2>/dev/null || true)" == "$holder" ]]; then
        rm -rf "$l"; echo "reclaimed the iOS lane lock of a previous $holder"
      fi
    done
    unguard
    ;;
  unlock)
    job="$1"; need job "$job" '^[a-z0-9-]{8,64}$'
    l=$(held_lock "$job"); [[ -n "$l" ]] && release "$l" "$job"
    true
    ;;
  write|append)
    dir=$(job_dir "$1") name="$2" data="$3"
    need name "$name" '^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$'; need data "$data" '^[A-Za-z0-9+/=]*$'
    beat "$1"; mkdir -p "$dir/out/shots"
    if [[ "$step" == write ]]; then printf %s "$data" | base64 -D >"$dir/$name"
    else printf %s "$data" | base64 -D >>"$dir/$name"; fi
    ;;
  build)
    # The build command (build.sh, operator-trusted, from the lane config) runs in the PR checkout
    # with a cleared environment; it must leave the simulator .app at the configured path.
    job="$1" dir=$(job_dir "$1") repo="$2" pr="$3" sha="$4" timeout_s="$5" app_id="$6" sandbox="${7:-1}"
    need sandbox "$sandbox" '^[01]$'

    need repo "$repo" '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$'; need pr "$pr" '^[0-9]{1,9}$'
    need sha "$sha" '^[a-f0-9]{40}$'; need timeout "$timeout_s" '^[0-9]{2,4}$'
    need app_id "$app_id" '^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$'
    (( timeout_s <= 5400 )) || die 2 "timeout above the lock's stale limit"
    owns "$1"
    # A build of an earlier job whose lock is gone (server restart, reclaimed) is stopped first: the
    # checkout and build HOME are shared. One whose job still holds its lock means busy.
    for p in "$ROOT"/jobs/*/build.pid; do
      [[ -f "$p" ]] || continue
      other=$(basename "$(dirname "$p")"); [[ "$other" == "$1" ]] && continue
      op=$(cat "$p" 2>/dev/null || true)
      [[ "$op" =~ ^[0-9]+$ ]] && kill -0 "$op" 2>/dev/null || continue
      [[ -n "$(held_lock "$other")" ]] && die 12 "another Matrix build is running"
      kill -TERM "$op" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do kill -0 "$op" 2>/dev/null || break; sleep 5; done
      kill -0 "$op" 2>/dev/null && die 12 "an earlier Matrix build did not stop"
    done
    mirror="$ROOT/mirrors/${repo/\//__}.git" work="$ROOT/build/${repo/\//__}"
    mkdir -p "$ROOT/mirrors" "$ROOT/build" "$ROOT/build-home/tmp"
    cat >"$dir/build.sb" <<SB
(version 1)
(allow default)
(deny file-read* file-write*
  (subpath "$HOME/.ssh") (subpath "$HOME/.config") (subpath "$HOME/.gnupg") (subpath "$HOME/.aws")
  (subpath "$HOME/Library/Keychains") (subpath "$HOME/.tapflow") (literal "$HOME/.secrets")
  (literal "$HOME/.gitconfig") (literal "$HOME/.netrc") (literal "$HOME/.npmrc")
  (subpath "$HOME/Documents") (subpath "$HOME/Desktop") (subpath "$HOME/Projects") (subpath "$ROOT/mirrors")
  (subpath "$ROOT/jobs"))
(allow file-read* (literal "$dir/build.sh"))
; Writes: allow-list only (no dotfiles, LaunchAgents or other persistence outside the build).
(deny file-write*)
(allow file-write* (subpath "$work") (subpath "$ROOT/build-home") (subpath "/private/tmp")
  (subpath "/private/var/folders") (subpath "/dev") (subpath "$HOME/Library/Caches")
  (subpath "$HOME/Library/Developer/Xcode/DerivedData") (subpath "$HOME/Library/Logs")
  (subpath "$HOME/Library/org.swift.swiftpm") (subpath "$HOME/.swiftpm")
  (regex #"^$HOME/Library/Preferences/com\.apple\.dt\.")
  (regex #"^$HOME/Library/Developer/Xcode/(UserData|Products|iOS DeviceSupport)/")
  (literal "$dir/build.log"))
(allow file-read* (literal "$dir/build.log"))
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc"))
SB
    set +e
    (
      set -e
      [[ -d "$mirror" ]] || git init --quiet --bare "$mirror"
      git --git-dir "$mirror" -c credential.helper= -c "credential.helper=!gh auth git-credential" \
        fetch --quiet "https://github.com/$repo.git" "+refs/pull/$pr/head:refs/matrix/pr-$pr"
      [[ "$(git --git-dir "$mirror" rev-parse "refs/matrix/pr-$pr")" == "$sha" ]] \
        || { echo "PR head moved: $(git --git-dir "$mirror" rev-parse "refs/matrix/pr-$pr") != $sha"; exit 3; }
      [[ -d "$work/.git" ]] || git init --quiet "$work"
      cd "$work"
      # LFS objects are not in the bare mirror: check out pointers, then pull them from GitHub.
      export GIT_LFS_SKIP_SMUDGE=1
      git fetch --quiet --no-tags "file://$mirror" "$sha"
      git checkout --quiet --force --detach "$sha"; git clean -qffdx
      if git lfs version >/dev/null 2>&1 && [[ -f .gitattributes ]] && grep -q "filter=lfs" .gitattributes; then
        git -c credential.helper= -c "credential.helper=!gh auth git-credential" \
          -c "lfs.url=https://github.com/$repo.git/info/lfs" lfs pull \
          || echo "warning: some LFS objects are missing upstream; their pointer files stay"
      fi
      unset GIT_LFS_SKIP_SMUDGE
      git log -1 --format="commit %H %s"
      # PR code (npm scripts, config plugins, pods, build phases) runs under a Seatbelt profile that
      # denies this account's credentials (gh, ssh, keychains, secrets) and its other files; HOME
      # is a build-only dir. macOS has no timeout(1): perl's alarm ends the build past the limit.
      bhome="$ROOT/build-home"; mkdir -p "$bhome"
      sb=(sandbox-exec -f "$dir/build.sb")
      # Xcode runs coremlc, macro plugins and SwiftPM manifests under their own sandbox, which
      # cannot nest: projects using them need sandbox 0 (operator choice, see docs).
      [[ "$sandbox" == 1 ]] || sb=()
      ${sb[@]+"${sb[@]}"} env -i HOME="$bhome" PATH="$BASE_PATH" LANG=en_US.UTF-8 TMPDIR="$bhome/tmp" \
        APP_ID="$app_id" BUILD_NUMBER="$(( $(date +%s) / 60 ))" CP_HOME_DIR="$bhome/.cocoapods" \
        perl -e '$t = shift; $pid = fork // die; if (!$pid) { setpgrp(0, 0); exec @ARGV or exit 127 }
          $SIG{ALRM} = sub { kill "KILL", -$pid; exit 124 }; $SIG{TERM} = sub { kill "KILL", -$pid; exit 143 };
          alarm $t; waitpid($pid, 0); kill "KILL", -$pid; exit($? >> 8)' "$timeout_s" nice bash "$dir/build.sh" </dev/null &
      bpid=$!
      echo "$bpid" >"$dir/build.pid"
      # Fence: the build beats the lock itself, and is killed if the lock is ever lost (reclaimed
      # by another tenant), so it never writes the shared build dir without owning it.
      ( while kill -0 "$bpid" 2>/dev/null; do
          if [[ -z "$(held_lock "$job")" ]]; then echo "lock lost: stopping the build"; kill -TERM "$bpid"; exit 0; fi
          beat "$job"; sleep 30
        done ) </dev/null &
      wait "$bpid"
    ) >"$dir/build.log" 2>&1
    rc=$?
    set -e
    if (( rc != 0 )); then
      # The first real errors, not the tail of build-phase notes.
      cp -f "$dir/build.log" "$ROOT/last-build-failure.log" || true
      { grep -E "(^|[[:space:]]|: )error: |nonzero exit code|BUILD FAILED|npm ERR!|ERR_PNPM|^Error: " "$dir/build.log" | grep -v "^\*\* BUILD FAILED" | head -8 || true
        tail -c 600 "$dir/build.log"; } 2>/dev/null | cut -c1-300 >&2 || true
      exit 20
    fi
    echo "$work" >"$dir/src"
    ;;
  install)
    dir=$(job_dir "$1") udid="$2" app_glob="$3" app_id="$4"
    udid_ok "$udid"; need app "$app_glob" '^[A-Za-z0-9._/*-]{1,200}$'
    [[ "$app_glob" != *..* && "$app_glob" != /* ]] || die 2 "invalid app"
    need app_id "$app_id" '^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$'
    owns "$1"
    work=$(cat "$dir/src")
    app=$(cd "$work" && compgen -G "$app_glob" | head -1 || true)
    [[ -n "$app" && -d "$work/$app" ]] || die 21 "no simulator .app at $app_glob"
    plist="$work/$app/Info.plist"
    got=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")
    [[ "$got" == "$app_id" ]] || die 21 "built bundle id $got, expected $app_id"
    # The build ran for a while: a person or agent may have taken the simulator through tapflow
    # since. Never install over a live session; wait for it (bounded), else report busy.
    wait_tapflow_free "$udid" 600
    owns "$1"
    # The shared simulator may have been shut down during the build: bring it back once.
    if ! booted "$udid"; then
      xcrun simctl boot "$udid" 2>/dev/null || true
      xcrun simctl bootstatus "$udid" -b >/dev/null 2>&1 || die 11 "simulator $udid did not boot"
    fi
    # Install over the existing app (keeps its data); never uninstall or erase the simulator.
    xcrun simctl terminate "$udid" "$app_id" >/dev/null 2>&1 || true
    xcrun simctl install "$udid" "$work/$app" 2>"$dir/install.log" || { tail -c 800 "$dir/install.log" >&2; exit 21; }
    xcrun simctl launch "$udid" "$app_id" >/dev/null 2>&1 || die 21 "app did not launch"
    sleep 10
    mkdir -p "$dir/out/shots"
    xcrun simctl io "$udid" screenshot --type=png "$dir/out/shots/00-launch.png" >/dev/null 2>&1 || true
    v=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist" 2>/dev/null || echo "?")
    b=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist" 2>/dev/null || echo "?")
    echo "$v ($b)"
    ;;
  seed)
    # Photos into the simulator library once per fixture set (addmedia would duplicate them).
    dir=$(job_dir "$1") udid="$2" set_id="$3"
    udid_ok "$udid"; need set "$set_id" '^[a-z0-9-]{1,40}-[a-f0-9]{12}$'
    owns "$1"
    marker="$ROOT/seeded/$udid-$set_id"
    if [[ -f "$marker" ]]; then echo "fixtures $set_id already on $udid"; exit 0; fi
    files=("$dir"/fx-*)
    [[ -e "${files[0]}" ]] || die 2 "no fixtures written"
    xcrun simctl addmedia "$udid" "${files[@]}" >/dev/null 2>&1 || die 11 "addmedia failed"
    mkdir -p "$ROOT/seeded"; date >"$marker"
    echo "seeded ${#files[@]} files ($set_id) on $udid"
    ;;
  shot)
    # One screenshot as base64 on stdout (the agent's evidence; it never gets a shell here).
    udid="$1"; udid_ok "$udid"
    tmpd=$(mktemp -d -t mxshot); tmp="$tmpd/shot.png"; trap 'rm -rf "$tmpd"' EXIT
    xcrun simctl io "$udid" screenshot --type=png "$tmp" >/dev/null 2>&1 || { rm -rf "$tmpd"; die 11 "screenshot failed"; }
    base64 -i "$tmp"; rm -rf "$tmpd"
    ;;
  collect)
    dir=$(job_dir "$1")
    for f in "$dir"/out/shots/*.png; do
      [[ -f "$f" ]] || continue
      (( $(stat -f %z "$f") <= 3145728 )) || continue
      printf '%s\t%s\n' "$(basename "$f")" "$(base64 -i "$f" | tr -d '\n')"
    done
    ;;
  cleanup)
    # Build output (node_modules, Pods, DerivedData) is rebuilt from scratch each job anyway:
    # drop it so the shared Mac keeps its disk.
    dir=$(job_dir "$1")
    # A build still running (its SSH step timed out) is stopped before anything else.
    op=$(cat "$dir/build.pid" 2>/dev/null || true)
    if [[ "$op" =~ ^[0-9]+$ ]] && kill -0 "$op" 2>/dev/null; then
      kill -TERM "$op" 2>/dev/null || true
      for _ in 1 2 3 4 5 6; do kill -0 "$op" 2>/dev/null || break; sleep 5; done
    fi
    # Only while this job still holds its lock: the build dir is shared (a job that lost it leaves
    # the output to the next precheck).
    if [[ -f "$dir/src" && -n "$(held_lock "$1")" ]]; then
      w=$(cat "$dir/src"); [[ "$w" == "$ROOT/build/"* && -d "$w/.git" ]] && git -C "$w" clean -qffdx
    fi
    rm -rf "$dir"
    ;;
  *) die 2 "unknown step $step" ;;
esac
