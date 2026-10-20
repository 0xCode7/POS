[CmdletBinding()]
param(
  [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$ReleaseVersion,
  [string]$NodeZip,
  [string]$NodeZipSha256,
  [string]$NpmCache,
  [string]$InnoSetupCompiler,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) { throw "Windows release: $Message" }
function Invoke-External([string]$File, [string[]]$Arguments, [string]$WorkingDirectory) {
  Push-Location $WorkingDirectory
  try {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "command failed: $File $($Arguments -join ' ')" }
  } finally { Pop-Location }
}
function Find-Iscc([string]$Configured) {
  if ($Configured) {
    if (-not (Test-Path -LiteralPath $Configured)) { Fail "Inno Setup compiler was not found: $Configured" }
    return [IO.Path]::GetFullPath($Configured)
  }
  $default = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
  if (Test-Path -LiteralPath $default) { return $default }
  $command = Get-Command iscc.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  Fail 'Inno Setup 6 is required. Install it on the Windows release machine, then retry.'
}

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
  Fail 'this release build must run on Windows x64.'
}
$source = [IO.Path]::GetFullPath($SourceRoot)
$package = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
if (-not $ReleaseVersion) { $ReleaseVersion = $package.version }
if ($ReleaseVersion -notmatch '^\d+\.\d+\.\d+$') {
  Fail 'Inno Setup requires a numeric major.minor.patch release version.'
}
$release = Join-Path $source 'release\windows'
$portable = Join-Path $release 'RestaurantPOS-portable'
$zip = Join-Path $release 'RestaurantPOS-Portable.zip'
$setup = Join-Path $release 'RestaurantPOS-Setup.exe'
$checksums = Join-Path $release 'SHA256SUMS.txt'
if ((Test-Path -LiteralPath $release) -and -not $Force) {
  Fail "release output already exists: $release. Use -Force only after preserving the required artifact."
}

$portableArguments = @{
  SourceRoot = $source
  OutputDirectory = $portable
  ReleaseVersion = $ReleaseVersion
  Force = $true
}
if ($NodeZip) {
  $portableArguments.NodeZip = [IO.Path]::GetFullPath($NodeZip)
  $portableArguments.NodeZipSha256 = $NodeZipSha256
}
if ($NpmCache) { $portableArguments.NpmCache = [IO.Path]::GetFullPath($NpmCache) }
& (Join-Path $PSScriptRoot 'Build-Portable.ps1') @portableArguments
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Fail 'portable build failed.' }
foreach ($required in @(
  (Join-Path $portable 'runtime\node.exe'),
  (Join-Path $portable 'app\server\dist\maintenance\supervisor-cli.js'),
  (Join-Path $portable 'app\client\dist\index.html'),
  (Join-Path $portable 'Launch-RestaurantPOS.vbs')
)) {
  if (-not (Test-Path -LiteralPath $required)) { Fail "portable release is incomplete: $required" }
}
$portableNode = Join-Path $portable 'runtime\node.exe'
Invoke-External $portableNode @('-e', "const Database=require('better-sqlite3'); const argon2=require('argon2'); if(process.platform!=='win32'||process.arch!=='x64'||typeof argon2.hash!=='function') process.exit(1); const db=new Database(':memory:'); db.exec('create table native_check(id integer primary key)'); db.close();") (Join-Path $portable 'app')

if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Push-Location $release
try { Compress-Archive -LiteralPath $portable -DestinationPath $zip -CompressionLevel Optimal -Force } finally { Pop-Location }
if (-not (Test-Path -LiteralPath $zip)) { Fail 'Portable zip was not created.' }

$iscc = Find-Iscc $InnoSetupCompiler
Invoke-External $iscc @(
  "/DSourceRoot=$source",
  "/DReleaseDirectory=$release",
  "/DReleaseVersion=$ReleaseVersion",
  (Join-Path $source 'scripts\windows\RestaurantPOS.iss')
) $source
if (-not (Test-Path -LiteralPath $setup)) { Fail 'Setup.exe was not created.' }

$entries = @($zip, $setup) | ForEach-Object {
  $hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash *$([IO.Path]::GetFileName($_))"
}
Set-Content -LiteralPath $checksums -Value $entries -Encoding ascii
Write-Host "Windows release completed: $release"
Get-Item -LiteralPath $zip, $setup, $checksums | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
