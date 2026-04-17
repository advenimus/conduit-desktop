<#
.SYNOPSIS
    Builds the Conduit WebView2 helper for Windows x64 and ARM64.

.DESCRIPTION
    Publishes framework-dependent binaries (requires .NET 8 runtime on target).
    Output goes to bundle/win-x64/ and bundle/win-arm64/.
#>

param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

$projectPath = Join-Path $PSScriptRoot "ConduitWebView2" "ConduitWebView2.csproj"
$bundleDir = Join-Path $PSScriptRoot "bundle"

if ($Clean -and (Test-Path $bundleDir)) {
    Write-Host "Cleaning bundle directory..."
    Remove-Item -Recurse -Force $bundleDir
}

Write-Host "Building for win-x64..."
dotnet publish $projectPath `
    -c Release `
    -r win-x64 `
    --self-contained false `
    -o (Join-Path $bundleDir "win-x64")

Write-Host ""
Write-Host "Building for win-arm64..."
dotnet publish $projectPath `
    -c Release `
    -r win-arm64 `
    --self-contained false `
    -o (Join-Path $bundleDir "win-arm64")

Write-Host ""
Write-Host "Build complete."
Write-Host "  x64:   $(Join-Path $bundleDir 'win-x64')"
Write-Host "  ARM64: $(Join-Path $bundleDir 'win-arm64')"
