#!/bin/sh
# Three old-server fronts for the rig. The first two pass traffic on to rdpgw, so a client
# that gets through their TLS reaches the real gateway. The third only speaks HTTP.
set -e
C=/etc/legacy/certs

# 8444: TLS 1.0 only, normal certificate.
socat OPENSSL-LISTEN:8444,reuseaddr,fork,cert=$C/tls10.pem,key=$C/tls10-key.pem,verify=0,openssl-min-proto-version=TLS1,openssl-max-proto-version=TLS1 \
  OPENSSL:rdpgw:8443,verify=0 &

# 8445: TLS 1.2 with a SHA-1 signed, 1024-bit RSA certificate from a test CA.
socat OPENSSL-LISTEN:8445,reuseaddr,fork,cert=$C/weak-chain.pem,key=$C/weak-key.pem,verify=0 \
  OPENSSL:rdpgw:8443,verify=0 &

# 8446: no secure renegotiation (RFC 5746), like very old servers.
gnutls-serv --http --port 8446 --priority 'NORMAL:-VERS-TLS1.3:%DISABLE_SAFE_RENEGOTIATION' \
  --x509certfile $C/tls10.pem --x509keyfile $C/tls10-key.pem >/dev/null &

wait
