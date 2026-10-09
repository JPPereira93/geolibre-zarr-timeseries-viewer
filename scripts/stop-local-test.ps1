$ErrorActionPreference = "Stop"

$listener = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $listener) {
  Write-Host "No local GeoLibre server is listening on port 5173."
  exit 0
}

Stop-Process -Id $listener.OwningProcess
Write-Host "Stopped the local GeoLibre server on port 5173."
