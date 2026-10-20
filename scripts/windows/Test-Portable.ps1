[CmdletBinding()]
param(
  [string]$PortableRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$TestRoot,
  [ValidateRange(1024, 65535)]
  [int]$Port = 4319,
  [switch]$KeepTestData,
  [switch]$InteractiveDesktopChecks
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) { throw "Portable Windows test: $Message" }
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
  throw "Portable Windows test cleanup could not release $Path after 30 seconds. $($lastError.Exception.Message)"
}
function Invoke-Node([string]$Node, [string]$Script, [string[]]$Arguments, [hashtable]$Environment) {
  foreach ($entry in $Environment.GetEnumerator()) { Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value }
  & $Node $Script @Arguments
  if ($LASTEXITCODE -ne 0) { Fail 'portable API verification failed.' }
}

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) { Fail 'run this script from an interactive Windows x64 session.' }
$root = [IO.Path]::GetFullPath($PortableRoot)
$node = Join-Path $root 'runtime\node.exe'
$start = Join-Path $root 'Start-RestaurantPOS.ps1'
$stop = Join-Path $root 'Stop-RestaurantPOS.ps1'
foreach ($required in @($node, $start, $stop, (Join-Path $root 'app\server\dist\index.js'))) {
  if (-not (Test-Path -LiteralPath $required)) { Fail "missing portable artifact: $required" }
}
if ((& $node --version).Trim() -notmatch '^v24\.') { Fail 'the portable runtime is not Node 24.' }
if ((& $node -p 'process.platform + "/" + process.arch').Trim() -ne 'win32/x64') { Fail 'the portable runtime is not win32/x64.' }
& $node -e "const Database=require('better-sqlite3'); const argon2=require('argon2'); const db=new Database(':memory:'); db.exec('pragma foreign_keys=on; create table check_native(id integer primary key)'); db.close(); if(typeof argon2.hash !== 'function') process.exit(1); console.log('Native modules: OK')"
if ($LASTEXITCODE -ne 0) { Fail 'better-sqlite3 or argon2 did not load under the bundled Node runtime.' }

if (-not $TestRoot) { $TestRoot = Join-Path $env:TEMP ("restaurant-pos-portable-test-" + [Guid]::NewGuid().ToString('N')) }
$test = [IO.Path]::GetFullPath($TestRoot)
$data = Join-Path $test 'data'
$backups = Join-Path $test 'backup-drive'
if (Test-Path -LiteralPath $test) { Fail "test root already exists; choose a new empty directory: $test" }
New-Item -ItemType Directory -Path $test, $backups -Force | Out-Null
$username = 'portable' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
$password = (& $node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))").Trim()
$flow = Join-Path $test 'portable-flow.mjs'

