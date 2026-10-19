[CmdletBinding()]
param(
  [string]$DataDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) { throw "Restaurant POS: $Message" }
function Test-AbsolutePath([string]$Value) {
  return $Value -match '^[A-Za-z]:[\\/]' -or $Value.StartsWith('\\\\')
}

$root = [IO.Path]::GetFullPath($PSScriptRoot)
$node = Join-Path $root 'runtime\node.exe'
$entry = Join-Path $root 'app\server\dist\maintenance\supervisor-cli.js'
if (-not $DataDirectory) {
  if (-not $env:LOCALAPPDATA) { Fail 'LOCALAPPDATA is required when -DataDirectory is not supplied.' }
  $DataDirectory = Join-Path $env:LOCALAPPDATA 'RestaurantPOS\data'
}
if (-not (Test-AbsolutePath $DataDirectory)) { Fail 'DataDirectory must be an absolute path.' }
$data = [IO.Path]::GetFullPath($DataDirectory)
$controlFile = Join-Path $data '.restaurant-pos-supervisor-control.json'
if (-not (Test-Path -LiteralPath $controlFile)) { Write-Host 'Restaurant POS is not running through this portable Supervisor.'; exit 0 }
if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $entry)) { Fail 'portable runtime or Supervisor entrypoint is missing.' }

try { $control = Get-Content -LiteralPath $controlFile -Raw | ConvertFrom-Json } catch { Fail 'Supervisor control record is unreadable; no process was terminated.' }
try { $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($control.pid)" -ErrorAction Stop } catch { Fail 'Supervisor control record is stale; no process was terminated.' }
if (-not $process.CommandLine -or $process.CommandLine.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
  Fail 'the control record does not identify this portable Supervisor; no process was terminated.'
}

$request = @'
const net = require('node:net');
const [socket, controlSecret] = process.argv.slice(1);
const client = net.createConnection(socket);
let reply = '';
const timeout = setTimeout(() => { client.destroy(); process.exitCode = 1; }, 5000);
// Keep the read side open until the Supervisor replies. This is required for
// Windows named pipes, where end() may race and close the reply channel.
client.on('connect', () => client.write(JSON.stringify({ method: 'stop', controlSecret }) + '\n'));
client.on('data', (chunk) => reply += chunk);
client.on('close', () => { clearTimeout(timeout); try { const value = JSON.parse(reply); if (!value.ok) process.exitCode = 1; } catch { process.exitCode = 1; } });
client.on('error', () => { clearTimeout(timeout); process.exitCode = 1; });
'@
& $node -e $request $control.socket $control.controlSecret
if ($LASTEXITCODE -ne 0) { Fail 'the Supervisor refused the graceful stop request; no process was force-terminated.' }
$deadline = [DateTime]::UtcNow.AddSeconds(35)
while ([DateTime]::UtcNow -lt $deadline) {
  if (-not (Get-Process -Id $control.pid -ErrorAction SilentlyContinue)) {
    Write-Host 'Restaurant POS stopped gracefully.'
    exit 0
  }
  Start-Sleep -Milliseconds 300
}
Fail 'the Supervisor did not exit in time; it was not force-terminated.'
