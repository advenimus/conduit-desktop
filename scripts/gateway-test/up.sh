#!/usr/bin/env bash
# Start the local RD Gateway test rig and wait until both containers are healthy.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

export GW_PORT="${GW_PORT:-18443}"
CERT_DIR="$DIR/certs"
CERT="$CERT_DIR/gateway.pem"
KEY="$CERT_DIR/gateway-key.pem"

command -v docker >/dev/null || { echo "Docker is not installed." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start Docker Desktop first." >&2; exit 1; }

running_here=$(docker compose ps -q rdpgw 2>/dev/null || true)
if [ -z "$running_here" ] && lsof -nP -iTCP:"$GW_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $GW_PORT is already in use. Pick another one: GW_PORT=18444 $0" >&2
  exit 1
fi

if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "Making a self-signed test certificate in $CERT_DIR"
  mkdir -p "$CERT_DIR"
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -sha256 \
    -keyout "$KEY" -out "$CERT" \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
  # The container user (uid 1001) must read the key. Test-only key, so this is fine.
  chmod 644 "$KEY" "$CERT"
fi

echo "Building and starting the rig (project conduit-gw-test, gateway on 127.0.0.1:$GW_PORT)"
docker compose up -d --build

echo -n "Waiting for the gateway and desktop to be healthy"
for _ in $(seq 1 120); do
  gw=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q rdpgw)" 2>/dev/null || echo none)
  desk=$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q desktop)" 2>/dev/null || echo none)
  if [ "$gw" = healthy ] && [ "$desk" = healthy ]; then
    echo
    echo "Rig is up."
    echo "  Gateway:  127.0.0.1:$GW_PORT (login gwuser / GwTest-Pass1!)"
    echo "  Desktop:  desktop:3389 behind the gateway (login deskuser / DeskTest-Pass1!)"
    exit 0
  fi
  echo -n "."
  sleep 2
done

echo
echo "The rig did not become healthy in time. Recent logs:" >&2
docker compose logs --tail 40 >&2
exit 1
