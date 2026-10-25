[CmdletBinding()]
param(
  [string]$SetupPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'release\windows\RestaurantPOS-Setup.exe'),
  [string]$LegacyReleaseBase = 'https://github.com/0xCode7/POS/releases/download/v0.2.2-windows-stabilization-preview',
  [switch]$KeepTestData
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) { throw "Electron upgrade test: $Message" }
function Remove-TestRoot([string]$Path) {
  $lastError = $null
  foreach ($attempt in 1..15) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
      return
    } catch {
      $lastError = $_
      Start-Sleep -Seconds 2
    }
  }
  throw "Could not release disposable upgrade root after 30 seconds: $($lastError.Exception.Message)"
}
function Wait-ForHealth([int]$Port, [int]$TimeoutSeconds = 45) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
      if ($response.StatusCode -eq 200) { return }
    } catch { }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  Fail "The disposable local service did not become healthy on port $Port."
}
function Wait-ForHealthStop([int]$Port, [int]$TimeoutSeconds = 35) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 | Out-Null
    } catch { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  Fail "The disposable service remained running on port $Port after a graceful stop."
}
function Invoke-Installer([string]$File, [string[]]$Arguments, [string]$Name) {
  $process = Start-Process -FilePath $File -ArgumentList $Arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) { Fail "$Name failed with exit code $($process.ExitCode)." }
}
function Get-Sha256([string]$File) {
  return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
}

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
  Fail 'run this test on Windows x64.'
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$newSetup = [IO.Path]::GetFullPath($SetupPath)
if (-not (Test-Path -LiteralPath $newSetup)) { Fail "New Electron installer is missing: $newSetup" }
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("restaurant-pos-electron-upgrade-" + [guid]::NewGuid())
$legacySetup = Join-Path $testRoot 'legacy-setup.exe'
$legacyChecksums = Join-Path $testRoot 'legacy-SHA256SUMS.txt'
$installDirectory = Join-Path $testRoot 'Programs\Restaurant POS'
$dataRoot = Join-Path $testRoot 'acceptance-data'
$localAppData = Join-Path $dataRoot 'local-app-data'
$databaseDirectory = Join-Path $localAppData 'RestaurantPOS\data'
$database = Join-Path $databaseDirectory 'restaurant-pos.sqlite'
$stateFile = Join-Path $testRoot 'legacy-state.json'
$port = 45432
$oldLocalAppData = $env:LOCALAPPDATA
$oldUsername = $env:POS_UPGRADE_TEST_USERNAME
$oldPassword = $env:POS_UPGRADE_TEST_PASSWORD
$legacyRunning = $false

