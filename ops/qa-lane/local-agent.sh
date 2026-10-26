#!/usr/bin/env bash
# Matrix agent QA lane: runs the QA agent ON THE MATRIX HOST for the iOS (tapflow) and web (Chrome)
# drivers. Usage: local-agent.sh <job-dir> <ios|web> <model> <timeout-s>
# The job dir holds prompt.md and the mode's tool wrapper (./qa-shot or ./qa-browser); the agent
# reads only the job dir, writes only out/, and runs with a cleared environment: HOME is a
# throwaway dir under the job (no user config, no ~/.claude), the gateway key is the only secret
# for web, plus the tapflow relay token for iOS (used by ./qa-ios, locked to one simulator).
# Exit codes: 2 bad arguments, 30 agent failed.
set -euo pipefail
die() { echo "$2" >&2; exit "$1"; }
dir="$1" mode="$2" model="$3" timeout_s="$4"
[[ "$dir" =~ ^/[A-Za-z0-9._/-]+/mx-[a-z0-9-]{8,40}$ && "$dir" != *..* && -d "$dir" ]] || die 2 "invalid job dir"
[[ "$mode" =~ ^(ios|web)$ ]] || die 2 "invalid mode"
[[ "$model" =~ ^[a-z0-9.-]{3,60}$ ]] || die 2 "invalid model"
[[ "$timeout_s" =~ ^[0-9]{2,4}$ ]] || die 2 "invalid timeout"
CLAUDE="${MATRIX_QA_CLAUDE:-$HOME/.local/bin/claude}"
SECRETS="${MATRIX_QA_SECRETS:-$HOME/.local/bin/secrets}"
GATEWAY="${MATRIX_QA_GATEWAY:-http://100.90.255.43:8317}"
NODE_DIR="${MATRIX_QA_NODE_DIR:-$(dirname "$(command -v node || echo /usr/bin/node)")}"

common_allow=('Read(./**)' 'Edit(./out/**)' 'Write(./out/**)')
deny=(WebFetch WebSearch Agent Task 'Bash(curl:*)' 'Bash(ssh:*)')
if [[ "$mode" == ios ]]; then
  [[ -x "$dir/qa-shot" && -x "$dir/qa-ios" ]] || die 2 "missing qa-shot/qa-ios"
  allow=("Bash(./qa-ios:*)" "Bash(./qa-shot:*)")
  mcp=()
else
  [[ -x "$dir/qa-browser" ]] || die 2 "missing qa-browser"
  allow=("Bash(./qa-browser:*)")
  mcp=()
fi
allow+=("${common_allow[@]}")
mkdir -p "$dir/home" "$dir/out/shots" "$dir/.claude"
python3 - "$dir" "${allow[@]}" -- "${deny[@]}" <<'PY'
import json, os, sys
d = sys.argv[1]; rest = sys.argv[2:]; i = rest.index("--")
allow, deny = rest[:i], rest[i + 1:]
json.dump({"permissions": {"allow": allow, "deny": deny, "defaultMode": "default"}},
          open(os.path.join(d, ".claude", "settings.json"), "w"))
# The throwaway HOME trusts this job dir only, so the allow/deny list above is honoured.
json.dump({"projects": {d: {"hasTrustDialogAccepted": True}}, "hasCompletedOnboarding": True},
          open(os.path.join(d, "home", ".claude.json"), "w"))
PY
cd "$dir"
# `secrets run` resolves the keys; the agent's env is rebuilt from scratch with those alone.
timeout -k 30 $((timeout_s + 120)) "$SECRETS" run -- bash -c '
  dir="$1" model="$2" timeout_s="$3" gateway="$4" claude="$5" path="$6" mode="$7"; shift 7
  extra=()
  [[ -n "${TAPFLOW_TOKEN:-}" && "$mode" == ios ]] && extra=(TAPFLOW_RELAY_WS="$TAPFLOW_RELAY_WS" TAPFLOW_TOKEN="$TAPFLOW_TOKEN")
  exec env -i HOME="$dir/home" TMPDIR="$dir/home" PATH="$path:/usr/local/bin:/usr/bin:/bin" LANG=C.UTF-8 \
    ANTHROPIC_BASE_URL="$gateway" ANTHROPIC_AUTH_TOKEN="$CLIPROXY_API_KEY" "${extra[@]}" \
    timeout -k 30 "$timeout_s" "$claude" -p --model "$model" --setting-sources project --strict-mcp-config "$@"' \
  bash "$dir" "$model" "$timeout_s" "$GATEWAY" "$CLAUDE" "$NODE_DIR" "$mode" "${mcp[@]}" \
    --allowedTools "${allow[@]}" --disallowedTools "${deny[@]}" \
  <"$dir/prompt.md" >"$dir/agent.log" 2>&1 || { tail -c 800 "$dir/agent.log" >&2; exit 30; }
