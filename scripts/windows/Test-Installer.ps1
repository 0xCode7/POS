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
function Assert-InstallerLaunchDefinition() {
  $definition = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..\\..')).Path 'scripts\\windows\\RestaurantPOS.iss'
  if (-not (Test-Path -LiteralPath $definition)) { Fail "installer definition is missing: $definition" }
  $content = Get-Content -LiteralPath $definition -Raw
  if ($content -match '(?im)^Filename:\s*"\{app\}\\[^"\r\n]+\.vbs"') {
    Fail 'installer definition executes a .vbs file directly instead of wscript.exe.'
  }
  foreach ($section in @('[Icons]', '[Run]')) {
    if ($content.IndexOf($section, [StringComparison]::Ordinal) -lt 0) { Fail "installer definition is missing $section." }
  }
  if ($content -notmatch '(?im)^.*Filename:\s*"\{sys\}\\wscript\.exe";\s*Parameters:\s*"//B') {
    Fail 'installer definition does not invoke Launch-RestaurantPOS.vbs through wscript.exe.'
  }
}
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
  $escaped = [regex]::Escape($Path)
  $holders = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $escaped } |
    Select-Object ProcessId, Name, CommandLine |
    Format-List | Out-String
  if ($holders) { Write-Host "Processes referencing disposable installer root:$holders" }
  throw "Installer test cleanup could not release $Path after 30 seconds. $($lastError.Exception.Message)"
}
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
Assert-InstallerLaunchDefinition
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
$launcherMayBeRunning = $false

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

  # Verify the installed desktop shortcut's target. Launching a .lnk through the
  # Windows shell requires an interactive desktop and can retain a handle to the
  # installation directory in a hosted CI session. The launcher itself is tested
  # below with an explicit, disposable data directory.
  $env:LOCALAPPDATA = $profile
  $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Restaurant POS.lnk'
  $menuShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Restaurant POS.lnk'
  foreach ($shortcut in @($desktopShortcut, $menuShortcut)) {
    if (-not (Test-Path -LiteralPath $shortcut)) { Fail "shortcut was not created: $shortcut" }
  }
  $shell = New-Object -ComObject WScript.Shell
  $scriptHost = Join-Path ([Environment]::SystemDirectory) 'wscript.exe'
  $launcher = Join-Path $install 'Launch-RestaurantPOS.vbs'
  foreach ($shortcut in @($desktopShortcut, $menuShortcut)) {
    $details = $shell.CreateShortcut($shortcut)
    if ([IO.Path]::GetFullPath($details.TargetPath) -ne [IO.Path]::GetFullPath($scriptHost)) {
      Fail "shortcut does not target wscript.exe: $shortcut"
    }
    if ($details.Arguments -notmatch [regex]::Escape($launcher)) {
      Fail "shortcut does not pass this installation's VBS launcher: $shortcut"
    }
    if ([IO.Path]::GetFullPath($details.WorkingDirectory) -ne [IO.Path]::GetFullPath($install)) {
      Fail "shortcut has the wrong working directory: $shortcut"
    }
  }

  # Exercise the installed VBS through wscript.exe, as the post-install action and
  # shortcuts do. This catches direct .vbs CreateProcess regressions without opening
  # a persistent PowerShell console in CI.
  Start-Process -FilePath $scriptHost -ArgumentList "//B `"$launcher`" -DataDirectory `"$data`" -Port 3000 -NoBrowser" -WorkingDirectory $install
  $launcherMayBeRunning = $true
  Wait-Health 3000
  & (Join-Path $install 'Stop-RestaurantPOS.ps1') -DataDirectory $data
  $launcherMayBeRunning = $false

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
  if ($launcherMayBeRunning -and (Test-Path -LiteralPath $install)) {
    try {
      & (Join-Path $install 'Stop-RestaurantPOS.ps1') -DataDirectory $data
    } catch {
      Write-Warning 'Installer test cleanup could not stop the disposable Supervisor.'
    }
  }
  if (-not $KeepTestData) { Remove-TestRoot $test }
}
