# Building the FreeRDP Helper Binary

The `conduit-freerdp` C helper binary provides headless RDP connectivity for Conduit. It communicates with the Electron main process via stdin (JSON commands) and stdout (binary-framed bitmap updates).

## Architecture

```
Electron Main Process
    ├── stdin → JSON commands (connect, mouse, keyboard, resize, disconnect)
    └── stdout ← Binary frames (connected, bitmap_update, resized, disconnected, error)
          └── conduit-freerdp (C binary, spawned as child process)
                └── FreeRDP 3.x library (handles RDP protocol)
```

## Prerequisites

### macOS

```bash
# Xcode command line tools (provides clang, make)
xcode-select --install

# Build tools
brew install cmake ninja

# Optional: NASM for OpenSSL x86_64 assembly optimizations
brew install nasm  # Only needed on Intel Macs
```

### Windows

- **Visual Studio Build Tools 2022** with "Desktop development with C++" workload
  - Download from: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022
- **CMake** 3.16+ (included with VS Build Tools, or install separately)
- **Git** (for downloading FreeRDP source)

Windows builds use native SChannel (TLS) and Media Foundation (H.264), so OpenSSL and FFmpeg are not required.

### Linux (Ubuntu/Debian)

```bash
sudo apt-get install cmake ninja-build patchelf pkg-config \
    build-essential nasm
```

## Local Build

### macOS

```bash
cd freerdp-helper

# Step 1: Build dependencies (OpenSSL, FFmpeg, FreeRDP) — first time only, ~10-20 min
bash build-freerdp.sh

# Step 2: Build the helper binary
bash scripts/build-macos.sh

# Step 3: Create self-contained bundle (collects dylibs, fixes rpaths)
bash scripts/bundle-macos.sh

# Output: bundle/darwin/conduit-freerdp + dylibs
```

### Windows

```powershell
cd freerdp-helper

# Single script handles everything (deps + build + bundle)
powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1

# Output: bundle/win32/conduit-freerdp.exe + DLLs
```

### Linux

```bash
cd freerdp-helper

# Step 1: Build dependencies (same script as macOS, auto-detects Linux)
bash build-freerdp.sh

# Step 2: Build binary + create bundle (patchelf for RPATH)
bash scripts/build-linux.sh

# Output: bundle/linux/conduit-freerdp + .so files
```

## Development Workflow

During development, the Electron app auto-detects the binary at:
- **macOS**: `freerdp-helper/bundle/darwin/conduit-freerdp`
- **Windows**: `freerdp-helper/bundle/win32/conduit-freerdp.exe`
- **Linux**: `freerdp-helper/bundle/linux/conduit-freerdp`

If the binary is missing, the auto-build system (`build-helper.ts`) will attempt to build it automatically on first use.

For production builds, `electron-builder` copies the platform-specific bundle into the app's `resources/freerdp/` directory.

## CI/CD

GitHub Actions builds the helper binary for all platforms on:
- Push/PR changes to `freerdp-helper/**`
- Tag push (`v*`) — creates a GitHub Release with platform bundles

See `.github/workflows/build-freerdp.yml` for the full workflow.

### Build Matrix

| Runner | Platform | Architecture |
|--------|----------|--------------|
| `macos-14` | darwin | arm64 |
| `macos-13` | darwin | x86_64 |
| `windows-latest` | win32 | x64 |
| `ubuntu-latest` | linux | x64 |

Dependencies are cached between CI runs using `actions/cache` keyed on the build script hash.

## Clean Build

To start fresh, remove all build artifacts:

```bash
# macOS/Linux
cd freerdp-helper
bash build-freerdp.sh --clean
rm -rf build bundle/darwin bundle/linux

# Windows
cd freerdp-helper
powershell -File scripts/build-windows.ps1 -Clean
```

## Troubleshooting

### macOS: "library not loaded" at runtime

The bundle script should handle this, but if you see dylib loading errors:
1. Run `otool -L bundle/darwin/conduit-freerdp` to check references
2. All non-system references should start with `@loader_path/`
3. Re-run `bash scripts/bundle-macos.sh` to fix

### Windows: CMake can't find Visual Studio

Run the build from a **Developer Command Prompt for VS 2022**, or ensure the "Desktop development with C++" workload is installed in VS Build Tools.

### Linux: "patchelf: command not found"

```bash
sudo apt-get install patchelf
```

### All platforms: Dependencies fail to build

```bash
# Clean and rebuild from scratch
bash build-freerdp.sh --clean  # or -Clean on Windows
bash build-freerdp.sh          # Rebuild
```

### Auto-build takes too long

The first build downloads and compiles OpenSSL + FFmpeg + FreeRDP from source (~10-20 min on macOS/Linux). Subsequent builds only recompile the helper binary (~5 seconds) since dependencies are cached in `deps/install/`.
