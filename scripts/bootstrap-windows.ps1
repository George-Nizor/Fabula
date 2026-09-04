# Deploys the Windows Electron runtime Fabula runs on, as the native bundle
# Instrumenta launches: dist\windows\electron.exe plus fabula-bundle.json.
#
# The app itself stays in this checkout and is handed to the runtime as its
# first argument, so edits are live and nothing is copied twice. Chromium
# cannot spawn its helper processes from a \\wsl.localhost path, which is why
# the runtime is a separate deploy (Instrumenta mirrors it to local disk before
# launching) while the application directory may stay on the share.
#
# Idempotent: a runtime already at the right version is left alone.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$FabulaRoot = Split-Path -Parent $PSScriptRoot
$BundleRoot = Join-Path $FabulaRoot 'dist\windows'
$Manifest = Join-Path $BundleRoot 'fabula-bundle.json'
$LocalRoot = Join-Path $env:LOCALAPPDATA 'Fabula'
$KnownRuntime = Join-Path $LocalRoot 'electron-win\electron.exe'
$Downloads = Join-Path $LocalRoot 'downloads'

function Write-Stage([string]$Message) {
    Write-Host "`n  $Message" -ForegroundColor Cyan
}

function Read-Json([string]$File) {
    return Get-Content -LiteralPath $File -Raw | ConvertFrom-Json
}

# The version Fabula develops against is the one its runtime must be.
$ElectronPackage = Join-Path $FabulaRoot 'node_modules\electron\package.json'
if (-not (Test-Path $ElectronPackage)) {
    throw "Fabula has no installed Electron at node_modules\electron. Run 'npm install' in $FabulaRoot first."
}
$ElectronVersion = (Read-Json $ElectronPackage).version
$FabulaVersion = (Read-Json (Join-Path $FabulaRoot 'package.json')).version
if (-not $ElectronVersion -or -not $FabulaVersion) {
    throw 'Could not read the Electron or Fabula version from package.json.'
}

function Get-RuntimeVersion([string]$Executable) {
    if (-not (Test-Path $Executable)) { return '' }
    $Info = (Get-Item -LiteralPath $Executable).VersionInfo
    $Version = $Info.ProductVersion
    if (-not $Version) { $Version = $Info.FileVersion }
    return [string]$Version
}

function Test-RuntimeCurrent([string]$Executable) {
    $Version = Get-RuntimeVersion $Executable
    return [bool]($Version -and $Version.StartsWith($ElectronVersion))
}

function Get-Runtime {
    # A runtime the owner already unpacked by hand is reused when it matches.
    if (Test-RuntimeCurrent $KnownRuntime) {
        Write-Stage "Reusing the Electron $ElectronVersion runtime at $(Split-Path -Parent $KnownRuntime)."
        return (Split-Path -Parent $KnownRuntime)
    }

    New-Item -ItemType Directory -Path $Downloads -Force | Out-Null
    $Asset = "electron-v$ElectronVersion-win32-x64.zip"
    $Zip = Join-Path $Downloads $Asset
    $Release = "https://github.com/electron/electron/releases/download/v$ElectronVersion"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    Write-Stage "Downloading Electron $ElectronVersion for Windows x64..."
    Invoke-WebRequest -Uri "$Release/$Asset" -OutFile $Zip -UseBasicParsing
    $Sums = (Invoke-WebRequest -Uri "$Release/SHASUMS256.txt" -UseBasicParsing).Content
    $Expected = ''
    foreach ($Line in ($Sums -split "`n")) {
        $Parts = $Line.Trim() -split '\s+\*?'
        if ($Parts.Length -ge 2 -and $Parts[1] -eq $Asset) { $Expected = $Parts[0].ToLowerInvariant() }
    }
    if (-not $Expected) { throw "SHASUMS256.txt for Electron $ElectronVersion does not list $Asset." }
    $Actual = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) {
        Remove-Item -LiteralPath $Zip -Force
        throw "Electron download failed its SHA-256 check (expected $Expected, got $Actual)."
    }

    $Extracted = Join-Path $Downloads "electron-v$ElectronVersion-win32-x64"
    if (Test-Path $Extracted) { Remove-Item -LiteralPath $Extracted -Recurse -Force }
    Write-Stage 'Extracting the verified runtime...'
    Expand-Archive -LiteralPath $Zip -DestinationPath $Extracted -Force
    if (-not (Test-Path (Join-Path $Extracted 'electron.exe'))) {
        throw 'The Electron archive did not contain electron.exe.'
    }
    return $Extracted
}

$DeployedExecutable = Join-Path $BundleRoot 'electron.exe'
if (Test-RuntimeCurrent $DeployedExecutable) {
    Write-Stage "dist\windows already carries Electron $ElectronVersion; leaving the runtime in place."
} else {
    $Runtime = Get-Runtime
    Write-Stage "Deploying the runtime to $BundleRoot..."
    if (Test-Path $BundleRoot) { Remove-Item -LiteralPath $BundleRoot -Recurse -Force }
    New-Item -ItemType Directory -Path $BundleRoot -Force | Out-Null
    Copy-Item -Path (Join-Path $Runtime '*') -Destination $BundleRoot -Recurse -Force
}

# The application directory is this checkout, as this script sees it: the UNC
# path when Windows reaches a WSL checkout, a local path otherwise. Instrumenta
# passes it to electron.exe on every launch and runtime check.
$Bundle = [ordered]@{
    schemaVersion = 1
    id = 'fabula'
    version = $FabulaVersion
    executable = 'electron.exe'
    arguments = @($FabulaRoot)
}
$Json = ($Bundle | ConvertTo-Json -Depth 3)
[IO.File]::WriteAllText($Manifest, $Json + "`n", (New-Object Text.UTF8Encoding $false))

Write-Stage "Fabula $FabulaVersion is deployed on Electron $ElectronVersion."
Write-Host "  bundle     $BundleRoot"
Write-Host "  manifest   $Manifest"
Write-Host "  app path   $FabulaRoot"
