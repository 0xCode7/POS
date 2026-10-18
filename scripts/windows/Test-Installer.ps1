[CmdletBinding()]
param(
  [string]$SetupPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path 'release\windows\RestaurantPOS-Setup.exe'),
  [string]$TestRoot,
  [ValidateRange(1024, 65535)]
  [int]$Port = 4321,
  [switch]$KeepTestData
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) { throw "Installer test: $Message" }
function Wait-Health([int]$ProbePort) {
  $deadline = [DateTime]::UtcNow.AddSeconds(40)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$ProbePort/api/health"
      if ($response.StatusCode -eq 200 -and ($response.Content | ConvertFrom-Json).service -eq 'restaurant-pos-server') { return }
    } catch { }
    Start-Sleep -Milliseconds 300
  }
  Fail "installed application did not become healthy on port $ProbePort."
}

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) { Fail 'run from Windows x64.' }
$setup = [IO.Path]::GetFullPath($SetupPath)
if (-not (Test-Path -LiteralPath $setup)) { Fail "Setup.exe does not exist: $setup" }
if (-not $TestRoot) { $TestRoot = Join-Path $env:TEMP ("restaurant-pos-installer-test-" + [Guid]::NewGuid().ToString('N')) }
$test = [IO.Path]::GetFullPath($TestRoot)
if (Test-Path -LiteralPath $test) { Fail "test root already exists: $test" }
$install = Join-Path $test 'installed-app'
$profile = Join-Path $test 'user-profile'
$data = Join-Path $profile 'RestaurantPOS\data'
New-Item -ItemType Directory -Path $test, $profile -Force | Out-Null
$oldLocalAppData = $env:LOCALAPPDATA

try {
  $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/TASKS="desktopicon"', "/DIR=`"$install`"")
  $process = Start-Process -FilePath $setup -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) { Fail "clean installation failed with exit code $($process.ExitCode)." }
  foreach ($required in @(
    (Join-Path $install 'Launch-RestaurantPOS.vbs'),
    (Join-Path $install 'Start-RestaurantPOS.ps1'),
    (Join-Path $install 'runtime\node.exe'),
    (Join-Path $install 'app\server\dist\maintenance\supervisor-cli.js')
  )) {
    if (-not (Test-Path -LiteralPath $required)) { Fail "installer omitted required file: $required" }
  }

  # Exercise the installed desktop shortcut without touching the real user profile.
  $env:LOCALAPPDATA = $profile
  $shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Restaurant POS.lnk'
  if (-not (Test-Path -LiteralPath $shortcut)) { Fail 'desktop shortcut was not created.' }
  $shell = New-Object -ComObject WScript.Shell
  $shortcutTarget = $shell.CreateShortcut($shortcut).TargetPath
  if ([IO.Path]::GetFullPath($shortcutTarget) -ne [IO.Path]::GetFullPath((Join-Path $install 'Launch-RestaurantPOS.vbs'))) {
    Fail 'desktop shortcut does not target this disposable installation.'
  }
  Start-Process -FilePath $shortcut
  Wait-Health 3000
  & (Join-Path $install 'Stop-RestaurantPOS.ps1') -DataDirectory $data

  # This creates a random disposable admin, paid order, receipt, backup, restore,
  # session invalidation, and graceful restart through the installed distribution.
  & (Join-Path $install 'tools\Test-Portable.ps1') -PortableRoot $install -TestRoot (Join-Path $test 'portable-flow') -Port $Port -KeepTestData
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Fail 'installed portable workflow failed.' }
  if (-not (Test-Path -LiteralPath (Join-Path $test 'portable-flow\data\restaurant-pos.sqlite'))) { Fail 'disposable data was not preserved for the update test.' }

  # Re-running the same setup repairs/updates installation files only. Data stays out
  # of {app}, so this test confirms it remains available after an in-place update.
  $process = Start-Process -FilePath $setup -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) { Fail "update installation failed with exit code $($process.ExitCode)." }
  & (Join-Path $install 'Start-RestaurantPOS.ps1') -DataDirectory (Join-Path $test 'portable-flow\data') -Port $Port -NoBrowser
  Wait-Health $Port
  & (Join-Path $install 'Stop-RestaurantPOS.ps1') -DataDirectory (Join-Path $test 'portable-flow\data')
  if (-not (Test-Path -LiteralPath (Join-Path $test 'portable-flow\data\restaurant-pos.sqlite'))) { Fail 'update removed external restaurant data.' }

  $uninstaller = Join-Path $install 'unins000.exe'
  if (-not (Test-Path -LiteralPath $uninstaller)) { Fail 'uninstaller was not created.' }
  $process = Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait -PassThru
  if ($process.ExitCode -ne 0) { Fail "uninstall failed with exit code $($process.ExitCode)." }
  if (-not (Test-Path -LiteralPath (Join-Path $test 'portable-flow\data\restaurant-pos.sqlite'))) { Fail 'uninstall removed external data.' }
  Write-Host "Installer acceptance test passed. Disposable test root: $test"
} finally {
  $env:LOCALAPPDATA = $oldLocalAppData
  if (-not $KeepTestData -and (Test-Path -LiteralPath $test)) { Remove-Item -LiteralPath $test -Recurse -Force }
}