try {
  New-Item -ItemType Directory -Path $testRoot, $localAppData -Force | Out-Null
  Invoke-WebRequest -UseBasicParsing -Uri "$LegacyReleaseBase/RestaurantPOS-Setup.exe" -OutFile $legacySetup
  Invoke-WebRequest -UseBasicParsing -Uri "$LegacyReleaseBase/SHA256SUMS.txt" -OutFile $legacyChecksums
  $expectedLine = Get-Content -LiteralPath $legacyChecksums | Where-Object { $_ -match '\*RestaurantPOS-Setup\.exe$' } | Select-Object -First 1
  if (-not $expectedLine -or $expectedLine -notmatch '^([a-fA-F0-9]{64}) \*RestaurantPOS-Setup\.exe$') {
    Fail 'The published legacy SHA256SUMS.txt does not contain RestaurantPOS-Setup.exe.'
  }
  if ($Matches[1].ToLowerInvariant() -ne (Get-Sha256 $legacySetup)) {
    Fail 'Downloaded legacy installer SHA-256 does not match its published checksum.'
  }

  # This is the actual legacy Inno installer, installed into a disposable copy
  # of its supported per-user path. The next installer intentionally receives
  # no /D argument, so customInit must discover this prior installation.
  Invoke-Installer $legacySetup @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', "/DIR=`"$installDirectory`"") 'Published legacy installer'
  $legacyLauncher = Join-Path $installDirectory 'Launch-RestaurantPOS.vbs'
  $legacyStop = Join-Path $installDirectory 'Stop-RestaurantPOS.ps1'
  foreach ($required in @($legacyLauncher, $legacyStop, (Join-Path $installDirectory 'runtime\node.exe'))) {
    if (-not (Test-Path -LiteralPath $required)) { Fail "Legacy installer omitted $required" }
  }

  $env:LOCALAPPDATA = $localAppData
  $env:POS_UPGRADE_TEST_USERNAME = 'electron-owner'
  $env:POS_UPGRADE_TEST_PASSWORD = (& node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))").Trim()
  $wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
  Start-Process -FilePath $wscript -ArgumentList "//B `"$legacyLauncher`" -Port $port -NoBrowser" -WorkingDirectory $installDirectory | Out-Null
  $legacyRunning = $true
  Wait-ForHealth $port
  node (Join-Path $root 'scripts\windows\seed-legacy-upgrade-fixture.mjs') "http://127.0.0.1:$port" $stateFile
  if ($LASTEXITCODE -ne 0) { Fail 'Creating the legacy admin, sale, and receipt failed.' }
  & $legacyStop
  $legacyRunning = $false
  Wait-ForHealthStop $port
  if (-not (Test-Path -LiteralPath $database)) { Fail "Legacy application did not use the expected external database: $database" }
  node (Join-Path $root 'scripts\windows\assert-upgrade-database.mjs') legacy $database $stateFile
  if ($LASTEXITCODE -ne 0) { Fail 'Legacy database pre-upgrade verification failed.' }

  Invoke-Installer $newSetup @('/S') 'Electron in-place upgrade'
  $electronExecutable = Join-Path $installDirectory 'RestaurantPOS.exe'
  if (-not (Test-Path -LiteralPath $electronExecutable)) {
    Fail 'Electron installer did not reuse the legacy installation path.'
  }
  if (-not (Test-Path -LiteralPath $database)) {
    Fail 'Electron in-place upgrade removed the external legacy database.'
  }

  # The real packaged Electron app opens the legacy data, runs the pending
  # migration once, verifies the original sale in the UI, creates one purchase,
  # and confirms both old and new records after a complete relaunch.
  $previous = @{
    Executable = $env:POS_PACKAGED_ELECTRON_EXECUTABLE
    Headless = $env:POS_ELECTRON_ACCEPTANCE_HEADLESS
    Print = $env:POS_ELECTRON_DISABLE_PRINT_DIALOG
    Root = $env:POS_ELECTRON_ACCEPTANCE_DATA_ROOT
    Keep = $env:POS_ELECTRON_ACCEPTANCE_KEEP_DATA
    Existing = $env:POS_ELECTRON_ACCEPTANCE_VERIFY_EXISTING
  }
  try {
    $env:POS_PACKAGED_ELECTRON_EXECUTABLE = $electronExecutable
    $env:POS_ELECTRON_ACCEPTANCE_HEADLESS = '1'
    $env:POS_ELECTRON_DISABLE_PRINT_DIALOG = '1'
    $env:POS_ELECTRON_ACCEPTANCE_DATA_ROOT = $dataRoot
    $env:POS_ELECTRON_ACCEPTANCE_KEEP_DATA = '1'
    $env:POS_ELECTRON_ACCEPTANCE_VERIFY_EXISTING = '1'
    node (Join-Path $root 'scripts\electron-linux-acceptance.mjs')
    if ($LASTEXITCODE -ne 0) { Fail 'Packaged Electron did not preserve the legacy sale after upgrade.' }
  } finally {
    foreach ($name in $previous.Keys) {
      $environmentName = switch ($name) {
        Executable { 'POS_PACKAGED_ELECTRON_EXECUTABLE' }
        Headless { 'POS_ELECTRON_ACCEPTANCE_HEADLESS' }
        Print { 'POS_ELECTRON_DISABLE_PRINT_DIALOG' }
        Root { 'POS_ELECTRON_ACCEPTANCE_DATA_ROOT' }
        Keep { 'POS_ELECTRON_ACCEPTANCE_KEEP_DATA' }
        Existing { 'POS_ELECTRON_ACCEPTANCE_VERIFY_EXISTING' }
      }
      if ($null -eq $previous[$name]) { Remove-Item "Env:$environmentName" -ErrorAction SilentlyContinue }
      else { Set-Item "Env:$environmentName" $previous[$name] }
    }
  }
  node (Join-Path $root 'scripts\windows\assert-upgrade-database.mjs') upgraded $database $stateFile
  if ($LASTEXITCODE -ne 0) { Fail 'Post-upgrade financial and migration verification failed.' }
} finally {
  if ($legacyRunning -and (Test-Path -LiteralPath (Join-Path $installDirectory 'Stop-RestaurantPOS.ps1'))) {
    try { & (Join-Path $installDirectory 'Stop-RestaurantPOS.ps1') } catch { Write-Warning 'Could not stop the disposable legacy Supervisor.' }
  }
  if ($null -eq $oldLocalAppData) { Remove-Item Env:LOCALAPPDATA -ErrorAction SilentlyContinue } else { $env:LOCALAPPDATA = $oldLocalAppData }
  if ($null -eq $oldUsername) { Remove-Item Env:POS_UPGRADE_TEST_USERNAME -ErrorAction SilentlyContinue } else { $env:POS_UPGRADE_TEST_USERNAME = $oldUsername }
  if ($null -eq $oldPassword) { Remove-Item Env:POS_UPGRADE_TEST_PASSWORD -ErrorAction SilentlyContinue } else { $env:POS_UPGRADE_TEST_PASSWORD = $oldPassword }
  if (-not $KeepTestData) { Remove-TestRoot $testRoot }
}

Write-Host 'Published legacy-to-Electron in-place upgrade preservation verified.'
