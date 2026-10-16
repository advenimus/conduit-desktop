#!/usr/bin/env bash
# Prove the rig works with a stock FreeRDP 3.x client, and that the desktop
# can only be reached through the gateway. Run ./up.sh first.
#
# Uses sdl-freerdp by default because xfreerdp needs an X server (XQuartz) on
# macOS. Both come from the same Homebrew FreeRDP build and take the same
# options. Override with CLIENT=xfreerdp when DISPLAY is set.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

GW_PORT="${GW_PORT:-18443}"
GW="127.0.0.1:$GW_PORT"
GW_USER=gwuser
GW_PASS='GwTest-Pass1!'
DESK_HOST=desktop
DESK_USER=deskuser
DESK_PASS='DeskTest-Pass1!'
GOOD_SECONDS="${GOOD_SECONDS:-15}"
FAIL_SECONDS="${FAIL_SECONDS:-25}"
LOG_DIR="$DIR/logs"
mkdir -p "$LOG_DIR"

if [ -z "${CLIENT:-}" ]; then
  if [ -n "${DISPLAY:-}" ] && command -v xfreerdp >/dev/null; then CLIENT=xfreerdp; else CLIENT=sdl-freerdp; fi
fi
command -v "$CLIENT" >/dev/null || { echo "$CLIENT not found. Install it with: brew install freerdp" >&2; exit 1; }
echo "Client: $("$CLIENT" --version 2>&1 | head -1) ($CLIENT)"

[ -n "$(docker compose ps -q rdpgw 2>/dev/null)" ] || { echo "The rig is not running. Run ./up.sh first." >&2; exit 1; }

COMMON=(/log-level:INFO /cert:ignore /size:1024x768 -clipboard)
RESULTS=()
FAILED=0

record() {
  RESULTS+=("$(printf '%-6s %-34s %s' "$1" "$2" "$3")")
  [ "$1" = PASS ] || FAILED=1
}

