#!/bin/bash
#
# build-macos.sh — Full Conduit build for macOS (prerequisites → installable .dmg)
#
# Usage:
#   bash scripts/build-macos.sh              # Full build (deps + FreeRDP + Electron app)
#   bash scripts/build-macos.sh --skip-deps  # Skip FreeRDP dependency build (uses cached)
#   bash scripts/build-macos.sh --app-only   # Skip FreeRDP entirely, just build Electron app
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
FREERDP_DIR="$PROJECT_ROOT/freerdp-helper"

SKIP_DEPS=false
APP_ONLY=false

for arg in "$@"; do
    case "$arg" in
        --skip-deps) SKIP_DEPS=true ;;
        --app-only)  APP_ONLY=true ;;
        --help|-h)
            echo "Usage: $0 [--skip-deps] [--app-only]"
            echo ""
            echo "  --skip-deps  Skip building FreeRDP deps from source (OpenSSL, FFmpeg, FreeRDP)"
            echo "               Uses cached deps if available. Still builds the helper binary + bundle."
            echo "  --app-only   Skip FreeRDP entirely. Just build the Electron app."
            echo ""
            echo "First run takes ~15-25 min (FreeRDP deps build from source)."
            echo "Subsequent runs take ~1-2 min."
            exit 0
            ;;
    esac
done

cd "$PROJECT_ROOT"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              Conduit — macOS Full Build                     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Check & install prerequisites ───────────────────────────

echo "▸ [1/6] Checking prerequisites..."

MISSING=()

# Xcode command-line tools
if ! xcode-select -p &>/dev/null; then
    echo "  Installing Xcode Command Line Tools..."
    xcode-select --install
    echo "  ⚠ Xcode CLI tools installation started. Re-run this script after it completes."
    exit 1
fi
echo "  ✓ Xcode CLI tools"

# Homebrew
if ! command -v brew &>/dev/null; then
    echo "  Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # Add to path for this session
    if [ -f /opt/homebrew/bin/brew ]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [ -f /usr/local/bin/brew ]; then
        eval "$(/usr/local/bin/brew shellenv)"
    fi
fi
echo "  ✓ Homebrew"

# cmake + ninja (needed for FreeRDP build)
if ! "$APP_ONLY"; then
    for tool in cmake ninja; do
        if ! command -v "$tool" &>/dev/null; then
            MISSING+=("$tool")
        fi
    done

    # Detect native architecture (handle Rosetta)
    ARCH=$(uname -m)
    if [ "$ARCH" = "x86_64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
        ARCH="arm64"
    fi
    if [ "$ARCH" = "x86_64" ] && ! command -v nasm &>/dev/null; then
        MISSING+=("nasm")
    fi

    if [ ${#MISSING[@]} -gt 0 ]; then
        echo "  Installing: ${MISSING[*]}..."
        brew install "${MISSING[@]}"
    fi
    echo "  ✓ cmake, ninja$([ "$ARCH" = "x86_64" ] && echo ", nasm")"
fi

# Node.js + npm
if ! command -v node &>/dev/null; then
    echo "  Node.js not found. Installing via Homebrew..."
    brew install node
fi
NODE_VERSION=$(node -v)
echo "  ✓ Node.js $NODE_VERSION"

# npm
if ! command -v npm &>/dev/null; then
    echo "  ERROR: npm not found even though Node.js is installed."
    exit 1
fi
echo "  ✓ npm $(npm -v)"

# Python3 (needed for node-gyp to compile native modules)
if ! command -v python3 &>/dev/null; then
    echo "  Python3 not found. Installing via Homebrew..."
    brew install python3
fi
echo "  ✓ python3"

echo ""

# ── Step 2: Install npm dependencies ────────────────────────────────

echo "▸ [2/6] Installing npm dependencies..."

# Root project
if [ ! -d "$PROJECT_ROOT/node_modules" ] || [ "$PROJECT_ROOT/package.json" -nt "$PROJECT_ROOT/node_modules/.package-lock.json" ]; then
    npm install
else
    echo "  Root dependencies up to date (skipping)"
fi

# MCP server
if [ ! -d "$PROJECT_ROOT/mcp/node_modules" ] || [ "$PROJECT_ROOT/mcp/package.json" -nt "$PROJECT_ROOT/mcp/node_modules/.package-lock.json" ]; then
    (cd "$PROJECT_ROOT/mcp" && npm install)
else
    echo "  MCP dependencies up to date (skipping)"
fi

echo ""

# ── Step 3: Build MCP server ────────────────────────────────────────

echo "▸ [3/6] Building MCP server..."
(cd "$PROJECT_ROOT/mcp" && npm run build)
echo ""

# ── Step 4: Build FreeRDP helper ────────────────────────────────────

if "$APP_ONLY"; then
    echo "▸ [4/6] Skipping FreeRDP build (--app-only)"
    if [ ! -f "$FREERDP_DIR/bundle/darwin/conduit-freerdp" ]; then
        echo "  ⚠ Warning: No FreeRDP bundle found. RDP via FreeRDP engine will not work."
    fi
else
    echo "▸ [4/6] Building FreeRDP helper..."

    # 4a: Build dependencies (OpenSSL, FFmpeg, FreeRDP) from source
    if "$SKIP_DEPS"; then
        if [ ! -d "$FREERDP_DIR/deps/install/lib" ]; then
            echo "  ⚠ --skip-deps specified but no cached deps found. Building anyway..."
            (cd "$FREERDP_DIR" && bash build-freerdp.sh)
        else
            echo "  Using cached FreeRDP deps (--skip-deps)"
        fi
    else
        (cd "$FREERDP_DIR" && bash build-freerdp.sh)
    fi

    # 4b: Build the helper binary
    echo ""
    echo "  Building conduit-freerdp binary..."
    bash "$FREERDP_DIR/scripts/build-macos.sh"

    # 4c: Bundle with dylibs
    echo ""
    echo "  Bundling conduit-freerdp + dylibs..."
    bash "$FREERDP_DIR/scripts/bundle-macos.sh"
fi

echo ""

# ── Step 5: Build frontend + Electron main process ──────────────────

echo "▸ [5/6] Building application..."

# Frontend (Vite)
echo "  Building frontend (Vite)..."
npx vite build

# Electron main process (TypeScript)
echo "  Building Electron main process..."
npx tsc -p electron/tsconfig.json

echo ""

# ── Step 6: Package with electron-builder ────────────────────────────

echo "▸ [6/6] Packaging with electron-builder..."

# Clean previous release
rm -rf "$PROJECT_ROOT/release/"

npx electron-builder --mac

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                    Build Complete!                          ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Output:"
ls -lh "$PROJECT_ROOT/release/"*.dmg 2>/dev/null || echo "  (no .dmg found)"
ls -lh "$PROJECT_ROOT/release/"*.zip 2>/dev/null || echo "  (no .zip found)"
echo ""
echo "To install: open the .dmg and drag Conduit to Applications"
