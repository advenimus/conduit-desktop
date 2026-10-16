#!/usr/bin/env bash
# Stop the local RD Gateway test rig. Pass --purge to also delete the test cert and the desktop image.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [ "${1:-}" = "--purge" ]; then
  docker compose down --remove-orphans --rmi local
  rm -rf "$DIR/certs"
else
  docker compose down --remove-orphans
fi
