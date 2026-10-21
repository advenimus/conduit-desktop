#!/usr/bin/env bash
# Start the old-server TLS fronts (TLS 1.0 only, SHA-1/1024-bit certificate, no secure
# renegotiation) next to a running rig. Run ./up.sh first.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

C="$DIR/certs/legacy"
if [ ! -f "$C/weak-chain.pem" ]; then
  echo "Making test certificates in $C"
  mkdir -p "$C"
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -sha256 \
    -keyout "$C/ca-key.pem" -out "$C/ca.pem" -subj "/CN=Conduit Test Legacy CA" >/dev/null 2>&1
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -sha256 \
    -keyout "$C/tls10-key.pem" -out "$C/tls10.pem" \
    -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > "$C/weak.ext"
  openssl req -new -newkey rsa:1024 -nodes -keyout "$C/weak-key.pem" -out "$C/weak.csr" -subj "/CN=localhost" >/dev/null 2>&1
  openssl x509 -req -in "$C/weak.csr" -CA "$C/ca.pem" -CAkey "$C/ca-key.pem" -CAcreateserial \
    -days 825 -sha1 -extfile "$C/weak.ext" -out "$C/weak.pem" >/dev/null 2>&1
  cat "$C/weak.pem" "$C/ca.pem" > "$C/weak-chain.pem"
  # Test-only keys; the container user must read them.
  chmod 644 "$C"/*.pem
fi

docker compose --profile legacy up -d --build legacytls
echo "Old-server fronts on 127.0.0.1: ${LEGACY_TLS10_PORT:-18444} (TLS 1.0), ${LEGACY_WEAK_PORT:-18445} (SHA-1/1024-bit), ${LEGACY_RENEG_PORT:-18446} (no secure renegotiation, HTTP only)"
