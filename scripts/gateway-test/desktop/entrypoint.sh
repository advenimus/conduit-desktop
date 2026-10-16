#!/bin/sh
set -e

: "${DESK_USER:?DESK_USER is required}"
: "${DESK_PASS:?DESK_PASS is required}"

id "$DESK_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$DESK_USER"
printf '%s:%s\n' "$DESK_USER" "$DESK_PASS" | chpasswd

if [ -n "${SHARED_USER:-}" ]; then
  id "$SHARED_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$SHARED_USER"
  printf '%s:%s\n' "$SHARED_USER" "${SHARED_PASS:?SHARED_PASS is required}" | chpasswd
fi

mkdir -p /run/xrdp /run/dbus
chown xrdp:xrdp /run/xrdp 2>/dev/null || true
rm -f /run/xrdp/*.pid /run/dbus/pid /var/run/xrdp*.pid

dbus-daemon --system --fork
xrdp-sesman
exec xrdp --nodaemon
