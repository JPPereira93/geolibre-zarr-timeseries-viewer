[CmdletBinding()]
param(
  [string]$GeoLibreRoot = "C:\Users\fuji_\Desktop\GeoLibre\.worktrees\zarr-plugin-host-api",
  [ValidateRange(1, 65535)]
  [int]$Port = 5173
)

$ErrorActionPreference = "Stop"
$pluginRoot = Split-Path -Parent $PSScriptRoot
$installedHelper = Join-Path $env:USERPROFILE ".codex\skills\geolibre-plugin-development\scripts\start_local_test.ps1"
$stagedHelper = "C:\Users\fuji_\Documents\ChatGPT\Geolibre\skill-updates\geolibre-plugin-development\scripts\start_local_test.ps1"
$helper = @($installedHelper, $stagedHelper) |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
  Select-Object -First 1

if (-not $helper) {
  throw "The GeoLibre local-test helper is missing. Reinstall the geolibre-plugin-development skill."
}

& $helper `
  -PluginRoot $pluginRoot `
  -GeoLibreRoot $GeoLibreRoot `
  -Port $Port `
  -OpenBrowser
