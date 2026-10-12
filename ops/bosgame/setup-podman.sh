#!/usr/bin/env bash
# One-time rootless Podman setup for bosgame (Ubuntu 26.04). Run with sudo. Idempotent.
set -euo pipefail

TARGET_USER="${TARGET_USER:-neo}"

if [[ $EUID -ne 0 ]]; then
  echo "run with sudo" >&2
  exit 1
fi

# podman: engine, crun: OCI runtime, uidmap: newuidmap/newgidmap, passt: rootless networking (pasta).
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends podman crun uidmap passt

# Subordinate ids for rootless containers (skip if already present).
grep -q "^${TARGET_USER}:" /etc/subuid || usermod --add-subuids 100000-165535 "$TARGET_USER"
grep -q "^${TARGET_USER}:" /etc/subgid || usermod --add-subgids 100000-165535 "$TARGET_USER"

# Ubuntu keeps kernel.apparmor_restrict_unprivileged_userns=1 and ships profiles that grant
# the userns permission only to /usr/bin/podman and /usr/bin/crun. Load those profiles
# instead of disabling the restriction globally.
for profile in podman crun; do
  if [[ -f "/etc/apparmor.d/${profile}" ]]; then
    apparmor_parser -r "/etc/apparmor.d/${profile}"
  else
    echo "missing AppArmor profile /etc/apparmor.d/${profile}; not disabling the userns restriction" >&2
    exit 1
  fi
done

# User services (podman socket, containers) survive logout.
loginctl enable-linger "$TARGET_USER"

# Refresh rootless storage for the user so the new id ranges apply.
sudo -u "$TARGET_USER" -H env XDG_RUNTIME_DIR="/run/user/$(id -u "$TARGET_USER")" podman system migrate

echo "done. now run (as ${TARGET_USER}, no sudo): bash ops/bosgame/check-podman.sh"
