[CmdletBinding()]
param(
  [ValidateSet("Start", "Stop", "Status", "Logs")]
  [string]$Action = "Start",

  [Parameter(Mandatory = $true)]
  [string]$PluginRoot,

  [string]$GeoLibreRoot,

  [ValidateRange(1, 65535)]
  [int]$Port = 5173,

  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

function Resolve-ExistingDirectory([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Label directory does not exist: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Get-GeoLibreRoot([string]$RequestedRoot) {
  $candidates = [System.Collections.Generic.List[string]]::new()

  if ($RequestedRoot) { $candidates.Add($RequestedRoot) }
  if ($env:GEOLIBRE_ROOT) { $candidates.Add($env:GEOLIBRE_ROOT) }

  $desktopRoot = Join-Path ([Environment]::GetFolderPath("Desktop")) "GeoLibre"
  $candidates.Add($desktopRoot)
  $worktreesRoot = Join-Path $desktopRoot ".worktrees"
  if (Test-Path -LiteralPath $worktreesRoot -PathType Container) {
    Get-ChildItem -LiteralPath $worktreesRoot -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { $candidates.Add($_.FullName) }
  }
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    $appPackage = Join-Path $candidate "apps\geolibre-desktop\package.json"
    if (Test-Path -LiteralPath $appPackage -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw "No GeoLibre checkout was found. Pass -GeoLibreRoot or set GEOLIBRE_ROOT."
}

function Get-StatePaths([string]$PluginId, [int]$LocalPort) {
  $stateRoot = Join-Path ([System.IO.Path]::GetTempPath()) "geolibre-local-testing"
  New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
  $safeId = $PluginId -replace "[^A-Za-z0-9._-]", "_"
  return @{
    State = Join-Path $stateRoot "$safeId-$LocalPort.json"
    Stdout = Join-Path $stateRoot "$safeId-$LocalPort.log"
    Stderr = Join-Path $stateRoot "$safeId-$LocalPort-error.log"
  }
}

function Read-State([string]$StatePath) {
  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { return $null }
  try {
    return Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

$resolvedPluginRoot = Resolve-ExistingDirectory $PluginRoot "Plugin root"
$manifestPath = Join-Path $resolvedPluginRoot "geolibre-plugin\plugin.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Missing installable manifest: $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (-not $manifest.id) { throw "The plugin manifest does not contain an id." }

$paths = Get-StatePaths ([string]$manifest.id) $Port
$state = Read-State $paths.State

if ($Action -eq "Status") {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($listener) {
    Write-Output "running url=http://127.0.0.1:$Port/ pid=$($listener.OwningProcess)"
  } else {
    Write-Output "stopped url=http://127.0.0.1:$Port/"
  }
  if ($state) { Write-Output "state=$($paths.State)" }
  exit 0
}

if ($Action -eq "Logs") {
  Write-Output "stdout=$($paths.Stdout)"
  if (Test-Path -LiteralPath $paths.Stdout) { Get-Content -LiteralPath $paths.Stdout -Tail 100 }
  Write-Output "stderr=$($paths.Stderr)"
  if (Test-Path -LiteralPath $paths.Stderr) { Get-Content -LiteralPath $paths.Stderr -Tail 100 }
  exit 0
}

if ($Action -eq "Stop") {
  if (-not $state -or -not $state.pid) {
    Write-Output "No server started by this helper is recorded for $($manifest.id) on port $Port."
    exit 0
  }

  $process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $process.Id
    Write-Output "Stopped GeoLibre process $($process.Id)."
  } else {
    Write-Output "The recorded GeoLibre process is no longer running."
  }
  Remove-Item -LiteralPath $paths.State -Force -ErrorAction SilentlyContinue
  exit 0
}

$resolvedGeoLibreRoot = Get-GeoLibreRoot $GeoLibreRoot
$appRoot = Join-Path $resolvedGeoLibreRoot "apps\geolibre-desktop"
$packagePath = Join-Path $resolvedPluginRoot "package.json"
if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
  throw "Missing package.json in plugin root: $resolvedPluginRoot"
}

$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json

Push-Location $resolvedPluginRoot
try {
  if (-not (Test-Path -LiteralPath (Join-Path $resolvedPluginRoot "node_modules") -PathType Container)) {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed for the plugin." }
  }

  if ($package.scripts.build) {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Plugin build failed." }
  }
} finally {
  Pop-Location
}

$pluginParent = Join-Path $appRoot "public\plugins"
$pluginTarget = Join-Path $pluginParent ([string]$manifest.id)
New-Item -ItemType Directory -Path $pluginTarget -Force | Out-Null
Get-ChildItem -LiteralPath $pluginTarget -Force -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $resolvedPluginRoot "geolibre-plugin\*") `
  -Destination $pluginTarget -Recurse -Force

$installedManifest = Get-Content -LiteralPath (Join-Path $pluginTarget "plugin.json") -Raw |
  ConvertFrom-Json
if ($installedManifest.id -ne $manifest.id -or $installedManifest.version -ne $manifest.version) {
  throw "Installed manifest identity/version does not match the built plugin."
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1

if (-not $listener) {
  $process = Start-Process -FilePath "npm.cmd" `
    -ArgumentList @("run", "dev", "--", "--host", "127.0.0.1", "--port", "$Port") `
    -WorkingDirectory $appRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $paths.Stdout `
    -RedirectStandardError $paths.Stderr `
    -PassThru

  @{
    pid = $process.Id
    pluginId = $manifest.id
    pluginVersion = $manifest.version
    pluginRoot = $resolvedPluginRoot
    geoLibreRoot = $resolvedGeoLibreRoot
    port = $Port
  } | ConvertTo-Json | Set-Content -LiteralPath $paths.State
}

$ready = $false
for ($attempt = 0; $attempt -lt 90; $attempt += 1) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {
    Start-Sleep -Seconds 1
  }
}

if (-not $ready) { throw "GeoLibre did not become ready. Run this helper with -Action Logs." }

$url = "http://127.0.0.1:$Port/"
if (-not $NoBrowser) { Start-Process $url }

Write-Output "ready url=$url"
Write-Output "plugin=$($manifest.id) version=$($manifest.version)"
Write-Output "pluginRoot=$resolvedPluginRoot"
Write-Output "geoLibreRoot=$resolvedGeoLibreRoot"
Write-Output "stdout=$($paths.Stdout)"
Write-Output "stderr=$($paths.Stderr)"
