#
# build-windows.ps1 — Full Conduit build for Windows (prerequisites -> installable .exe)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1 -SkipDeps
#   powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1 -AppOnly
#
# Flags:
#   -SkipDeps  Skip building FreeRDP from source (use cached if available)
#   -AppOnly   Skip FreeRDP entirely, just build the Electron app
#
param(
    [switch]$SkipDeps,
    [switch]$AppOnly,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$FreerdpDir = Join-Path $ProjectRoot "freerdp-helper"

if ($Help) {
    Write-Host "Usage: build-windows.ps1 [-SkipDeps] [-AppOnly]"
    Write-Host ""
    Write-Host "  -SkipDeps  Skip building FreeRDP from source."
    Write-Host "             Uses cached deps if available. Still builds the helper binary + bundle."
    Write-Host "  -AppOnly   Skip FreeRDP entirely. Just build the Electron app."
    Write-Host ""
    Write-Host "First run takes ~10-20 min (FreeRDP builds from source)."
    Write-Host "Subsequent runs take ~1-2 min."
    exit 0
}

Set-Location $ProjectRoot

Write-Host ""
Write-Host "================================================================"
Write-Host "              Conduit - Windows Full Build                      "
Write-Host "================================================================"
Write-Host ""

# ── Step 1: Check & install prerequisites ─────────────────────────────

Write-Host "> [1/6] Checking prerequisites..."

function Test-Command($cmd) {
    try { Get-Command $cmd -ErrorAction Stop | Out-Null; return $true }
    catch { return $false }
}

$needsRestart = $false

# Check for winget (Windows Package Manager)
$hasWinget = Test-Command "winget"

# Git
if (-not (Test-Command "git")) {
    if ($hasWinget) {
        Write-Host "  Installing Git..."
        winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
        $needsRestart = $true
    } else {
        Write-Error "git not found. Install from https://git-scm.com/download/win"
        exit 1
    }
} else {
    Write-Host "  + Git"
}

# Node.js + npm
if (-not (Test-Command "node")) {
    if ($hasWinget) {
        Write-Host "  Installing Node.js..."
        winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
        $needsRestart = $true
    } else {
        Write-Error "node not found. Install from https://nodejs.org/"
        exit 1
    }
} else {
    $nodeVer = node -v
    Write-Host "  + Node.js $nodeVer"
}

if (-not (Test-Command "npm")) {
    Write-Error "npm not found even though Node.js is installed."
    exit 1
} else {
    $npmVer = npm -v
    Write-Host "  + npm $npmVer"
}

# CMake (needed for FreeRDP)
if (-not $AppOnly) {
    if (-not (Test-Command "cmake")) {
        if ($hasWinget) {
            Write-Host "  Installing CMake..."
            winget install --id Kitware.CMake -e --source winget --accept-package-agreements --accept-source-agreements
            $needsRestart = $true
        } else {
            Write-Error "cmake not found. Install from https://cmake.org/download/"
            exit 1
        }
    } else {
        Write-Host "  + CMake"
    }

    # Visual Studio Build Tools (needed for C++ compilation)
    $hasVS = Test-Command "cl"
    if (-not $hasVS) {
        # Check if VS Build Tools are installed but not in PATH
        $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
        if (Test-Path $vsWhere) {
            $vsPath = & $vsWhere -latest -property installationPath 2>$null
            if ($vsPath) {
                Write-Host "  + Visual Studio Build Tools (found, but cl.exe not in PATH)"
                Write-Host "    Hint: Run this script from 'Developer Command Prompt for VS 2022'"
                Write-Host "    Or: Run 'vcvarsall.bat x64' first to set up the environment"
            } else {
                Write-Host "  ! Visual Studio Build Tools not found"
                Write-Host "    Install from: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022"
                Write-Host "    Select 'Desktop development with C++' workload"
                Write-Host ""
                Write-Host "    Or via winget:"
                Write-Host "    winget install Microsoft.VisualStudio.2022.BuildTools --override `"--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive`""
                exit 1
            }
        } else {
            Write-Host "  ! Visual Studio Build Tools not found"
            Write-Host "    Install from: https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022"
            Write-Host "    Select 'Desktop development with C++' workload"
            if ($hasWinget) {
                Write-Host ""
                Write-Host "    Or install via winget:"
                Write-Host "    winget install Microsoft.VisualStudio.2022.BuildTools --override `"--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --passive`""
            }
            exit 1
        }
    } else {
        Write-Host "  + MSVC (cl.exe)"
    }
}

# Python (needed for node-gyp)
if (-not (Test-Command "python") -and -not (Test-Command "python3")) {
    if ($hasWinget) {
        Write-Host "  Installing Python..."
        winget install --id Python.Python.3.12 -e --source winget --accept-package-agreements --accept-source-agreements
        $needsRestart = $true
    } else {
        Write-Host "  ! Python not found (needed by node-gyp for native modules)"
        Write-Host "    Install from: https://www.python.org/downloads/"
    }
} else {
    Write-Host "  + Python"
}

if ($needsRestart) {
    Write-Host ""
    Write-Host "  Prerequisites were installed. Please restart your terminal and re-run this script."
    Write-Host "  (New PATH entries need a fresh terminal to take effect)"
    exit 1
}

Write-Host ""

# ── Step 2: Install npm dependencies ──────────────────────────────────

Write-Host "> [2/6] Installing npm dependencies..."

# Root project
$lockFile = Join-Path $ProjectRoot "node_modules\.package-lock.json"
if (-not (Test-Path (Join-Path $ProjectRoot "node_modules")) -or
    -not (Test-Path $lockFile) -or
    (Get-Item (Join-Path $ProjectRoot "package.json")).LastWriteTime -gt (Get-Item $lockFile).LastWriteTime) {
    npm install
} else {
    Write-Host "  Root dependencies up to date (skipping)"
}

# MCP server
$mcpDir = Join-Path $ProjectRoot "mcp"
$mcpLock = Join-Path $mcpDir "node_modules\.package-lock.json"
if (-not (Test-Path (Join-Path $mcpDir "node_modules")) -or
    -not (Test-Path $mcpLock) -or
    (Get-Item (Join-Path $mcpDir "package.json")).LastWriteTime -gt (Get-Item $mcpLock).LastWriteTime) {
    Push-Location $mcpDir
    npm install
    Pop-Location
} else {
    Write-Host "  MCP dependencies up to date (skipping)"
}

Write-Host ""

# ── Step 3: Build MCP server ──────────────────────────────────────────

Write-Host "> [3/6] Building MCP server..."
Push-Location (Join-Path $ProjectRoot "mcp")
npm run build
Pop-Location
Write-Host ""

# ── Step 4: Build FreeRDP helper ──────────────────────────────────────

if ($AppOnly) {
    Write-Host "> [4/6] Skipping FreeRDP build (-AppOnly)"
    $bundledExe = Join-Path $FreerdpDir "bundle\win32\conduit-freerdp.exe"
    if (-not (Test-Path $bundledExe)) {
        Write-Host "  ! Warning: No FreeRDP bundle found. RDP via FreeRDP engine will not work."
    }
} else {
    Write-Host "> [4/6] Building FreeRDP helper..."

    $buildScript = Join-Path $FreerdpDir "scripts\build-windows.ps1"
    $depsMarker = Join-Path $FreerdpDir "deps\install\lib\freerdp3.lib"

    if ($SkipDeps -and (Test-Path $depsMarker)) {
        Write-Host "  Using cached FreeRDP deps (-SkipDeps)"
        # Still build the helper binary + bundle
        & powershell -ExecutionPolicy Bypass -File $buildScript
    } else {
        if ($SkipDeps) {
            Write-Host "  ! -SkipDeps specified but no cached deps found. Building anyway..."
        }
        & powershell -ExecutionPolicy Bypass -File $buildScript
    }
}

Write-Host ""

# ── Step 5: Build frontend + Electron main process ───────────────────

Write-Host "> [5/6] Building application..."

Write-Host "  Building frontend (Vite)..."
npx vite build

Write-Host "  Building Electron main process..."
npx tsc -p electron/tsconfig.json

Write-Host ""

# ── Step 6: Package with electron-builder ─────────────────────────────

Write-Host "> [6/6] Packaging with electron-builder..."

$releaseDir = Join-Path $ProjectRoot "release"
if (Test-Path $releaseDir) { Remove-Item -Recurse -Force $releaseDir }

npx electron-builder --win

Write-Host ""
Write-Host "================================================================"
Write-Host "                    Build Complete!                              "
Write-Host "================================================================"
Write-Host ""
Write-Host "Output:"
Get-ChildItem (Join-Path $ProjectRoot "release\*.exe") -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "  $($_.Name) ($([math]::Round($_.Length / 1MB, 1)) MB)" }
Write-Host ""
Write-Host "Run the .exe installer to install Conduit."
