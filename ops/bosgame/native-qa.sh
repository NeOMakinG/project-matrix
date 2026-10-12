#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(uname -s)" == Linux ]] || { echo 'Coordinator must run native QA on bosgame, never on Mac' >&2; exit 1; }
: "${MATRIX_GATEWAY_URL:?existing CLIProxyAPI URL required}"
: "${MATRIX_GATEWAY_KEY_FILE:?existing broker credential file required}"
[[ "$(stat -c %a "$MATRIX_GATEWAY_KEY_FILE")" == 600 ]] || { echo 'Credential file must retain mode 600' >&2; exit 1; }
mkdir -p "$HOME/.matrix"
exec 9>"$HOME/.matrix/integration-heavy.lock"
flock -n 9 || { echo 'Another Matrix heavy task is active' >&2; exit 1; }
cores="$(getconf _NPROCESSORS_ONLN)"
awk -v cores="$cores" '{ if ($1 >= cores) exit 1 }' /proc/loadavg || exit 1
awk '/MemAvailable:/ { if ($2 < 4194304) exit 1; found=1 } END { if (!found) exit 1 }' /proc/meminfo || exit 1
repo="$(cd "$(dirname "$0")/../.." && pwd)"
image="${MATRIX_RUNNER_IMAGE:-matrix-runner:dev}"
bash "$repo/ops/bosgame/check-runner-image.sh" "$image" git codex node bun
"${MATRIX_GITLEAKS:-gitleaks}" version >/dev/null
export MATRIX_NATIVE_QA_OUTPUT="${MATRIX_NATIVE_QA_OUTPUT:-$HOME/.matrix/native-qa-receipts}"
"${MATRIX_BUN_BINARY:-$HOME/.bun/bin/bun}" "$repo/apps/server/src/integration/native-qa.ts"
