#!/usr/bin/env bash
# sim-lock: cooperative lock for the shared iOS simulators on the Mac mini (tapflow host).
# Installed on the mini as ~/.local/bin/sim-lock. Same protocol as the Matrix iOS QA lane
# (ops/qa-lane/ios-qa.sh): one directory per simulator UDID under /Users/Shared/sim-lock, holding
# owner (a token), holder, tenant, beat (epoch seconds) and since. mkdir is the atomic acquire.
# A holder beats at least every 5 minutes; a lock silent for 20 minutes is stale and reclaimed.
# A live tapflow session on the simulator (dashboard tester, tapflow-mcp, flow run) also counts
# as busy: acquire waits for it.
#
#   sim-lock acquire <udid> <holder> [wait_s=1200] [tenant=agent]   prints the token; exit 12 busy
#   sim-lock beat    <udid> <token>
#   sim-lock release <udid> <token>
#   sim-lock status  [udid]
#   sim-lock run     <udid> <holder> <wait_s> -- <command...>   acquire, beat while it runs, release
set -euo pipefail
LOCKS="${MATRIX_SIM_LOCK_DIR:-/Users/Shared/sim-lock}"
STALE_S=1200
RELAY_WS="${MATRIX_QA_RELAY_WS:-ws://127.0.0.1:4000}"
NODE_BIN="${MATRIX_QA_NODE_BIN:-$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)}"
[[ -n "$NODE_BIN" && -d "$NODE_BIN" ]] && PATH="$NODE_BIN:$PATH"

die() { echo "$2" >&2; exit "$1"; }
need() { [[ "$2" =~ $3 ]] || die 2 "invalid $1"; }
udid_ok() { need udid "$1" '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$'; }
mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || date +%s; }

reclaim_stale() {
  local l="$1" owner last tomb
  owner=$(cat "$l/owner" 2>/dev/null || true)
  last=$(cat "$l/beat" 2>/dev/null || mtime "$l")
  (( $(date +%s) - last > STALE_S )) || return 1
  tomb="$l.stale.$$.$RANDOM"
  mv "$l" "$tomb" 2>/dev/null || return 0
  if [[ "$(cat "$tomb/owner" 2>/dev/null || true)" != "$owner" ]]; then mv "$tomb" "$l" 2>/dev/null || true; return 0; fi
  echo "reclaimed a stale simulator lock (holder $(cat "$tomb/holder" 2>/dev/null || echo unknown))" >&2
  rm -rf "$tomb"
}

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

acquire() {
  local udid="$1" holder="$2" wait_s="${3:-1200}" tenant="${4:-agent}" L token deadline st
  udid_ok "$udid"; need holder "$holder" '^[A-Za-z0-9._@-]{1,64}$'; need wait "$wait_s" '^[0-9]{1,5}$'
  need tenant "$tenant" '^[a-z0-9-]{1,32}$'
  (umask 000; mkdir -p "$LOCKS")
  L="$LOCKS/$udid.lock"; token="$tenant-$(date +%s)-$$-$RANDOM"
  deadline=$(( $(date +%s) + wait_s ))
  while :; do
    st=$(tapflow_state "$udid")
    # An unreachable relay cannot report a tester: the lock alone decides then.
    if [[ "$st" != busy ]]; then
      if mkdir "$L" 2>/dev/null; then
        echo "$token" >"$L/owner"; echo "$holder" >"$L/holder"; echo "$tenant" >"$L/tenant"
        date +%s >"$L/beat"; date +%s >"$L/since"
        if [[ "$(tapflow_state "$udid")" == busy ]]; then rm -rf "$L"
        else echo "$token"; return 0; fi
      else
        reclaim_stale "$L" && continue
      fi
    fi
    (( $(date +%s) < deadline )) || die 12 "simulator $udid busy (lock: $(cat "$L/holder" 2>/dev/null || echo none), tapflow: $st)"
    sleep 15
  done
}

owned() { [[ "$(cat "$LOCKS/$1.lock/owner" 2>/dev/null || true)" == "$2" ]]; }

cmd="${1:-}"; shift || true
case "$cmd" in
  acquire) acquire "$@" ;;
  beat)
    udid_ok "${1:-}"; owned "$1" "${2:-}" || die 12 "not the holder of $1"
    date +%s >"$LOCKS/$1.lock/beat"
    ;;
  release)
    udid_ok "${1:-}"; owned "$1" "${2:-}" && rm -rf "$LOCKS/$1.lock"
    true
    ;;
  status)
    for l in "$LOCKS"/*.lock; do
      [[ -d "$l" ]] || continue
      u=$(basename "$l" .lock); [[ -z "${1:-}" || "$u" == "$1" ]] || continue
      age=$(( $(date +%s) - $(cat "$l/beat" 2>/dev/null || mtime "$l") ))
      echo "$u held by $(cat "$l/holder" 2>/dev/null || echo ?) ($(cat "$l/tenant" 2>/dev/null || echo ?)), last beat ${age}s ago$( (( age > STALE_S )) && echo ", stale")"
    done
    if [[ -n "${1:-}" ]]; then udid_ok "$1"; echo "$1 tapflow: $(tapflow_state "$1")"; fi
    ;;
  run)
    udid="${1:-}" holder="${2:-}" wait_s="${3:-}"; shift 3 || die 2 "usage: sim-lock run <udid> <holder> <wait_s> -- <command...>"
    [[ "${1:-}" == "--" ]] && shift
    (( $# > 0 )) || die 2 "no command"
    token=$(acquire "$udid" "$holder" "$wait_s")
    ( while sleep 240; do owned "$udid" "$token" || exit 0; date +%s >"$LOCKS/$udid.lock/beat"; done ) &
    beater=$!
    rc=0; "$@" || rc=$?
    kill "$beater" 2>/dev/null || true
    owned "$udid" "$token" && rm -rf "$LOCKS/$udid.lock"
    exit "$rc"
    ;;
  *) die 2 "usage: sim-lock acquire|beat|release|status|run (see the header of this script)" ;;
esac