@'
import fs from 'node:fs';
const [base, stateFile, phase] = process.argv.slice(2);
const username = process.env.POS_PORTABLE_TEST_USERNAME;
const password = process.env.POS_PORTABLE_TEST_PASSWORD;
let cookie = '';
const headers = (extra = {}) => ({
  accept: 'application/json',
  origin: base,
  cookie,
  'x-csrf-protection': '1',
  ...extra,
});
async function request(path, options = {}, accepted = [200, 201, 202, 204]) {
  const response = await fetch(base + path, { ...options, headers: headers(options.headers) });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie[0]) cookie = setCookie[0].split(';', 1)[0];
  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!accepted.includes(response.status)) throw new Error(`${options.method ?? 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`);
  return { response, body };
}
async function login() {
  await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
}
if (phase === 'seed') {
  await request('/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, displayName: 'Portable verification admin', password }) }, [201]);
  await login();
  const category = (await request('/api/admin/menu/categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Portable test menu', sortOrder: 1, isActive: true }) })).body.category;
  const item = (await request('/api/admin/menu/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ categoryId: category.id, name: 'Portable test item', description: null, priceMinor: 12500, sortOrder: 1, isAvailable: true }) })).body.item;
  const order = (await request('/api/orders', { method: 'POST', headers: { 'idempotency-key': 'portable-order-key-001' } })).body.order;
  const updated = (await request(`/api/orders/${order.id}/items`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'portable-item-key-001' }, body: JSON.stringify({ menuItemId: item.id, quantity: 2, expectedVersion: order.version }) })).body.order;
  const receipt = (await request(`/api/orders/${order.id}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'portable-checkout-key-001' }, body: JSON.stringify({ cashTenderedMinor: 30000, expectedVersion: updated.version }) })).body.receipt;
  let status;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    status = (await request('/api/admin/backups')).body.backups;
    const automatic = status.history.find((backup) => backup.kind === 'daily' && backup.validation === 'valid' && backup.restoreEligible);
    if (automatic) {
      fs.writeFileSync(stateFile, JSON.stringify({ filename: automatic.filename, receiptId: receipt.id, backupDirectory: status.directory }));
      console.log('Seed, payment, receipt, and verified automatic backup: OK');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!fs.existsSync(stateFile)) throw new Error('automatic backup was not created after application startup');
} else if (phase === 'restore') {
  await login();
  const status = (await request('/api/admin/backups')).body.backups;
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (status.directory !== state.backupDirectory) throw new Error('backup directory did not persist after restart');
  const oldCookie = cookie;
  await request(`/api/admin/backups/${encodeURIComponent(state.filename)}/restore-request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password, confirmation: `استعادة ${state.filename}` }) }, [202]);
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    try { if ((await fetch(base + '/api/health')).ok) break; } catch { }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const oldSession = await fetch(base + '/api/auth/me', { headers: { cookie: oldCookie } });
  if (oldSession.status !== 401) throw new Error(`restored sessions were not invalidated (got ${oldSession.status})`);
  cookie = '';
  await login();
  const receipt = (await request(`/api/receipts/${state.receiptId}`)).body.receipt;
  if (!receipt || receipt.payment?.amountDueMinor !== 25000) throw new Error('paid receipt was not preserved by restore');
  console.log('Restore, receipt preservation, and session invalidation: OK');
} else {
  throw new Error(`unknown test phase: ${phase}`);
}
'@ | Set-Content -LiteralPath $flow -Encoding utf8

$serverMayBeRunning = $false
try {
  & $start -DataDirectory $data -Port $Port -NoBrowser
  $serverMayBeRunning = $true
  Invoke-Node $node $flow @("http://127.0.0.1:$Port", (Join-Path $test 'state.json'), 'seed') @{ POS_PORTABLE_TEST_USERNAME = $username; POS_PORTABLE_TEST_PASSWORD = $password }
  & $stop -DataDirectory $data
  $serverMayBeRunning = $false
  & $start -DataDirectory $data -Port $Port -NoBrowser
  $serverMayBeRunning = $true
  Invoke-Node $node $flow @("http://127.0.0.1:$Port", (Join-Path $test 'state.json'), 'restore') @{ POS_PORTABLE_TEST_USERNAME = $username; POS_PORTABLE_TEST_PASSWORD = $password }
  & $stop -DataDirectory $data
  $serverMayBeRunning = $false
  Write-Host "Automated portable checks passed. Isolated test directory: $test"
  if ($InteractiveDesktopChecks) {
    Write-Host 'Interactive checks still required: start the app, sign in with a disposable admin, confirm the read-only backup location and automatic history, then visually confirm checkout, receipt, restore, and reporting. Disconnect the Windows host from external networks and repeat startup. This script does not claim those GUI/offline-network checks passed.'
  }
} finally {
  Remove-Item Env:POS_PORTABLE_TEST_USERNAME -ErrorAction SilentlyContinue
  Remove-Item Env:POS_PORTABLE_TEST_PASSWORD -ErrorAction SilentlyContinue
  if ($serverMayBeRunning) {
    try { & $stop -DataDirectory $data } catch { Write-Warning 'Portable test cleanup could not stop the disposable Supervisor.' }
  }
  if (-not $KeepTestData) { Remove-TestRoot $test }
}
