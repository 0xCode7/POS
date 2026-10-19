[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$release = Join-Path $root 'release\windows'
$electron = Join-Path $root 'release\electron\win-unpacked'

foreach ($name in @('RestaurantPOS-Setup.exe', 'RestaurantPOS-Portable.zip', 'SHA256SUMS.txt')) {
  $path = Join-Path $release $name
  if (-not (Test-Path -LiteralPath $path) -or (Get-Item -LiteralPath $path).Length -le 0) {
    throw "Missing Electron release artifact: $path"
  }
}

$expected = @{}
foreach ($line in Get-Content (Join-Path $release 'SHA256SUMS.txt')) {
  if ($line -notmatch '^([a-f0-9]{64}) \*(.+)$') { throw "Invalid checksum line: $line" }
  $expected[$Matches[2]] = $Matches[1]
}
foreach ($name in @('RestaurantPOS-Portable.zip', 'RestaurantPOS-Setup.exe')) {
  $actual = (Get-FileHash -LiteralPath (Join-Path $release $name) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected[$name]) { throw "SHA-256 mismatch for $name" }
}

$setupBytes = [System.IO.File]::ReadAllBytes((Join-Path $release 'RestaurantPOS-Setup.exe'))
if ($setupBytes.Length -lt 2 -or $setupBytes[0] -ne 0x4D -or $setupBytes[1] -ne 0x5A) {
  throw 'Electron installer is not a Windows executable.'
}

$portableCheck = Join-Path ([System.IO.Path]::GetTempPath()) ("restaurant-pos-electron-package-" + [guid]::NewGuid())
try {
  Expand-Archive -LiteralPath (Join-Path $release 'RestaurantPOS-Portable.zip') -DestinationPath $portableCheck -Force
  if (-not (Get-ChildItem -LiteralPath $portableCheck -Filter '*.exe' -File -Recurse | Select-Object -First 1)) {
    throw 'Portable ZIP does not contain an Electron executable.'
  }
  foreach ($native in @(
    (Join-Path $electron 'resources\app\node_modules\better-sqlite3\build\Release\better_sqlite3.node'),
    (Join-Path $electron 'resources\app\node_modules\argon2\prebuilds\win32-x64\argon2.glibc.node')
  )) {
    if (-not (Test-Path -LiteralPath $native)) {
      throw "Required Windows native module is missing from Electron package: $native"
    }
  }
} finally {
  Remove-Item -LiteralPath $portableCheck -Force -Recurse -ErrorAction SilentlyContinue
}

Write-Host 'Electron package structure and checksums verified. Interactive Windows startup, restore, and printer validation remain required.'
