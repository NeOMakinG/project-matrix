#!/usr/bin/env bash
# Verify rootless Podman isolation on bosgame. No sudo.
set -euo pipefail

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }

command -v podman >/dev/null || fail "podman not installed"

podman info --format '{{.Host.Security.Rootless}} {{.Host.OCIRuntime.Name}} {{.Host.CgroupsVersion}}' \
  | grep -q '^true crun v2$' || fail "expected rootless, crun, cgroup v2: $(podman info --format '{{.Host.Security.Rootless}} {{.Host.OCIRuntime.Name}} {{.Host.CgroupsVersion}}')"
pass "rootless podman with crun on cgroup v2"

IMAGE="docker.io/library/alpine:3"
podman pull -q "$IMAGE" >/dev/null

out=$(podman run --rm --network=none "$IMAGE" echo hello)
[[ "$out" == "hello" ]] || fail "hello container output: $out"
pass "hello container runs"

if podman run --rm --network=none "$IMAGE" sh -c 'wget -q -T 3 -O- http://127.0.0.1:9223/json/version' >/dev/null 2>&1; then
  fail "container reached 127.0.0.1:9223 (host CDP)"
fi
pass "no access to host CDP 127.0.0.1:9223 with --network=none"

if podman run --rm --network=pasta "$IMAGE" sh -c 'wget -q -T 3 -O- http://127.0.0.1:9223/json/version' >/dev/null 2>&1; then
  fail "container reached host 127.0.0.1:9223 over pasta networking"
fi
pass "no access to host CDP 127.0.0.1:9223 with default rootless networking"

if podman run --rm --network=none "$IMAGE" sh -c 'ls /home/neo/.hermes' >/dev/null 2>&1; then
  fail "container can see /home/neo/.hermes"
fi
pass "host home is not visible inside the container"

echo "all checks passed"
