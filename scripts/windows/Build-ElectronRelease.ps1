[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $root

npm run desktop:build
if ($LASTEXITCODE -ne 0) { throw 'Electron desktop build failed.' }
npm run package:win --workspace '@restaurant-pos/desktop'
if ($LASTEXITCODE -ne 0) { throw 'Electron Windows package failed.' }

$source = Join-Path $root 'release\electron'
$output = Join-Path $root 'release\windows'
Remove-Item -LiteralPath $output -Force -Recurse -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $output -Force | Out-Null

$setup = Get-ChildItem -LiteralPath $source -File -Filter '*-nsis.exe' | Select-Object -First 1
$portable = Get-ChildItem -LiteralPath $source -File -Filter '*-portable.exe' | Select-Object -First 1
if (-not $setup -or -not $portable) {
  throw "Expected Electron NSIS and portable executables in $source"
}

Copy-Item -LiteralPath $setup.FullName -Destination (Join-Path $output 'RestaurantPOS-Setup.exe')
Compress-Archive -LiteralPath $portable.FullName -DestinationPath (Join-Path $output 'RestaurantPOS-Portable.zip') -CompressionLevel Optimal

$checksums = @('RestaurantPOS-Portable.zip', 'RestaurantPOS-Setup.exe') | ForEach-Object {
  $hash = (Get-FileHash -LiteralPath (Join-Path $output $_) -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash *$_"
}
Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Value $checksums -Encoding ascii
Get-ChildItem -LiteralPath $output -File | Select-Object Name, Length
