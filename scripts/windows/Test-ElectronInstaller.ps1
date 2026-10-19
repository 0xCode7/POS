[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$release = Join-Path $root 'release\windows'
$setup = Join-Path $release 'RestaurantPOS-Setup.exe'

if (-not (Test-Path -LiteralPath $setup)) {
  throw "Electron installer is missing: $setup"
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("restaurant-pos-installer-" + [guid]::NewGuid())
$installDirectory = Join-Path $testRoot 'installed-app'
$dataRoot = Join-Path $testRoot 'acceptance-data'
$shortcutLocations = @(
  [pscustomobject]@{ Kind = 'desktop'; Directory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop) }
  [pscustomobject]@{ Kind = 'desktop'; Directory = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory) }
  [pscustomobject]@{ Kind = 'desktop'; Directory = (Join-Path $env:USERPROFILE 'Desktop') }
  [pscustomobject]@{ Kind = 'desktop'; Directory = (Join-Path $env:PUBLIC 'Desktop') }
  [pscustomobject]@{ Kind = 'start-menu'; Directory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs) }
  [pscustomobject]@{ Kind = 'start-menu'; Directory = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms) }
  [pscustomobject]@{ Kind = 'start-menu'; Directory = (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs') }
  [pscustomobject]@{ Kind = 'start-menu'; Directory = (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs') }
) | Where-Object { $_.Directory } | Sort-Object Directory -Unique

function Invoke-Setup {
  $process = Start-Process -FilePath $setup -ArgumentList @('/S', "/D=$installDirectory") -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "NSIS installer failed with exit code $($process.ExitCode)."
  }
}

function Get-ShortcutTarget([string] $shortcutPath) {
  $shell = New-Object -ComObject WScript.Shell
  try {
    return $shell.CreateShortcut($shortcutPath).TargetPath
  } finally {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
  }
}

function Get-InstalledShortcuts([string] $runtime) {
  $canonicalRuntime = [System.IO.Path]::GetFullPath($runtime)
  $matches = @()
  foreach ($location in $shortcutLocations) {
    if (-not (Test-Path -LiteralPath $location.Directory)) { continue }
    foreach ($shortcut in Get-ChildItem -LiteralPath $location.Directory -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue) {
      try {
        $target = Get-ShortcutTarget $shortcut.FullName
        if ([System.IO.Path]::GetFullPath($target) -ieq $canonicalRuntime) {
          $matches += [pscustomobject]@{
            Kind = $location.Kind
            Path = $shortcut.FullName
            Target = $target
          }
        }
      } catch {
        # An unrelated malformed shortcut must not affect the disposable test.
      }
    }
  }
  return $matches
}

function Write-ShortcutDiagnostics {
  Write-Host 'Shortcut locations inspected:'
  foreach ($location in $shortcutLocations) {
    Write-Host "  [$($location.Kind)] $($location.Directory)"
    if (Test-Path -LiteralPath $location.Directory) {
      Get-ChildItem -LiteralPath $location.Directory -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue |
        ForEach-Object {
          $target = ''
          try { $target = Get-ShortcutTarget $_.FullName } catch { $target = '<unreadable>' }
          Write-Host "    $($_.FullName) -> $target"
        }
    }
  }
}

function Invoke-Acceptance([bool] $verifyExisting) {
  $previous = @{
    Executable = $env:POS_PACKAGED_ELECTRON_EXECUTABLE
    Headless = $env:POS_ELECTRON_ACCEPTANCE_HEADLESS
    Print = $env:POS_ELECTRON_DISABLE_PRINT_DIALOG
    Root = $env:POS_ELECTRON_ACCEPTANCE_DATA_ROOT
    Keep = $env:POS_ELECTRON_ACCEPTANCE_KEEP_DATA
    Existing = $env:POS_ELECTRON_ACCEPTANCE_VERIFY_EXISTING
  }
  try {
    $env:POS_PACKAGED_ELECTRON_EXECUTABLE = Join-Path $installDirectory 'RestaurantPOS.exe'
    $env:POS_ELECTRON_ACCEPTANCE_HEADLESS = '1'
    $env:POS_ELECTRON_DISABLE_PRINT_DIALOG = '1'
    $env:POS_ELECTRON_ACCEPTANCE_DATA_ROOT = $dataRoot
    $env:POS_ELECTRON_ACCEPTANCE_KEEP_DATA = '1'
    if ($verifyExisting) { $env:POS_ELECTRON_ACCEPTANCE_VERIFY_EXISTING = '1' }
    else { Remove-Item Env:POS_ELECTRON_ACCEPTANCE_VERIFY_EXISTING -ErrorAction SilentlyContinue }
    node (Join-Path $root 'scripts\electron-linux-acceptance.mjs')
    if ($LASTEXITCODE -ne 0) {
      throw "Installed Electron acceptance failed with exit code $LASTEXITCODE."
    }
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
}

try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  Invoke-Setup

  $runtime = Join-Path $installDirectory 'RestaurantPOS.exe'
  if (-not (Test-Path -LiteralPath $runtime)) {
    throw "The installed Electron executable is missing: $runtime"
  }
  $shortcuts = @(Get-InstalledShortcuts $runtime)
  $desktopShortcut = $shortcuts | Where-Object Kind -eq 'desktop' | Select-Object -First 1
  $startMenuShortcut = $shortcuts | Where-Object Kind -eq 'start-menu' | Select-Object -First 1
  if (-not $desktopShortcut -or -not $startMenuShortcut) {
    Write-ShortcutDiagnostics
    throw "Expected a desktop and a Start Menu shortcut targeting the installed executable; found desktop=$([bool]$desktopShortcut), start-menu=$([bool]$startMenuShortcut)."
  }

  Invoke-Acceptance $false
  $database = Join-Path $dataRoot 'local-app-data\RestaurantPOS\data\restaurant-pos.sqlite'
  if (-not (Test-Path -LiteralPath $database)) {
    throw "Installed application did not create its stable per-user database: $database"
  }
  $beforeUpgrade = (Get-FileHash -LiteralPath $database -Algorithm SHA256).Hash

  # Reinstall over the same location. The NSIS installer must not touch the
  # per-user LOCALAPPDATA database created by the installed application.
  Invoke-Setup
  if (-not (Test-Path -LiteralPath $database)) {
    throw 'An in-place installer upgrade removed the existing customer database.'
  }
  $afterUpgrade = (Get-FileHash -LiteralPath $database -Algorithm SHA256).Hash
  if ($beforeUpgrade -ne $afterUpgrade) {
    throw 'An in-place installer upgrade modified the existing customer database.'
  }
  Invoke-Acceptance $true
} finally {
  # Remove only the disposable CI installation and its shortcuts. Never target
  # an arbitrary user installation or data directory.
  if (Test-Path -LiteralPath $installDirectory) {
    Get-InstalledShortcuts (Join-Path $installDirectory 'RestaurantPOS.exe') |
      ForEach-Object { Remove-Item -LiteralPath $_.Path -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item -LiteralPath $testRoot -Force -Recurse -ErrorAction SilentlyContinue
}

Write-Host 'Electron installer shortcuts, per-user data persistence, and in-place upgrade preservation verified.'
