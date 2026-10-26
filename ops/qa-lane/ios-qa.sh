#!/usr/bin/env bash
# Matrix agent QA lane, iOS simulator host side (the Mac mini that runs the tapflow relay + agent).
# Streamed by the Matrix host: `ssh mini@host bash -s -- <step> ...`. Every argument is validated by
# the caller AND here. Exit codes: 10 host overloaded, 11 simulator unavailable, 12 lane busy,
# 20 build failed, 21 install failed, 2 bad arguments.
# The QA agent does not run here: it runs on the Matrix host and drives the simulator through the
# tapflow relay (taps, typing, UI tree); this script builds, installs, seeds and takes screenshots.
set -euo pipefail

# Never probe /Volumes/External by default: a sleeping external disk hangs every step.
ROOT="${MATRIX_QA_ROOT:-$HOME/matrix-qa.noindex}"
LOCK=/tmp/matrix-qa-ios.lock
STALE_S=7200
NODE_BIN="${MATRIX_QA_NODE_BIN:-$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)}"
BASE_PATH="$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH="$BASE_PATH"

die() { echo "$2" >&2; exit "$1"; }
need() { [[ "$2" =~ $3 ]] || die 2 "invalid $1"; }
job_dir() { need job "$1" '^[a-z0-9-]{8,64}$'; echo "$ROOT/jobs/$1"; }
udid_ok() { need udid "$1" '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$'; }
beat() { [[ "$(cat "$LOCK/owner" 2>/dev/null || true)" == "$1" ]] && date +%s >"$LOCK/beat"; true; }
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
    if (( free_gb < min_free_gb )) && [[ ! -d "$LOCK" ]]; then
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
    job="$1" wait_s="$2" holder="$3"
    need job "$job" '^[a-z0-9-]{8,64}$'; need wait "$wait_s" '^[0-9]{1,5}$'
    need holder "$holder" '^[A-Za-z0-9._@-]{1,64}$'
    deadline=$(( $(date +%s) + wait_s ))
    while :; do
      # mkdir is atomic; a lock without its beat yet is fresh (its directory time stands in).
      if mkdir "$LOCK" 2>/dev/null; then
        echo "$job" >"$LOCK/owner"; echo "$holder" >"$LOCK/holder"; date +%s >"$LOCK/beat"; exit 0
      fi
      last=$(cat "$LOCK/beat" 2>/dev/null || stat -f %m "$LOCK" 2>/dev/null || date +%s)
      if (( $(date +%s) - last > STALE_S )); then rm -rf "$LOCK"; continue; fi
      (( $(date +%s) < deadline )) || die 12 "simulator lane busy (held by $(cat "$LOCK/holder" 2>/dev/null || echo unknown))"
      sleep 15
    done
    ;;
  reclaim)
    holder="$1"; need holder "$holder" '^[A-Za-z0-9._@-]{1,64}$'
    if [[ "$(cat "$LOCK/holder" 2>/dev/null || true)" == "$holder" ]]; then
      rm -rf "$LOCK"; echo "reclaimed the iOS lane lock of a previous $holder"
    fi
    ;;
  unlock)
    job="$1"; need job "$job" '^[a-z0-9-]{8,64}$'
    [[ "$(cat "$LOCK/owner" 2>/dev/null || true)" == "$job" ]] && rm -rf "$LOCK"
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
    dir=$(job_dir "$1") repo="$2" pr="$3" sha="$4" timeout_s="$5" app_id="$6"
    need repo "$repo" '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$'; need pr "$pr" '^[0-9]{1,9}$'
    need sha "$sha" '^[a-f0-9]{40}$'; need timeout "$timeout_s" '^[0-9]{2,4}$'
    need app_id "$app_id" '^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$'
    (( timeout_s <= 5400 )) || die 2 "timeout above the lock's stale limit"
    beat "$1"
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
      sandbox-exec -f "$dir/build.sb" env -i HOME="$bhome" PATH="$BASE_PATH" LANG=en_US.UTF-8 TMPDIR="$bhome/tmp" \
        APP_ID="$app_id" BUILD_NUMBER="$(( $(date +%s) / 60 ))" CP_HOME_DIR="$bhome/.cocoapods" \
        perl -e '$t = shift; $pid = fork // die; if (!$pid) { setpgrp(0, 0); exec @ARGV or exit 127 }
          $SIG{ALRM} = sub { kill "KILL", -$pid; exit 124 }; alarm $t; waitpid($pid, 0);
          kill "KILL", -$pid; exit($? >> 8)' "$timeout_s" nice bash "$dir/build.sh" </dev/null
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
    beat "$1"
    work=$(cat "$dir/src")
    app=$(cd "$work" && compgen -G "$app_glob" | head -1 || true)
    [[ -n "$app" && -d "$work/$app" ]] || die 21 "no simulator .app at $app_glob"
    plist="$work/$app/Info.plist"
    got=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")
    [[ "$got" == "$app_id" ]] || die 21 "built bundle id $got, expected $app_id"
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
    beat "$1"
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
    if [[ -f "$dir/src" ]]; then w=$(cat "$dir/src"); [[ "$w" == "$ROOT/build/"* && -d "$w/.git" ]] && git -C "$w" clean -qffdx; fi
    rm -rf "$dir"
    ;;
  *) die 2 "unknown step $step" ;;
esac
