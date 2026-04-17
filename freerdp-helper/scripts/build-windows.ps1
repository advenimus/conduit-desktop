#
# build-windows.ps1 - Build conduit-freerdp helper binary on Windows.
#
# Prerequisites:
#   - Visual Studio Build Tools 2022 (C++ Desktop workload)
#   - CMake (3.16+)
#   - Perl (Strawberry Perl) — for building OpenSSL from source
#
# Dependencies built:
#   1. OpenSSL 3.4.1  (TLS/crypto — required by FreeRDP 3.15+)
#   2. zlib 1.3.1     (compression)
#   3. FreeRDP 3.15   (with Media Foundation for H.264)
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1 [-Clean]
#
param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

$OPENSSL_VERSION = "3.4.1"
$ZLIB_VERSION = "1.3.1"
$FREERDP_VERSION = "3.15.0"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$DepsDir = Join-Path $ProjectDir "deps"
$Prefix = Join-Path $DepsDir "install"
$BuildDir = Join-Path $ProjectDir "build-win"
$BundleDir = Join-Path (Join-Path $ProjectDir "bundle") "win32"

if ($Clean) {
    Write-Host "Cleaning all build artifacts..."
    if (Test-Path $DepsDir) { Remove-Item -Recurse -Force $DepsDir }
    if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
    if (Test-Path $BundleDir) { Remove-Item -Recurse -Force $BundleDir }
    Write-Host "Done. Run again without -Clean to rebuild."
    exit 0
}

Write-Host "=== Building conduit-freerdp (Windows) ==="
Write-Host "Project dir: $ProjectDir"
Write-Host "Install prefix: $Prefix"
Write-Host ""

# -- Helper: check exit code after native commands -------------------------

function Assert-ExitCode($step) {
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$step failed with exit code $LASTEXITCODE"
        exit $LASTEXITCODE
    }
}

# -- Check build tools -----------------------------------------------------

function Test-Command($cmd) {
    try { Get-Command $cmd -ErrorAction Stop | Out-Null; return $true }
    catch { return $false }
}

if (-not (Test-Command "cmake")) {
    Write-Error "cmake not found. Install from https://cmake.org/download/ or via 'winget install cmake'"
    exit 1
}

# Check for MSVC (cl.exe) - needed for nmake/OpenSSL builds.
# If not in PATH, auto-detect Visual Studio and source vcvarsall.bat.
if (-not (Test-Command "cl")) {
    Write-Host "cl.exe not found in PATH - searching for Visual Studio installation..."

    # Use vswhere (ships with VS 2017+ Build Tools) to locate the install
    $vswherePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswherePath)) {
        Write-Error "Visual Studio Build Tools not found. Install from https://visualstudio.microsoft.com/visual-cpp-build-tools/ with the Desktop development with C++ workload."
        exit 1
    }

    $vsPath = & $vswherePath -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vsPath) {
        Write-Error "No Visual Studio installation with C++ tools found. Install Visual Studio Build Tools with the Desktop development with C++ workload."
        exit 1
    }

    $vcvarsall = Join-Path $vsPath 'VC\Auxiliary\Build\vcvarsall.bat'
    if (-not (Test-Path $vcvarsall)) {
        Write-Error ('vcvarsall.bat not found at: ' + $vcvarsall)
        exit 1
    }

    Write-Host "  Found: $vsPath"
    Write-Host "  Sourcing MSVC environment (x64)..."

    # Write a temp batch file that sources vcvarsall then prints env vars.
    # This avoids PS5.1 parsing issues with &, &&, and redirection in strings.
    $tempBat = Join-Path $env:TEMP 'conduit_vcvars.bat'
    $line1 = '@call "' + $vcvarsall + '" x64 >nul 2>&1'
    $line2 = '@set'
    Set-Content -Path $tempBat -Value ($line1, $line2) -Encoding ASCII

    $envBlock = & cmd.exe /c $tempBat
    Remove-Item $tempBat -ErrorAction SilentlyContinue

    foreach ($entry in $envBlock) {
        if ($entry -match '^([^=]+)=(.*)$') {
            [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
        }
    }

    if (-not (Test-Command "cl")) {
        Write-Error "Failed to source MSVC environment. Please run from a Developer Command Prompt for VS 2022."
        exit 1
    }
    Write-Host "  MSVC environment loaded - cl.exe and nmake are now available."
    Write-Host ""
} else {
    Write-Host "MSVC tools found in PATH."
}

New-Item -ItemType Directory -Force -Path $DepsDir | Out-Null
New-Item -ItemType Directory -Force -Path $Prefix | Out-Null

# -- 1. Build OpenSSL -----------------------------------------------------

$OpenSSLSrc = Join-Path $DepsDir "openssl-src"
$OpenSSLMarker = Join-Path (Join-Path $Prefix "lib") "libssl.lib"

