#!/bin/sh
set -e
cd /opt/rdpgw

SOCK=/tmp/rdpgw-auth.sock
rm -f "$SOCK"
/opt/rdpgw/rdpgw-auth -c /etc/rdpgw/rdpgw-auth.yaml -s "$SOCK" &

i=0
while [ ! -S "$SOCK" ]; do
  i=$((i + 1))
  if [ "$i" -gt 50 ]; then
    echo "rdpgw-auth did not create $SOCK" >&2
    exit 1
  fi
  sleep 0.1
done

exec /opt/rdpgw/rdpgw -c /etc/rdpgw/rdpgw.yaml
