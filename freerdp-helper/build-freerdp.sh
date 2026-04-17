#!/bin/bash
#
# Build FreeRDP3 and all dependencies from source for conduit-freerdp.
# No Homebrew or system package manager dependencies required.
#
# Dependencies built:
#   1. OpenSSL 3.x   (TLS/crypto for RDP)
#   2. FFmpeg minimal (H.264 codec for GFX pipeline)
#   3. FreeRDP 3.15   (with BUILTIN_CHANNELS=ON for RDPDR)
#
# Usage: bash build-freerdp.sh [--clean]
#
set -e

OPENSSL_VERSION="3.4.1"
FFMPEG_VERSION="7.1"
FREERDP_VERSION="3.15.0"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPS_DIR="$SCRIPT_DIR/deps"
OS=$(uname -s)   # Darwin or Linux
ARCH=$(uname -m)
# Detect native architecture even under Rosetta
if [ "$OS" = "Darwin" ] && [ "$ARCH" = "x86_64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
    ARCH="arm64"
fi
NCPU=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)

# Platform-specific library extension
if [ "$OS" = "Darwin" ]; then
    LIB_EXT="dylib"
else
    LIB_EXT="so"
fi

# All deps install to a shared prefix so cmake/pkg-config finds everything
PREFIX="$DEPS_DIR/install"

if [ "$1" = "--clean" ]; then
    echo "Cleaning all dependency builds..."
    rm -rf "$DEPS_DIR"
    echo "Done. Run again without --clean to rebuild."
    exit 0
fi

echo "=== Building FreeRDP ${FREERDP_VERSION} + dependencies from source ==="
echo "Architecture: $ARCH"
echo "CPU cores: $NCPU"
echo "Install prefix: $PREFIX"
echo ""

# Check build tools
for tool in cmake ninja cc; do
    if ! command -v "$tool" &>/dev/null; then
        echo "Error: $tool not found."
        echo "  macOS:    xcode-select --install && pip3 install cmake ninja"
        echo "  Windows:  choco install cmake ninja visualstudio2022buildtools"
        echo "  Linux:    apt install cmake ninja-build build-essential"
        exit 1
    fi
done

# NASM is needed for OpenSSL assembly optimizations on x86_64
if [ "$ARCH" = "x86_64" ] && ! command -v nasm &>/dev/null; then
    echo "Warning: nasm not found, OpenSSL will build without x86 assembly optimizations"
fi

mkdir -p "$DEPS_DIR" "$PREFIX"

# ── Helper to download + extract ─────────────────────────────────────

download_extract() {
    local url="$1"
    local dest="$2"
    local tarball="$DEPS_DIR/$(basename "$url")"

    if [ -d "$dest" ]; then
        echo "  Source already exists: $dest"
        return
    fi

    echo "  Downloading: $url"
    curl -L "$url" -o "$tarball"
    mkdir -p "$dest"
    tar xzf "$tarball" -C "$dest" --strip-components=1
    rm "$tarball"
}

# ── 1. Build OpenSSL ─────────────────────────────────────────────────

build_openssl() {
    local SRC="$DEPS_DIR/openssl-src"
    local BUILD_MARKER="$PREFIX/lib/libssl.${LIB_EXT}"

    if [ -f "$BUILD_MARKER" ]; then
        echo "[1/3] OpenSSL ${OPENSSL_VERSION} — already built"
        return
    fi

    echo "[1/3] Building OpenSSL ${OPENSSL_VERSION}..."
    download_extract \
        "https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz" \
        "$SRC"

    cd "$SRC"

    local target
    if [ "$OS" = "Darwin" ]; then
        if [ "$ARCH" = "arm64" ]; then
            target="darwin64-arm64-cc"
        else
            target="darwin64-x86_64-cc"
        fi
    else
        # Linux
        if [ "$ARCH" = "aarch64" ]; then
            target="linux-aarch64"
        else
            target="linux-x86_64"
        fi
    fi

    ./Configure "$target" \
        --prefix="$PREFIX" \
        --openssldir="$PREFIX/ssl" \
        --libdir=lib \
        shared \
        enable-legacy \
        no-tests \
        no-docs

    make -j"$NCPU"
    make install_sw  # skip docs/manpages

    # Verify legacy provider was built (required for NTLM/NLA auth)
    if [ ! -f "$PREFIX/lib/ossl-modules/legacy.${LIB_EXT}" ]; then
        echo "ERROR: OpenSSL legacy provider not found at $PREFIX/lib/ossl-modules/legacy.${LIB_EXT}"
        echo "NTLM authentication will not work without it."
        exit 1
    fi
    echo "  OpenSSL installed to $PREFIX (legacy provider: OK)"
}

# ── 2. Build FFmpeg (minimal — just codecs for H.264) ────────────────

