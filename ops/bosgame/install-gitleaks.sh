#!/usr/bin/env bash
set -euo pipefail
umask 077

version=8.30.1
checksum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  echo 'Pinned gitleaks installer supports Linux x86_64 only' >&2
  exit 1
}
destination="${1:-$HOME/tools/bin/gitleaks}"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
archive="gitleaks_${version}_linux_x64.tar.gz"
curl --proto '=https' --tlsv1.2 -fsSLo "$temporary/$archive" \
  "https://github.com/gitleaks/gitleaks/releases/download/v${version}/${archive}"
printf '%s  %s\n' "$checksum" "$temporary/$archive" | sha256sum -c -
tar -xzf "$temporary/$archive" -C "$temporary" gitleaks
[[ "$("$temporary/gitleaks" version)" == "$version" ]]
mkdir -p "$(dirname "$destination")"
install -m 755 "$temporary/gitleaks" "$destination"
