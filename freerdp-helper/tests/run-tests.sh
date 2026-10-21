#!/bin/bash
#
# Build and run the helper's unit tests. Needs only a C compiler.
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$PROJECT_DIR/build/tests"
CC="${CC:-cc}"

SAN="-fsanitize=address,undefined"

mkdir -p "$OUT_DIR"
# Vendored cJSON is built quietly so warnings point at our own code.
"$CC" -std=c11 -g $SAN -w -c "$PROJECT_DIR/src/cjson/cJSON.c" -o "$OUT_DIR/cJSON.o"
"$CC" -std=c11 -Wall -Wextra -Werror -g $SAN \
    -I "$PROJECT_DIR/src" \
    "$SCRIPT_DIR/test_helper.c" \
    "$PROJECT_DIR/src/json_out.c" \
    "$PROJECT_DIR/src/protocol.c" \
    "$PROJECT_DIR/src/tls_reason.c" \
    "$OUT_DIR/cJSON.o" \
    -o "$OUT_DIR/test_helper"

"$OUT_DIR/test_helper"
