# Wraps `cargo tauri build` for CI + local manual builds. Mirrors
# mac/Scripts/package-app.sh: validates the version label, builds, computes
# SHA-256, prints artefact paths.
#
# Usage:
#   pwsh windows\scripts\build-msi.ps1 [-Version <label>]
# Default version: 'dev'.

param(
    [string]$Version = 'dev'
)

$ErrorActionPreference = 'Stop'

# Validate version so it can't be interpolated into shell weirdly.
if ($Version -notmatch '^[A-Za-z0-9._-]+$') {
    Write-Error "Invalid version label: '$Version'. Allowed: letters, digits, dot, dash, underscore."
    exit 1
}

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $root
try {
    Write-Host "▸ Installing frontend deps..."
    npm install --no-audit --no-fund

    Write-Host "▸ Stamping version $Version into tauri.conf.json..."
    $confPath = Join-Path $root 'src-tauri\tauri.conf.json'
    $conf = Get-Content $confPath -Raw | ConvertFrom-Json
    $conf.version = $Version -replace '^v', ''
    $conf | ConvertTo-Json -Depth 16 | Set-Content -Encoding UTF8 $confPath

    Write-Host "▸ Running cargo tauri build..."
    npm run tauri:build

    Write-Host "▸ Computing SHA-256 for artefacts..."
    $bundleDir = Join-Path $root 'src-tauri\target\release\bundle'
    $artefacts = Get-ChildItem -Path $bundleDir -Recurse -Include *.msi, *.exe
    if (-not $artefacts) {
        Write-Error "No .msi or .exe produced under $bundleDir"
        exit 1
    }
    foreach ($a in $artefacts) {
        $hash = (Get-FileHash -Algorithm SHA256 $a.FullName).Hash.ToLower()
        Set-Content -Encoding UTF8 -Path "$($a.FullName).sha256" -Value "$hash  $($a.Name)"
        Write-Host "  ✓ $($a.Name)  $hash"
    }

    Write-Host ""
    Write-Host "Bundle artefacts:"
    Get-ChildItem -Path $bundleDir -Recurse -Include *.msi, *.exe, *.sha256 |
        Select-Object Name, Length, FullName |
        Format-Table -AutoSize
}
finally {
    Pop-Location
}
