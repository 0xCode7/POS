[CmdletBinding()]
param(
  [string]$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$OutputDirectory = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'release\windows\RestaurantPOS-portable'),
  [string]$NodeVersion = '24.13.0',
  [string]$ReleaseVersion,
  [string]$NodeZip,
  [string]$NodeZipSha256,
  [string]$NpmCache,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) {
  throw "Portable Windows build: $Message"
}

function Invoke-External([string]$File, [string[]]$Arguments, [string]$WorkingDirectory) {
  Push-Location $WorkingDirectory
  try {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "command failed: $File $($Arguments -join ' ')" }
  } finally {
    Pop-Location
  }
}

function Copy-Required([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source)) { Fail "required build output is missing: $Source" }
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Assert-Utf8Bom([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 3 -or $bytes[0] -ne 0xEF -or $bytes[1] -ne 0xBB -or $bytes[2] -ne 0xBF) {
    Fail "PowerShell script with Arabic text must use UTF-8 BOM for Windows PowerShell 5.1: $Path"
  }
}

if ($env:OS -ne 'Windows_NT') { Fail 'this build must run on Windows x64 so native modules are produced for Windows.' }
if ([Environment]::Is64BitOperatingSystem -ne $true) { Fail 'Windows x64 is required.' }

$source = [IO.Path]::GetFullPath($SourceRoot)
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath (Join-Path $source 'package-lock.json'))) { Fail "package-lock.json was not found under $source" }
$sourcePackage = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
if (-not $ReleaseVersion) { $ReleaseVersion = $sourcePackage.version }
if ($ReleaseVersion -notmatch '^\d+\.\d+\.\d+([-.][A-Za-z0-9.-]+)?$') { Fail 'ReleaseVersion must be a semantic version.' }
if ($output -eq [IO.Path]::GetPathRoot($output) -or $output -eq $source) {
  Fail 'the output directory cannot be the source checkout or a filesystem root.'
}
if ((Test-Path -LiteralPath $output) -and -not $Force) {
  Fail "output already exists: $output. Use -Force only after preserving any required build artifact."
}
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Recurse -Force }

