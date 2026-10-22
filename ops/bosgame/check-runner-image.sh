#!/usr/bin/env bash
set -euo pipefail
image="${1:?runner image required}"
shift
[[ $# -gt 0 ]] || { echo 'Explicit stack tools required' >&2; exit 1; }
[[ "$(podman info --format '{{.Host.Security.Rootless}}')" == true ]] || exit 1
for tool in "$@"; do
  [[ "$tool" =~ ^[a-z][a-z0-9_-]*$ ]] || exit 1
done
podman run --rm --network=none --userns=keep-id --cap-drop=all \
  --security-opt=no-new-privileges --read-only --memory=512m --cpus=1 --pids-limit=64 \
  --tmpfs=/tmp:rw,size=64m --tmpfs=/home/agent:rw,size=64m --env HOME=/home/agent \
  "$image" sh -eu -c '
    for tool do
      command -v "$tool" >/dev/null || { echo "Missing required stack tool: $tool" >&2; exit 127; }
      case "$tool" in go|sqlc) "$tool" version;; git|node|bun|codex|claude|cargo|rustc|python3) "$tool" --version;; *) echo "Required executable present: $tool";; esac
    done
    if command -v bun >/dev/null; then test "$(bun --version)" = 1.3.9; fi
  ' matrix-preflight "$@"
