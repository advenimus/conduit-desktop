#!/bin/bash
#
# build-linux.sh — Full Conduit build for Linux (prerequisites → installable .AppImage/.deb)
#
# Usage:
#   bash scripts/build-linux.sh              # Full build (deps + FreeRDP + Electron app)
#   bash scripts/build-linux.sh --skip-deps  # Skip FreeRDP dependency build (uses cached)
#   bash scripts/build-linux.sh --app-only   # Skip FreeRDP entirely, just build Electron app
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
echo "║              Conduit — Linux Full Build                     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── Detect package manager ───────────────────────────────────────────

install_packages() {
    if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq
        sudo apt-get install -y "$@"
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y "$@"
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm "$@"
    elif command -v zypper &>/dev/null; then
        sudo zypper install -y "$@"
    else
        echo "  ERROR: No supported package manager found (apt, dnf, pacman, zypper)"
        echo "  Please install these packages manually: $*"
        exit 1
    fi
}

# Map package names across distros
get_package_name() {
    local pkg="$1"

    if command -v apt-get &>/dev/null; then
        echo "$pkg"
    elif command -v dnf &>/dev/null; then
        case "$pkg" in
            build-essential) echo "gcc gcc-c++ make" ;;
            ninja-build)     echo "ninja-build" ;;
            *)               echo "$pkg" ;;
        esac
    elif command -v pacman &>/dev/null; then
        case "$pkg" in
            build-essential) echo "base-devel" ;;
            ninja-build)     echo "ninja" ;;
            patchelf)        echo "patchelf" ;;
            *)               echo "$pkg" ;;
        esac
    elif command -v zypper &>/dev/null; then
        case "$pkg" in
            build-essential) echo "gcc gcc-c++ make" ;;
            ninja-build)     echo "ninja" ;;
            *)               echo "$pkg" ;;
        esac
    fi
}

# ── Step 1: Check & install prerequisites ───────────────────────────

echo "▸ [1/6] Checking prerequisites..."

MISSING_PKGS=()

# Build essentials (gcc, g++, make)
if ! command -v gcc &>/dev/null || ! command -v make &>/dev/null; then
    MISSING_PKGS+=("$(get_package_name build-essential)")
fi

# FreeRDP build tools
if ! "$APP_ONLY"; then
    if ! command -v cmake &>/dev/null; then
        MISSING_PKGS+=("cmake")
    fi

    if ! command -v ninja &>/dev/null; then
        MISSING_PKGS+=("$(get_package_name ninja-build)")
    fi

    if ! command -v patchelf &>/dev/null; then
        MISSING_PKGS+=("patchelf")
    fi

    if ! command -v pkg-config &>/dev/null; then
        MISSING_PKGS+=("pkg-config")
    fi

    if ! command -v nasm &>/dev/null; then
        MISSING_PKGS+=("nasm")
    fi
fi

# Python3 (needed for node-gyp)
if ! command -v python3 &>/dev/null; then
    MISSING_PKGS+=("python3")
fi

if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
    echo "  Installing: ${MISSING_PKGS[*]}..."
    install_packages "${MISSING_PKGS[@]}"
fi

echo "  ✓ Build tools (gcc, make, cmake, ninja, patchelf, pkg-config, nasm)"

# Node.js + npm
if ! command -v node &>/dev/null; then
    echo "  Node.js not found. Attempting to install..."

    if command -v apt-get &>/dev/null; then
        # NodeSource for Debian/Ubuntu
        echo "  Installing Node.js via NodeSource..."
        curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
        sudo apt-get install -y nodejs
    elif command -v dnf &>/dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
        sudo dnf install -y nodejs
    elif command -v pacman &>/dev/null; then
        sudo pacman -S --noconfirm nodejs npm
    elif command -v zypper &>/dev/null; then
        sudo zypper install -y nodejs20
    else
        echo "  ERROR: Cannot auto-install Node.js. Install manually from https://nodejs.org/"
        exit 1
    fi
fi
NODE_VERSION=$(node -v)
echo "  ✓ Node.js $NODE_VERSION"

if ! command -v npm &>/dev/null; then
    echo "  ERROR: npm not found even though Node.js is installed."
    exit 1
fi
echo "  ✓ npm $(npm -v)"
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
    if [ ! -f "$FREERDP_DIR/bundle/linux/conduit-freerdp" ]; then
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

    # 4b: Build the helper binary + bundle (build-linux.sh does both)
    echo ""
    echo "  Building + bundling conduit-freerdp..."
    bash "$FREERDP_DIR/scripts/build-linux.sh"
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

npx electron-builder --linux

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                    Build Complete!                          ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Output:"
ls -lh "$PROJECT_ROOT/release/"*.AppImage 2>/dev/null || echo "  (no .AppImage found)"
ls -lh "$PROJECT_ROOT/release/"*.deb 2>/dev/null || echo "  (no .deb found)"
echo ""
echo "To install:"
echo "  AppImage: chmod +x Conduit-*.AppImage && ./Conduit-*.AppImage"
echo "  Debian:   sudo dpkg -i conduit_*.deb"
