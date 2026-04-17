#!/bin/bash
#
# Build and bundle conduit-freerdp helper binary on Linux.
# Requires: cmake, ninja-build, patchelf, pkg-config, build-essential
#
# This script:
#   1. Ensures FreeRDP dependencies are built (via build-freerdp.sh)
#   2. Builds the conduit-freerdp binary with cmake + ninja
#   3. Bundles the binary + all .so dependencies into bundle/linux/
#   4. Uses patchelf to set RPATH to $ORIGIN for self-contained deployment
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build"
BUNDLE_DIR="$PROJECT_DIR/bundle/linux"
DEPS_LIB="$PROJECT_DIR/deps/install/lib"
DEPS_PREFIX="$PROJECT_DIR/deps/install"

echo "=== Building conduit-freerdp (Linux) ==="
echo "Project dir: $PROJECT_DIR"

# Check build tools
for tool in cmake ninja patchelf; do
    if ! command -v "$tool" &>/dev/null; then
        echo "Error: $tool not found."
        echo "  Install with: sudo apt install cmake ninja-build patchelf"
        exit 1
    fi
done

# Build all deps from source if not already built
if [ ! -d "$DEPS_PREFIX/lib" ]; then
    echo "Dependencies not found at $DEPS_PREFIX, building from source..."
    bash "$PROJECT_DIR/build-freerdp.sh"
fi

# Detect architecture
ARCH=$(uname -m)
echo "Architecture: $ARCH"
echo "Deps prefix: $DEPS_PREFIX"

# ── Phase 1: Build the binary ────────────────────────────────────────

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Set PKG_CONFIG_PATH so cmake's pkg_check_modules finds locally-built FreeRDP
# Include both lib/ and lib64/ (OpenSSL uses lib64/ on x86_64 Linux)
export PKG_CONFIG_PATH="$DEPS_PREFIX/lib/pkgconfig:$DEPS_PREFIX/lib64/pkgconfig:${PKG_CONFIG_PATH:-}"

cmake -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    "$PROJECT_DIR"

ninja

echo ""
echo "=== Binary built ==="
ls -la "$BUILD_DIR/conduit-freerdp"
file "$BUILD_DIR/conduit-freerdp"

# ── Phase 2: Bundle with shared libraries ─────────────────────────────

BINARY="$BUILD_DIR/conduit-freerdp"

if [ ! -f "$BINARY" ]; then
    echo "Error: Binary not found at $BINARY"
    exit 1
fi

echo ""
echo "=== Bundling conduit-freerdp ==="

# Clean and create bundle dir
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR"

# Copy binary
cp "$BINARY" "$BUNDLE_DIR/"

# ── Recursively discover all non-system .so dependencies ──────────────

declare -A ALL_LIBS

is_system_lib() {
    local path="$1"
    case "$path" in
        /lib/*|/lib64/*|/usr/lib/*|/usr/lib64/*|linux-vdso*|linux-gate*)
            return 0 ;;
        *)
            return 1 ;;
    esac
}

scan_deps() {
    local file="$1"
    while IFS= read -r line; do
        # ldd output format: "libfoo.so.1 => /path/to/libfoo.so.1 (0x...)"
        # or: "/lib64/ld-linux-x86-64.so.2 (0x...)"
        local lib_name lib_path

        if echo "$line" | grep -q "=>"; then
            lib_name=$(echo "$line" | awk '{print $1}')
            lib_path=$(echo "$line" | awk '{print $3}')
        else
            continue
        fi

        [ -z "$lib_path" ] && continue
        [ "$lib_path" = "not" ] && continue  # "not found"
        is_system_lib "$lib_path" && continue
        [ -n "${ALL_LIBS[$lib_name]+x}" ] && continue

        if [ -f "$lib_path" ]; then
            ALL_LIBS["$lib_name"]="$lib_path"
            echo "  Found: $lib_name -> $lib_path"
            scan_deps "$lib_path"
        fi
    done < <(ldd "$file" 2>/dev/null)
}

echo "Discovering all dependencies (recursive)..."
scan_deps "$BINARY"

echo ""
echo "Total non-system shared libs: ${#ALL_LIBS[@]}"

# ── Copy all shared libraries ─────────────────────────────────────────

echo ""
echo "Copying shared libraries..."
for lib_name in "${!ALL_LIBS[@]}"; do
    lib_path="${ALL_LIBS[$lib_name]}"
    # Resolve symlinks to get actual file
    actual=$(readlink -f "$lib_path" 2>/dev/null || echo "$lib_path")
    if [ -f "$actual" ]; then
        cp "$actual" "$BUNDLE_DIR/$lib_name"
        chmod u+w "$BUNDLE_DIR/$lib_name"
        echo "  Copied: $lib_name"
    fi
done

# ── Bundle OpenSSL provider modules (legacy provider needed for NTLM/NLA) ──

for ossl_dir in "$DEPS_LIB/ossl-modules" "$DEPS_PREFIX/lib64/ossl-modules"; do
    if [ -d "$ossl_dir" ]; then
        mkdir -p "$BUNDLE_DIR/ossl-modules"
        cp "$ossl_dir"/*.so "$BUNDLE_DIR/ossl-modules/" 2>/dev/null || true
        for f in "$BUNDLE_DIR/ossl-modules"/*.so; do
            [ -f "$f" ] || continue
            chmod u+w "$f"
            # Provider modules are in ossl-modules/ subdirectory — set RPATH to find
            # libcrypto.so one level up at $ORIGIN/..
            patchelf --set-rpath '$ORIGIN/..' "$f" 2>/dev/null || true
            echo "  Bundled: ossl-modules/$(basename "$f") (RPATH=\$ORIGIN/..)"
        done
        break
    fi
done

# ── Fix RPATH with patchelf ───────────────────────────────────────────

echo ""
echo "Setting RPATH..."

# Set the binary's RPATH to $ORIGIN so it finds bundled .so files
patchelf --set-rpath '$ORIGIN' "$BUNDLE_DIR/conduit-freerdp"
echo "  conduit-freerdp: RPATH set to \$ORIGIN"

# Set each .so's RPATH to $ORIGIN
for lib_name in "${!ALL_LIBS[@]}"; do
    if [ -f "$BUNDLE_DIR/$lib_name" ]; then
        patchelf --set-rpath '$ORIGIN' "$BUNDLE_DIR/$lib_name" 2>/dev/null || true
        echo "  $lib_name: RPATH set to \$ORIGIN"
    fi
done

# ── Verify ────────────────────────────────────────────────────────────

echo ""
echo "=== Bundle complete ==="
echo "Bundle dir: $BUNDLE_DIR"
ls -lh "$BUNDLE_DIR"

echo ""
echo "Verifying binary dependencies (should all be bundled or system):"
ldd "$BUNDLE_DIR/conduit-freerdp"

echo ""
echo "Checking for unresolved dependencies..."
MISSING=0
while IFS= read -r line; do
    if echo "$line" | grep -q "not found"; then
        echo "  WARNING: $line"
        MISSING=$((MISSING + 1))
    fi
done < <(LD_LIBRARY_PATH="$BUNDLE_DIR" ldd "$BUNDLE_DIR/conduit-freerdp" 2>/dev/null)

if [ "$MISSING" -eq 0 ]; then
    echo "  All dependencies resolved!"
else
    echo "  $MISSING unresolved dependencies"
fi
