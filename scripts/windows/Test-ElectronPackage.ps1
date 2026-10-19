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

  $runtime = Join-Path $electron 'RestaurantPOS.exe'
  if (-not (Test-Path -LiteralPath $runtime)) {
    throw "Packaged Electron runtime is missing: $runtime"
  }
  $app = Join-Path $electron 'resources\app'
  foreach ($required in @(
    (Join-Path $app 'dist\server\maintenance\supervisor-cli.js'),
    (Join-Path $app 'dist\drizzle\0003_cash_settlement.sql'),
    (Join-Path $app 'dist\icons\icon.ico')
  )) {
    if (-not (Test-Path -LiteralPath $required)) {
      throw "Required packaged application file is missing: $required"
    }
  }
  $icon = [System.IO.File]::ReadAllBytes((Join-Path $app 'dist\icons\icon.ico'))
  if ($icon.Length -lt 4 -or $icon[0] -ne 0 -or $icon[1] -ne 0 -or $icon[2] -ne 1 -or $icon[3] -ne 0) {
    throw 'The packaged application icon is not a valid ICO file.'
  }

  $sqliteCandidates = @(
    (Join-Path $app 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'),
    (Join-Path $app 'node_modules\better-sqlite3\prebuilds\win32-x64.node')
  )
  $argonCandidates = @(
    (Join-Path $app 'node_modules\argon2\build\Release\argon2.node'),
    (Join-Path $app 'node_modules\argon2\prebuilds\win32-x64\argon2.glibc.node')
  )
  if (-not ($sqliteCandidates | Where-Object { Test-Path -LiteralPath $_ })) {
    throw 'No Windows x64 better-sqlite3 native binary was packaged.'
  }
  if (-not ($argonCandidates | Where-Object { Test-Path -LiteralPath $_ })) {
    throw 'No Windows x64 argon2 native binary was packaged.'
  }

  $probe = Join-Path $portableCheck 'verify-electron-native.cjs'
  @'
const path = require('node:path');

const application = process.argv[2];
const sqlite = require(path.join(application, 'node_modules', 'better-sqlite3'));
const argon2 = require(path.join(application, 'node_modules', 'argon2'));

(async () => {
  const database = new sqlite(':memory:');
  if (database.prepare('SELECT 1 AS value').get().value !== 1)
    throw new Error('better-sqlite3 query failed');
  database.close();
  const hash = await argon2.hash('disposable-electron-verification');
  if (!(await argon2.verify(hash, 'disposable-electron-verification')))
    throw new Error('argon2 verification failed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
'@ | Set-Content -LiteralPath $probe -Encoding utf8

  $previousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
  try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    # PowerShell does not reliably wait for a GUI-subsystem executable invoked
    # with the call operator. Electron is one, even when ELECTRON_RUN_AS_NODE
    # makes it execute this short-lived verification script. Start-Process with
    # -Wait gives us the real exit code and captures a useful diagnostic.
    $stdout = Join-Path $portableCheck 'native-probe.stdout.log'
    $stderr = Join-Path $portableCheck 'native-probe.stderr.log'
    $process = Start-Process -FilePath $runtime `
      -ArgumentList @("`"$probe`"", "`"$app`"") `
      -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if ($process.ExitCode -ne 0) {
      $diagnostic = @($stdout, $stderr) |
        Where-Object { Test-Path -LiteralPath $_ } |
        ForEach-Object { Get-Content -LiteralPath $_ -Raw } |
        Where-Object { $_.Trim() } |
        Join-String -Separator [Environment]::NewLine
      throw "Packaged Electron runtime failed to load Windows native dependencies (exit $($process.ExitCode)). $diagnostic"
    }
  } finally {
    if ($null -eq $previousElectronRunAsNode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    else { $env:ELECTRON_RUN_AS_NODE = $previousElectronRunAsNode }
  }

  # This runs the actual packaged Electron executable with isolated application
  # data. It proves renderer-to-Express requests, cookies, CSRF, checkout,
  # reporting, backup, restore, and restart -- not merely native module loading.
  $previousPackagedExecutable = $env:POS_PACKAGED_ELECTRON_EXECUTABLE
  $previousAcceptanceHeadless = $env:POS_ELECTRON_ACCEPTANCE_HEADLESS
  try {
    $env:POS_PACKAGED_ELECTRON_EXECUTABLE = $runtime
    $env:POS_ELECTRON_ACCEPTANCE_HEADLESS = '1'
    node (Join-Path $root 'scripts\electron-linux-acceptance.mjs')
    if ($LASTEXITCODE -ne 0) {
      throw "Packaged Electron production API acceptance failed with exit code $LASTEXITCODE."
    }
  } finally {
    if ($null -eq $previousPackagedExecutable) { Remove-Item Env:POS_PACKAGED_ELECTRON_EXECUTABLE -ErrorAction SilentlyContinue }
    else { $env:POS_PACKAGED_ELECTRON_EXECUTABLE = $previousPackagedExecutable }
    if ($null -eq $previousAcceptanceHeadless) { Remove-Item Env:POS_ELECTRON_ACCEPTANCE_HEADLESS -ErrorAction SilentlyContinue }
    else { $env:POS_ELECTRON_ACCEPTANCE_HEADLESS = $previousAcceptanceHeadless }
  }
} finally {
  Remove-Item -LiteralPath $portableCheck -Force -Recurse -ErrorAction SilentlyContinue
}

Write-Host 'Electron package structure and checksums verified. Interactive Windows startup, restore, and printer validation remain required.'
