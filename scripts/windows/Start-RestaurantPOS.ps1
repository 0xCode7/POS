[CmdletBinding()]
param(
  [string]$DataDirectory,
  [ValidateRange(1, 65535)]
  [int]$Port = 3000,
  [switch]$NoBrowser,
  [switch]$ShowErrorDialog
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

trap {
  $message = "تعذر تشغيل نظام المطعم. $($_.Exception.Message)"
  if ($ShowErrorDialog) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      [System.Windows.Forms.MessageBox]::Show(
        $message,
        'نظام المطعم',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
      ) | Out-Null
    } catch { }
  } else {
    Write-Error $message
  }
  exit 1
}

function Fail([string]$Message) { throw "Restaurant POS: $Message" }
function Test-AbsolutePath([string]$Value) {
  return $Value -match '^[A-Za-z]:[\\/]' -or $Value.StartsWith('\\\\')
}
function Test-Health([int]$ProbePort) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$ProbePort/api/health"
    return $response.StatusCode -eq 200
  } catch { return $false }
}
function Get-ManagedSupervisor([string]$Directory, [string]$ExpectedEntry) {
  $lockFile = Join-Path $Directory '.restaurant-pos-supervisor.lock'
  if (-not (Test-Path -LiteralPath $lockFile)) { return $null }
  try {
    $lock = Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($lock.pid)" -ErrorAction Stop
    if ($process.CommandLine -and $process.CommandLine.IndexOf($ExpectedEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      return $lock
    }
  } catch { }
  return $null
}

$root = [IO.Path]::GetFullPath($PSScriptRoot)
$app = Join-Path $root 'app'
$node = Join-Path $root 'runtime\node.exe'
$entry = Join-Path $app 'server\dist\maintenance\supervisor-cli.js'
if (-not (Test-Path -LiteralPath $node)) { Fail "bundled Node runtime is missing: $node" }
if (-not (Test-Path -LiteralPath $entry)) { Fail "supervisor entrypoint is missing: $entry" }
if ([Environment]::Is64BitOperatingSystem -ne $true) { Fail 'Windows x64 is required.' }

if (-not $DataDirectory) {
  if (-not $env:LOCALAPPDATA) { Fail 'LOCALAPPDATA is required when -DataDirectory is not supplied.' }
  $DataDirectory = Join-Path $env:LOCALAPPDATA 'RestaurantPOS\data'
}
if (-not (Test-AbsolutePath $DataDirectory)) { Fail 'DataDirectory must be an absolute path.' }
$data = [IO.Path]::GetFullPath($DataDirectory)
if ($data.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $data -eq $root) {
  Fail 'application data must remain outside the portable installation directory.'
}
New-Item -ItemType Directory -Path $data -Force | Out-Null
$logs = Join-Path $data 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null

$managed = Get-ManagedSupervisor $data $entry
if ($managed) {
  if (Test-Health $Port) {
    Write-Host "Restaurant POS is already running (Supervisor PID $($managed.pid))."
    if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port/" }
    exit 0
  }
  Fail "a managed Supervisor (PID $($managed.pid)) exists but is not healthy; see $logs and use Stop-RestaurantPOS.ps1 before retrying."
}
if (Test-Health $Port) {
  Fail "port $Port already serves a local application that is not this portable Supervisor. It was left untouched."
}

$oldData = $env:POS_DATA_DIR
$oldPort = $env:PORT
$oldControlSecret = $env:POS_SUPERVISOR_CONTROL_SECRET
try {
  $env:POS_DATA_DIR = $data
  $env:PORT = "$Port"
  $env:POS_SUPERVISOR_CONTROL_SECRET = (& $node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")
  if (-not $env:POS_SUPERVISOR_CONTROL_SECRET) { Fail 'could not create a local Supervisor control secret.' }
  $started = Start-Process -FilePath $node -ArgumentList @($entry) -WorkingDirectory $app -RedirectStandardOutput (Join-Path $logs 'supervisor.stdout.log') -RedirectStandardError (Join-Path $logs 'supervisor.stderr.log') -PassThru -WindowStyle Hidden
} finally {
  $env:POS_DATA_DIR = $oldData
  $env:PORT = $oldPort
  $env:POS_SUPERVISOR_CONTROL_SECRET = $oldControlSecret
}

$deadline = [DateTime]::UtcNow.AddSeconds(35)
while ([DateTime]::UtcNow -lt $deadline) {
  if (Test-Health $Port) {
    Write-Host "Restaurant POS is ready at http://127.0.0.1:$Port/ (Supervisor PID $($started.Id))."
    if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port/" }
    exit 0
  }
  if ($started.HasExited) { break }
  Start-Sleep -Milliseconds 300
  $started.Refresh()
}
Fail "the portable service did not become healthy. Review $logs."