$archiveName = "node-v$NodeVersion-win-x64.zip"
$work = Join-Path ([IO.Path]::GetTempPath()) ("restaurant-pos-windows-build-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
  $archive = if ($NodeZip) { [IO.Path]::GetFullPath($NodeZip) } else { Join-Path $work $archiveName }
  if (-not $NodeZip) {
    $baseUrl = "https://nodejs.org/dist/v$NodeVersion"
    Invoke-WebRequest -Uri "$baseUrl/$archiveName" -OutFile $archive
    Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -OutFile (Join-Path $work 'SHASUMS256.txt')
    $expected = ((Get-Content -LiteralPath (Join-Path $work 'SHASUMS256.txt') | Where-Object { $_ -match "\s$([regex]::Escape($archiveName))$" }) -split '\s+')[0]
    if (-not $expected) { Fail "Node checksum for $archiveName was not found." }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant() -ne $expected.ToLowerInvariant()) {
      Fail 'downloaded Node archive checksum did not match the official manifest.'
    }
  }
  if (-not (Test-Path -LiteralPath $archive)) { Fail "Node archive was not found: $archive" }
  if ($NodeZip) {
    if ($NodeZipSha256 -notmatch '^[a-fA-F0-9]{64}$') {
      Fail 'NodeZipSha256 must be the verified 64-character SHA-256 for a supplied NodeZip.'
    }
    $actualNodeZipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash
    if ($actualNodeZipHash -ine $NodeZipSha256) {
      Fail 'supplied Node archive checksum did not match NodeZipSha256.'
    }
  }

  $runtimeExtract = Join-Path $work 'runtime-extract'
  Expand-Archive -LiteralPath $archive -DestinationPath $runtimeExtract -Force
  $runtimeSource = Get-ChildItem -LiteralPath $runtimeExtract -Directory | Select-Object -First 1
  if (-not $runtimeSource -or -not (Test-Path -LiteralPath (Join-Path $runtimeSource.FullName 'node.exe'))) { Fail 'Node archive did not contain node.exe.' }
  $runtimeNode = Join-Path $runtimeSource.FullName 'node.exe'
  $runtimeVersion = (& $runtimeNode --version).Trim()
  if ($runtimeVersion -ne "v$NodeVersion") { Fail "wrong Node runtime: expected v$NodeVersion, got $runtimeVersion" }
  if ((& $runtimeNode -p 'process.arch').Trim() -ne 'x64') { Fail 'the selected Node archive is not x64.' }

  # Build the application on the Windows builder before staging. This is intentionally
  # separate from the production install below; the staged tree never copies node_modules.
  $sourceNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $sourceNpm) { Fail 'npm.cmd is required on the Windows build machine.' }
  Invoke-External $sourceNpm.Source @('ci') $source
  Invoke-External $sourceNpm.Source @('run', 'build') $source

  New-Item -ItemType Directory -Path $output -Force | Out-Null
  $app = Join-Path $output 'app'
  $runtime = Join-Path $output 'runtime'
  New-Item -ItemType Directory -Path $app, $runtime | Out-Null
  Copy-Item -Path (Join-Path $runtimeSource.FullName '*') -Destination $runtime -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $source 'package.json'), (Join-Path $source 'package-lock.json') -Destination $app -Force
  foreach ($workspace in @('client', 'server')) {
    New-Item -ItemType Directory -Path (Join-Path $app $workspace) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $source "$workspace\package.json") -Destination (Join-Path $app $workspace) -Force
  }
  Copy-Required (Join-Path $source 'client\dist') (Join-Path $app 'client\dist')
  Copy-Required (Join-Path $source 'server\dist') (Join-Path $app 'server\dist')

  # Windows PowerShell 5.1 interprets UTF-8 scripts without a BOM as ANSI. These
  # shipped scripts contain Arabic text, so require their source encoding explicitly.
  foreach ($scriptWithArabicText in @(
    (Join-Path $PSScriptRoot 'Start-RestaurantPOS.ps1'),
    (Join-Path $PSScriptRoot 'Test-Portable.ps1'),
    (Join-Path $source 'server\src\maintenance\windows-folder-picker.ps1')
  )) { Assert-Utf8Bom $scriptWithArabicText }

  # npm runs in Windows against the bundled Node runtime. Native postinstall scripts
  # therefore fetch/build win32-x64 binaries rather than copying Linux .node files.
  $bundleNpm = Join-Path $runtime 'npm.cmd'
  $npmArguments = @('ci', '--omit=dev', '--ignore-scripts=false')
  if ($NpmCache) { $npmArguments += @('--cache', [IO.Path]::GetFullPath($NpmCache)) }
  Invoke-External $bundleNpm $npmArguments $app
  Invoke-External (Join-Path $runtime 'node.exe') @('-e', "const Database=require('better-sqlite3'); const argon2=require('argon2'); const db=new Database(':memory:'); db.exec('pragma foreign_keys=on; create table t(id integer primary key)'); db.close(); console.log('Native modules loaded:', process.platform, process.arch, process.versions.modules, typeof argon2.hash)") $app

  # npm is a build-time utility. The portable runtime starts only node.exe, and does
  # not require npm or development tooling after this point.
  Remove-Item -LiteralPath (Join-Path $runtime 'node_modules\npm') -Recurse -Force
  Remove-Item -LiteralPath (Join-Path $runtime 'npm.cmd'), (Join-Path $runtime 'npx.cmd'), (Join-Path $runtime 'npm'), (Join-Path $runtime 'npx') -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Start-RestaurantPOS.ps1'), (Join-Path $PSScriptRoot 'Stop-RestaurantPOS.ps1'), (Join-Path $PSScriptRoot 'Restart-RestaurantPOS.ps1') -Destination $output -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Launch-RestaurantPOS.cmd'), (Join-Path $PSScriptRoot 'Stop-RestaurantPOS.cmd'), (Join-Path $PSScriptRoot 'Restart-RestaurantPOS.cmd') -Destination $output -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Launch-RestaurantPOS.vbs') -Destination $output -Force
  New-Item -ItemType Directory -Path (Join-Path $output 'tools') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Test-Portable.ps1') -Destination (Join-Path $output 'tools') -Force
  $manifest = [ordered]@{
    product = 'Restaurant POS'
    releaseVersion = $ReleaseVersion
    portableFormat = 1
    builtAt = [DateTime]::UtcNow.ToString('o')
    nodeVersion = $runtimeVersion
    nodeModuleAbi = (& (Join-Path $runtime 'node.exe') -p 'process.versions.modules').Trim()
    platform = 'win32'
    arch = 'x64'
    sourceLockSha256 = (Get-FileHash -LiteralPath (Join-Path $source 'package-lock.json') -Algorithm SHA256).Hash.ToLowerInvariant()
    dataDirectory = '%LOCALAPPDATA%\\RestaurantPOS\\data'
    entrypoint = 'Start-RestaurantPOS.ps1'
  }
  $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'portable-manifest.json') -Encoding utf8
  Write-Host "Portable distribution created: $output"
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
