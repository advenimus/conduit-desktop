#!/bin/bash
#
# Build conduit-freerdp helper binary on macOS.
# Requires: cmake ninja (brew install cmake ninja)
# FreeRDP is built from source via build-freerdp.sh (no Homebrew freerdp needed)
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$PROJECT_DIR/build"
DEPS_PREFIX="$PROJECT_DIR/deps/install"

echo "=== Building conduit-freerdp ==="
echo "Project dir: $PROJECT_DIR"

# Check build tools
if ! command -v cmake &>/dev/null; then
    echo "Error: cmake not found. Install with: brew install cmake"
    exit 1
fi

if ! command -v ninja &>/dev/null; then
    echo "Error: ninja not found. Install with: brew install ninja"
    exit 1
fi

# Build all deps from source if not already built
if [ ! -d "$DEPS_PREFIX/lib" ]; then
    echo "Dependencies not found at $DEPS_PREFIX, building from source..."
    bash "$PROJECT_DIR/build-freerdp.sh"
fi

# Detect architecture (handle Rosetta — use native arch on Apple Silicon)
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
    ARCH="arm64"
fi
echo "Architecture: $ARCH"
echo "Deps prefix: $DEPS_PREFIX"

# Create build directory
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Set PKG_CONFIG_PATH so cmake's pkg_check_modules finds locally-built FreeRDP
export PKG_CONFIG_PATH="$DEPS_PREFIX/lib/pkgconfig:${PKG_CONFIG_PATH:-}"

# Configure and build with Ninja
cmake -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="$ARCH" \
    "$PROJECT_DIR"

ninja

echo ""
echo "=== Build complete ==="
echo "Binary: $BUILD_DIR/conduit-freerdp"
ls -la "$BUILD_DIR/conduit-freerdp"
file "$BUILD_DIR/conduit-freerdp"
