[CmdletBinding()]
param(
  [string]$DataDirectory,
  [ValidateRange(1, 65535)]
  [int]$Port = 3000,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Stop-RestaurantPOS.ps1') -DataDirectory $DataDirectory
& (Join-Path $PSScriptRoot 'Start-RestaurantPOS.ps1') -DataDirectory $DataDirectory -Port $Port -NoBrowser:$NoBrowser