build_ffmpeg() {
    local SRC="$DEPS_DIR/ffmpeg-src"
    local BUILD_MARKER="$PREFIX/lib/libavcodec.${LIB_EXT}"

    if [ -f "$BUILD_MARKER" ]; then
        echo "[2/3] FFmpeg ${FFMPEG_VERSION} — already built"
        return
    fi

    echo "[2/3] Building FFmpeg ${FFMPEG_VERSION} (minimal)..."
    download_extract \
        "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.gz" \
        "$SRC"

    cd "$SRC"

    # Minimal build: only libavcodec + libavutil (needed by FreeRDP for H.264)
    local FFMPEG_EXTRA_FLAGS=""
    local EXTRA_CFLAGS="-I${PREFIX}/include"
    local EXTRA_LDFLAGS="-L${PREFIX}/lib"

    if [ "$ARCH" = "x86_64" ] && ! command -v nasm &>/dev/null; then
        FFMPEG_EXTRA_FLAGS="--disable-x86asm"
    fi

    # macOS cross-compilation: ensure compiler targets arm64 when building for arm64.
    # The GitHub Actions runner may run as x86_64 under Rosetta on Apple Silicon,
    # so FFmpeg's configure auto-detects x86_64 unless we explicitly set -arch arm64.
    if [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
        EXTRA_CFLAGS="$EXTRA_CFLAGS -arch arm64"
        EXTRA_LDFLAGS="$EXTRA_LDFLAGS -arch arm64"
    fi

    # Fix FFmpeg 7.1 CABAC assembly error on ARM64 (Apple Clang rejects "I" constraint
    # for values like 512, 1152 in inline asm operands). Replace constraint "I" with "i"
    # only in operand positions (preceded by ] from symbolic name bracket), not in
    # assembly template strings. This is safe because ] doesn't appear in ARM64 asm.
    if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "aarch64" ]; then
        local CABAC_FILE="libavcodec/aarch64/cabac.h"
        if [ -f "$CABAC_FILE" ] && grep -q '"I"(' "$CABAC_FILE"; then
            echo "  Patching $CABAC_FILE (ARM64 asm constraint fix)..."
            if [ "$OS" = "Darwin" ]; then
                sed -i '' 's/\]"I"(/\]"i"(/g' "$CABAC_FILE"
            else
                sed -i 's/\]"I"(/\]"i"(/g' "$CABAC_FILE"
            fi
        fi
    fi

    ./configure \
        --prefix="$PREFIX" \
        --arch="$ARCH" \
        --enable-shared \
        --disable-static \
        --disable-programs \
        --disable-doc \
        --disable-htmlpages \
        --disable-manpages \
        --disable-podpages \
        --disable-txtpages \
        --disable-network \
        --disable-everything \
        --enable-decoder=h264 \
        --enable-decoder=hevc \
        --enable-parser=h264 \
        --enable-parser=hevc \
        --enable-swscale \
        --disable-xlib \
        --disable-libxcb \
        --extra-cflags="$EXTRA_CFLAGS" \
        --extra-ldflags="$EXTRA_LDFLAGS" \
        $FFMPEG_EXTRA_FLAGS

    make -j"$NCPU"
    make install
    echo "  FFmpeg installed to $PREFIX"
}

# ── 3. Build FreeRDP ─────────────────────────────────────────────────

build_freerdp() {
    local SRC="$DEPS_DIR/freerdp-src"
    local BUILD="$DEPS_DIR/freerdp-build"
    local BUILD_MARKER="$PREFIX/lib/libfreerdp0.${LIB_EXT}"

    if [ -f "$BUILD_MARKER" ]; then
        echo "[3/3] FreeRDP ${FREERDP_VERSION} — already built"
        return
    fi

    echo "[3/3] Building FreeRDP ${FREERDP_VERSION} (BUILTIN_CHANNELS=ON)..."
    download_extract \
        "https://github.com/FreeRDP/FreeRDP/releases/download/${FREERDP_VERSION}/freerdp-${FREERDP_VERSION}.tar.gz" \
        "$SRC"

    # Point cmake to our local deps ONLY — exclude system/Homebrew paths
    export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:$PREFIX/lib64/pkgconfig"
    export CMAKE_PREFIX_PATH="$PREFIX"

    # Platform-specific cmake flags
    local PLATFORM_FLAGS=""
    if [ "$OS" = "Darwin" ]; then
        PLATFORM_FLAGS="-DCMAKE_OSX_ARCHITECTURES=$ARCH -DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local"
    fi

    cmake -S "$SRC" -B "$BUILD" -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$PREFIX" \
        -DCMAKE_INSTALL_LIBDIR=lib \
        -DCMAKE_PREFIX_PATH="$PREFIX" \
        $PLATFORM_FLAGS \
        -DOPENSSL_ROOT_DIR="$PREFIX" \
        -DBUILD_SHARED_LIBS=ON \
        -DWITH_CLIENT=ON \
        -DWITH_CLIENT_SDL=OFF \
        -DWITH_CLIENT_SDL2=OFF \
        -DWITH_CLIENT_SDL3=OFF \
        -DWITH_CLIENT_MAC=OFF \
        -DWITH_SERVER=OFF \
        -DWITH_SHADOW=OFF \
        -DWITH_PROXY=OFF \
        -DWITH_SAMPLE=OFF \
        -DWITH_MANPAGES=OFF \
        -DWITH_X11=OFF \
        -DWITH_WEBVIEW=OFF \
        -DWITH_JPEG=OFF \
        -DWITH_GFX_H264=ON \
        -DWITH_FFMPEG=ON \
        -DWITH_JSON_DISABLED=ON \
        -DWITH_PCSC=OFF \
        -DWITH_CUPS=OFF \
        -DWITH_PULSE=OFF \
        -DWITH_ALSA=OFF \
        -DWITH_OSS=OFF \
        -DWITH_FUSE=OFF \
        -DCHANNEL_URBDRC=OFF \
        -DWITH_SIMD=OFF \
        -DUSE_VERSION_FROM_GIT_TAG=OFF

    cmake --build "$BUILD" -j"$NCPU"
    cmake --install "$BUILD"
    echo "  FreeRDP installed to $PREFIX"
}

# ── Run all builds ───────────────────────────────────────────────────

build_openssl
build_ffmpeg
build_freerdp

echo ""
echo "=== All dependencies built ==="
echo "Install prefix: $PREFIX"
echo "Libraries:      $PREFIX/lib/"
echo "Headers:        $PREFIX/include/"
echo "Pkg-config:     $PREFIX/lib/pkgconfig/"
echo ""
echo "Next: cd build && cmake .. -G Ninja && ninja"