if (Test-Path $OpenSSLMarker) {
    Write-Host "[1/5] OpenSSL ${OPENSSL_VERSION} - already built"
} else {
    Write-Host "[1/5] Building OpenSSL ${OPENSSL_VERSION}..."

    # Perl is required for OpenSSL's Configure script
    if (-not (Test-Command "perl")) {
        Write-Error "perl not found. Install Strawberry Perl (https://strawberryperl.com/) or add it to PATH."
        exit 1
    }

    # Download OpenSSL source
    if (-not (Test-Path $OpenSSLSrc)) {
        $tarball = Join-Path $DepsDir "openssl-${OPENSSL_VERSION}.tar.gz"
        $url = "https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz"
        Write-Host "  Downloading: $url"
        Invoke-WebRequest -Uri $url -OutFile $tarball
        New-Item -ItemType Directory -Force -Path $OpenSSLSrc | Out-Null
        tar -xzf $tarball -C $OpenSSLSrc --strip-components=1
        Remove-Item $tarball
    }

    Push-Location $OpenSSLSrc

    # Configure for 64-bit Windows MSVC. no-asm avoids NASM dependency.
    perl Configure VC-WIN64A --prefix="$Prefix" --openssldir="$Prefix\ssl" shared no-tests no-docs no-asm
    Assert-ExitCode "OpenSSL configure"

    nmake
    Assert-ExitCode "OpenSSL build"

    nmake install_sw
    Assert-ExitCode "OpenSSL install"

    Pop-Location
    Write-Host "  OpenSSL installed to $Prefix"
}

# -- 2. Build zlib --------------------------------------------------------

$ZlibSrc = Join-Path $DepsDir "zlib-src"
$ZlibBuild = Join-Path $DepsDir "zlib-build"
$ZlibMarker = Join-Path (Join-Path $Prefix "lib") "zlib.lib"

if (Test-Path $ZlibMarker) {
    Write-Host "[2/5] zlib ${ZLIB_VERSION} - already built"
} else {
    Write-Host "[2/5] Building zlib ${ZLIB_VERSION}..."

    if (-not (Test-Path $ZlibSrc)) {
        $tarball = Join-Path $DepsDir "zlib-${ZLIB_VERSION}.tar.gz"
        $url = "https://github.com/madler/zlib/releases/download/v${ZLIB_VERSION}/zlib-${ZLIB_VERSION}.tar.gz"
        Write-Host "  Downloading: $url"
        Invoke-WebRequest -Uri $url -OutFile $tarball
        New-Item -ItemType Directory -Force -Path $ZlibSrc | Out-Null
        tar -xzf $tarball -C $ZlibSrc --strip-components=1
        Remove-Item $tarball
    }

    cmake -S $ZlibSrc -B $ZlibBuild `
        -DCMAKE_BUILD_TYPE=Release `
        -DCMAKE_INSTALL_PREFIX="$Prefix"
    Assert-ExitCode "zlib cmake configure"

    cmake --build $ZlibBuild --config Release --parallel
    Assert-ExitCode "zlib cmake build"

    cmake --install $ZlibBuild --config Release
    Assert-ExitCode "zlib cmake install"

    Write-Host "  zlib installed to $Prefix"
}

# -- 3. Build FreeRDP from source -----------------------------------------

$FreerdpSrc = Join-Path $DepsDir "freerdp-src"
$FreerdpBuild = Join-Path $DepsDir "freerdp-build"
$FreerdpMarker = Join-Path (Join-Path $Prefix "lib") "freerdp3.lib"

