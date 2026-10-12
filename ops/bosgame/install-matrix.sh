#!/usr/bin/env bash
# Installs / updates Project Matrix on this host as systemd user services (no sudo):
# Postgres 17 (rootless Podman quadlet, loopback), matrix-server (loopback + Tailscale), daily backups,
# the runner image and the `matrix-cli` wrapper. Idempotent: secrets are generated once, never printed.
#
# Required on first install: MATRIX_GATEWAY_URL (CLIProxyAPI base URL, e.g. http://<gateway-host>:8317).
set -euo pipefail
umask 077

repo="$(cd "$(dirname "$0")/../.." && pwd)"
cfg="$HOME/.config/matrix"
mkdir -p "$cfg" "$HOME/.matrix" "$HOME/.config/containers/systemd" "$HOME/.config/systemd/user" "$HOME/.local/bin"
chmod 700 "$cfg" "$HOME/.matrix"

# Rootless Podman without a systemd user bus in SSH sessions: use cgroupfs, no warnings.
conf="$HOME/.config/containers/containers.conf"
if ! grep -q '^cgroup_manager' "$conf" 2>/dev/null; then
  printf '[engine]\ncgroup_manager = "cgroupfs"\n' >> "$conf"
fi

if [ ! -f "$cfg/postgres.env" ]; then
  printf 'POSTGRES_USER=matrix\nPOSTGRES_DB=matrix\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" > "$cfg/postgres.env"
fi
chmod 600 "$cfg/postgres.env"

if [ ! -f "$cfg/server.env" ]; then
  : "${MATRIX_GATEWAY_URL:?set MATRIX_GATEWAY_URL for the first install}"
  pw="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$cfg/postgres.env")"
  ts_ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  token="$("$HOME/.bun/bin/bun" "$repo/apps/server/src/gen-token.ts")"
  {
    echo "MATRIX_RUNTIME=${MATRIX_RUNTIME:-native}"
    echo "MATRIX_DATABASE_URL=postgres://matrix:${pw}@127.0.0.1:55432/matrix"
    echo "MATRIX_HOSTS=127.0.0.1${ts_ip:+,$ts_ip}"
    echo "MATRIX_PORT=8740"
    echo "MATRIX_NODE_NAME=$(hostname)"
    echo "MATRIX_DATA_DIR=$HOME/.matrix"
    echo "MATRIX_DASHBOARD_DIR=$repo/apps/dashboard/dist"
    echo "MATRIX_BOOTSTRAP_TOKEN=${token}"
    echo "MATRIX_GATEWAY_URL=${MATRIX_GATEWAY_URL}"
    echo "MATRIX_GATEWAY_KEY_FILE=${MATRIX_GATEWAY_KEY_FILE:-$HOME/.hermes/config.yaml}"
    # No backslashes: systemd EnvironmentFile strips them.
    echo 'MATRIX_GATEWAY_KEY_PATTERN=^ *api_key: *([^ ]+)'
    echo "MATRIX_RUNNER_IMAGE=matrix-runner:dev"
    echo "MATRIX_GITLEAKS=${MATRIX_GITLEAKS:-$HOME/tools/bin/gitleaks}"
    echo "MATRIX_SENTRY_SECRET=$(openssl rand -hex 24)"
    echo "MATRIX_ORCA_SECRET=$(openssl rand -hex 24)"
    echo "MATRIX_AUDIT_FILE=$HOME/.matrix/audit.jsonl"
    echo "MATRIX_REPLAY_LOG=$HOME/.matrix/replay.log"
  } > "$cfg/server.env"
fi
chmod 600 "$cfg/server.env"

cp "$repo/ops/bosgame/units/matrix-postgres.container" "$HOME/.config/containers/systemd/"
cp "$repo/ops/bosgame/units/matrix-server.service" "$repo/ops/bosgame/units/matrix-backup.service" \
  "$repo/ops/bosgame/units/matrix-backup.timer" "$HOME/.config/systemd/user/"

(cd "$repo" && "$HOME/.bun/bin/bun" install --frozen-lockfile >/dev/null)
(cd "$repo/apps/dashboard" && "$HOME/.bun/bin/bun" run build >/dev/null)
podman build -q -t matrix-runner:dev -f "$repo/packages/sandbox/images/runner/Containerfile" "$repo/packages/sandbox" >/dev/null

cat > "$HOME/.local/bin/matrix-cli" <<WRAP
#!/usr/bin/env bash
exec "$HOME/.bun/bin/bun" "$repo/packages/cli/src/bin.ts" "\$@"
WRAP
chmod 755 "$HOME/.local/bin/matrix-cli"

systemctl --user daemon-reload
systemctl --user start matrix-postgres.service
for _ in $(seq 1 30); do podman exec matrix-postgres pg_isready -U matrix -d matrix >/dev/null 2>&1 && break; sleep 1; done
systemctl --user enable --now matrix-backup.timer >/dev/null
systemctl --user enable matrix-server.service >/dev/null
systemctl --user restart matrix-server.service
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:8740/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:8740/healthz && echo
systemctl --user --no-pager --lines=0 status matrix-server.service | head -3
