#!/usr/bin/env bash
# Dumps the matrix database from the rootless Postgres container; keeps the last 14 dumps.
set -euo pipefail
dir="${MATRIX_BACKUP_DIR:-$HOME/.matrix/backups}"
mkdir -p "$dir" && chmod 700 "$dir"
out="$dir/matrix-$(date +%Y%m%d-%H%M%S).sql.gz"
podman exec matrix-postgres pg_dump -U matrix -d matrix --no-owner | gzip -9 > "$out.tmp"
mv "$out.tmp" "$out" && chmod 600 "$out"
ls -1t "$dir"/matrix-*.sql.gz | tail -n +15 | xargs -r rm -f
echo "backup: $out ($(du -h "$out" | cut -f1))"