# Runs the client for up to $1 seconds. Sets RUN_LOG and RUN_SELF_EXIT (1 if it quit by itself).
run_client() {
  local seconds=$1 name=$2; shift 2
  RUN_LOG="$LOG_DIR/$name.log"
  "$CLIENT" "${COMMON[@]}" "$@" >"$RUN_LOG" 2>&1 &
  local pid=$! waited=0
  RUN_SELF_EXIT=0
  while [ "$waited" -lt "$((seconds * 4))" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then RUN_SELF_EXIT=1; break; fi
    sleep 0.25
    waited=$((waited + 1))
  done
  if [ "$RUN_SELF_EXIT" = 0 ]; then
    kill "$pid" 2>/dev/null
    sleep 1
    kill -9 "$pid" 2>/dev/null
  fi
  wait "$pid" 2>/dev/null
}

first_error() {
  grep -o 'ERRCONNECT_[A-Z_]*\|ERRINFO_[A-Z_]*\|E_PROXY_[A-Z_]*' "$RUN_LOG" | grep -v ERRCONNECT_CONNECT_CANCELLED | head -1
}

gateway_log_since() {
  docker compose logs --no-log-prefix --since "$1" rdpgw 2>/dev/null
}

# 1. Good login through the gateway.
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
run_client "$GOOD_SECONDS" good \
  "/gateway:g:$GW,u:$GW_USER,p:$GW_PASS,type:auto" "/v:$DESK_HOST" "/u:$DESK_USER" "/p:$DESK_PASS"
err=$(first_error)
gwlog=$(gateway_log_since "$since")
if [ "$RUN_SELF_EXIT" = 0 ] && [ -z "$err" ] \
   && grep -q 'gdi_init_ex' "$RUN_LOG" \
   && grep -q "Establishing connection to RDP server: $DESK_HOST:3389" <<<"$gwlog" \
   && grep -q 'Connection established' <<<"$gwlog"; then
  record PASS "gateway login, desktop session" "stayed connected ${GOOD_SECONDS}s; gateway: $GW_USER -> $DESK_HOST:3389"
else
  record FAIL "gateway login, desktop session" "self_exit=$RUN_SELF_EXIT error=${err:-none} (see $RUN_LOG)"
fi

# 2. Wrong gateway password must fail.
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
run_client "$FAIL_SECONDS" wrong-gw-password \
  "/gateway:g:$GW,u:$GW_USER,p:wrong-password,type:auto" "/v:$DESK_HOST" "/u:$DESK_USER" "/p:$DESK_PASS"
err=$(first_error)
gwlog=$(gateway_log_since "$since")
if [ "$RUN_SELF_EXIT" = 1 ] && [ -n "$err" ] && ! grep -q 'Connection established' <<<"$gwlog"; then
  record PASS "wrong gateway password refused" "$err"
else
  record FAIL "wrong gateway password refused" "self_exit=$RUN_SELF_EXIT error=${err:-none} (see $RUN_LOG)"
fi

# 3. A target the gateway does not allow must fail.
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
run_client "$FAIL_SECONDS" target-not-allowed \
  "/gateway:g:$GW,u:$GW_USER,p:$GW_PASS,type:auto" "/v:not-allowed-host" "/u:$DESK_USER" "/p:$DESK_PASS"
err=$(first_error)
gwlog=$(gateway_log_since "$since")
if [ "$RUN_SELF_EXIT" = 1 ] && [ -n "$err" ] && grep -q 'Not allowed to connect to not-allowed-host:3389' <<<"$gwlog"; then
  record PASS "target not allowed by gateway" "$err"
else
  record FAIL "target not allowed by gateway" "self_exit=$RUN_SELF_EXIT error=${err:-none} (see $RUN_LOG)"
fi

# 4. Gateway down (nothing listens on this port).
DOWN_PORT="${DOWN_PORT:-18499}"
if lsof -nP -iTCP:"$DOWN_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  record FAIL "gateway down" "port $DOWN_PORT is in use; set DOWN_PORT to a free port"
else
  run_client "$FAIL_SECONDS" gateway-down \
    "/gateway:g:127.0.0.1:$DOWN_PORT,u:$GW_USER,p:$GW_PASS,type:auto" "/v:$DESK_HOST" "/u:$DESK_USER" "/p:$DESK_PASS"
  err=$(first_error)
  if [ "$RUN_SELF_EXIT" = 1 ] && [ -n "$err" ]; then
    record PASS "gateway down" "$err"
  else
    record FAIL "gateway down" "self_exit=$RUN_SELF_EXIT error=${err:-none} (see $RUN_LOG)"
  fi
fi

# 5. The desktop has no way in except the gateway.
desk_id=$(docker compose ps -q desktop)
published=$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{$p}} {{end}}{{end}}' "$desk_id")
nets=$(docker inspect -f '{{range $n, $_ := .NetworkSettings.Networks}}{{$n}} {{end}}' "$desk_id")
internal=$(docker network inspect -f '{{.Internal}}' conduit-gw-test_backend 2>/dev/null)
if [ -z "$published" ] && [ "$(echo $nets)" = "conduit-gw-test_backend" ] && [ "$internal" = true ]; then
  record PASS "desktop has no published port" "only network: conduit-gw-test_backend (internal)"
else
  record FAIL "desktop has no published port" "published='$published' networks='$nets' internal=$internal"
fi

run_client "$FAIL_SECONDS" direct-by-name "/v:$DESK_HOST" "/u:$DESK_USER" "/p:$DESK_PASS"
err=$(first_error)
if [ "$RUN_SELF_EXIT" = 1 ] && [ -n "$err" ] && ! grep -q 'gdi_init_ex' "$RUN_LOG"; then
  record PASS "direct to desktop:3389 fails" "$err"
else
  record FAIL "direct to desktop:3389 fails" "self_exit=$RUN_SELF_EXIT error=${err:-none} (see $RUN_LOG)"
fi

if lsof -nP -iTCP:3389 -sTCP:LISTEN >/dev/null 2>&1; then
  record FAIL "direct to 127.0.0.1:3389 fails" "something else on this Mac listens on 3389; check skipped"
else
  run_client "$FAIL_SECONDS" direct-localhost "/v:127.0.0.1:3389" "/u:$DESK_USER" "/p:$DESK_PASS"
  err=$(first_error)
  if [ "$RUN_SELF_EXIT" = 1 ] && [ -n "$err" ] && ! grep -q 'gdi_init_ex' "$RUN_LOG"; then
    record PASS "direct to 127.0.0.1:3389 fails" "$err"
  else
    record FAIL "direct to 127.0.0.1:3389 fails" "self_exit=$RUN_SELF_EXIT error=${err:-none} (see $RUN_LOG)"
  fi
fi

echo
printf '%-6s %-34s %s\n' RESULT CHECK DETAIL
for r in "${RESULTS[@]}"; do echo "$r"; done
echo
echo "Client logs: $LOG_DIR"
exit "$FAILED"