if (Test-Path $FreerdpMarker) {
    Write-Host "[3/5] FreeRDP ${FREERDP_VERSION} - already built"
} else {
    Write-Host "[3/5] Building FreeRDP ${FREERDP_VERSION}..."

    # Download and extract source
    if (-not (Test-Path $FreerdpSrc)) {
        $tarball = Join-Path $DepsDir "freerdp-${FREERDP_VERSION}.tar.gz"
        $url = "https://github.com/FreeRDP/FreeRDP/releases/download/${FREERDP_VERSION}/freerdp-${FREERDP_VERSION}.tar.gz"
        Write-Host "  Downloading: $url"
        Invoke-WebRequest -Uri $url -OutFile $tarball
        New-Item -ItemType Directory -Force -Path $FreerdpSrc | Out-Null
        tar -xzf $tarball -C $FreerdpSrc --strip-components=1
        Remove-Item $tarball
    }

    # Configure with Visual Studio generator
    # Uses locally-built OpenSSL + Media Foundation for H.264 (no FFmpeg on Windows)
    cmake -S $FreerdpSrc -B $FreerdpBuild `
        -DCMAKE_BUILD_TYPE=Release `
        -DCMAKE_INSTALL_PREFIX="$Prefix" `
        -DCMAKE_PREFIX_PATH="$Prefix" `
        -DOPENSSL_ROOT_DIR="$Prefix" `
        -DBUILD_SHARED_LIBS=ON `
        -DWITH_FFMPEG=OFF `
        -DWITH_SWSCALE=OFF `
        -DWITH_MEDIA_FOUNDATION=OFF `
        -DWITH_CLIENT=ON `
        -DWITH_CLIENT_SDL=OFF `
        -DWITH_CLIENT_SDL2=OFF `
        -DWITH_CLIENT_SDL3=OFF `
        -DWITH_SERVER=OFF `
        -DWITH_SHADOW=OFF `
        -DWITH_PROXY=OFF `
        -DWITH_SAMPLE=OFF `
        -DWITH_MANPAGES=OFF `
        -DWITH_X11=OFF `
        -DWITH_WEBVIEW=OFF `
        -DWITH_JPEG=OFF `
        -DWITH_GFX_H264=OFF `
        -DWITH_JSON_DISABLED=ON `
        -DWITH_PCSC=OFF `
        -DWITH_CUPS=OFF `
        -DWITH_PULSE=OFF `
        -DWITH_ALSA=OFF `
        -DWITH_OSS=OFF `
        -DWITH_FUSE=OFF `
        -DCHANNEL_URBDRC=OFF `
        -DWITH_SIMD=OFF `
        -DUSE_VERSION_FROM_GIT_TAG=OFF
    Assert-ExitCode "FreeRDP cmake configure"

    cmake --build $FreerdpBuild --config Release --parallel
    Assert-ExitCode "FreeRDP cmake build"

    cmake --install $FreerdpBuild --config Release
    Assert-ExitCode "FreeRDP cmake install"

    Write-Host "  FreeRDP installed to $Prefix"
}

# -- 4. Build conduit-freerdp ---------------------------------------------

Write-Host "[4/5] Building conduit-freerdp..."
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

cmake -S $ProjectDir -B $BuildDir `
    -DCMAKE_BUILD_TYPE=Release `
    -DCMAKE_PREFIX_PATH="$Prefix"
Assert-ExitCode "conduit-freerdp cmake configure"

cmake --build $BuildDir --config Release
Assert-ExitCode "conduit-freerdp cmake build"

$Binary = Join-Path (Join-Path $BuildDir "Release") "conduit-freerdp.exe"
if (-not (Test-Path $Binary)) {
    # Some generators put it directly in build dir
    $Binary = Join-Path $BuildDir "conduit-freerdp.exe"
}

if (-not (Test-Path $Binary)) {
    Write-Error "Build failed: conduit-freerdp.exe not found"
    exit 1
}

Write-Host "  Binary: $Binary"

# -- 5. Bundle binary + DLLs ----------------------------------------------

Write-Host "[5/5] Creating bundle..."

if (Test-Path $BundleDir) { Remove-Item -Recurse -Force $BundleDir }
New-Item -ItemType Directory -Force -Path $BundleDir | Out-Null

# Copy binary
Copy-Item $Binary $BundleDir

# Copy DLLs from install prefix bin/ (OpenSSL, FreeRDP DLLs)
$DllDir = Join-Path $Prefix "bin"
if (Test-Path $DllDir) {
    $dlls = Get-ChildItem -Path $DllDir -Filter "*.dll"
    foreach ($dll in $dlls) {
        Copy-Item $dll.FullName $BundleDir
        Write-Host "  Copied: $($dll.Name)"
    }
}

# Also check lib/ for DLLs (some CMake configs put them there)
$LibDir = Join-Path $Prefix "lib"
if (Test-Path $LibDir) {
    $libDlls = Get-ChildItem -Path $LibDir -Filter "*.dll" -ErrorAction SilentlyContinue
    foreach ($dll in $libDlls) {
        if (-not (Test-Path (Join-Path $BundleDir $dll.Name))) {
            Copy-Item $dll.FullName $BundleDir
            Write-Host "  Copied: $($dll.Name)"
        }
    }
}

# Copy OpenSSL modules (legacy provider - required for NTLM/md4/rc4)
$OsslModulesDir = Join-Path $LibDir "ossl-modules"
if (Test-Path $OsslModulesDir) {
    $BundleOsslDir = Join-Path $BundleDir "ossl-modules"
    New-Item -ItemType Directory -Force -Path $BundleOsslDir | Out-Null
    $modules = Get-ChildItem -Path $OsslModulesDir -Filter "*.dll" -ErrorAction SilentlyContinue
    foreach ($mod in $modules) {
        Copy-Item $mod.FullName $BundleOsslDir
        Write-Host "  Copied: ossl-modules/$($mod.Name)"
    }
} else {
    Write-Warning "ossl-modules directory not found at $OsslModulesDir - NTLM/NLA auth may not work!"
}

# -- Verify ----------------------------------------------------------------

Write-Host ""
Write-Host "=== Bundle complete ==="
Write-Host "Bundle dir: $BundleDir"
Get-ChildItem $BundleDir | Format-Table Name, Length -AutoSize

$bundledExe = Join-Path $BundleDir "conduit-freerdp.exe"
if (Test-Path $bundledExe) {
    Write-Host "Bundle verified: conduit-freerdp.exe present"
} else {
    Write-Error "Bundle verification failed: conduit-freerdp.exe not found in bundle"
    exit 1
}
