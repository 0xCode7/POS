# Windows portable build and verification (Stage 9A)

This is a portable **folder**, not an installer. It is designed for Windows 10/11 x64 and Node `v24.13.0`. It has been prepared from Linux but has not been run on Windows yet; do not treat it as Windows deployment approval until the checks below have real Windows evidence.

## Build on Windows x64

Use a clean source checkout on the Windows build machine. The build machine may use the internet or a pre-populated npm cache; the resulting portable application makes no runtime internet request.

```powershell
cd C:\\work\\RestaurantPOS
npm run windows:portable
```

The default result is `release\\windows\\RestaurantPOS-portable`. The build script downloads the official `node-v24.13.0-win-x64.zip` and verifies its SHA-256 against that release's `SHASUMS256.txt`. For an air-gapped build, obtain and verify that archive separately, then provide it explicitly:

```powershell
.\\scripts\\windows\\Build-Portable.ps1 `
  -NodeZip E:\\approved-media\\node-v24.13.0-win-x64.zip `
  -NodeZipSha256 '<verified-node-archive-sha256>' `
  -Force
```

The script rebuilds React and Express, stages only compiled assets/migrations/package manifests, then runs the bundled Windows runtime's `npm ci --omit=dev`. This deliberately runs native package installation on Windows. It validates a real in-process `better-sqlite3` database and `argon2` import before removing npm from the final runtime folder. Do not copy `node_modules` from Linux into the distribution.

`portable-manifest.json` records the Node version, Node module ABI, platform/architecture, build time, and source lockfile digest. Keep the Node runtime and the Windows native modules together; changing Node major versions can change the native ABI and requires rebuilding the portable folder.

## Run and stop

Copy the entire `RestaurantPOS-portable` folder to a writable location (but do not put data inside it). Double-click `Launch-RestaurantPOS.cmd`, or run:

```powershell
.\\Start-RestaurantPOS.ps1
```

The launcher uses `%LOCALAPPDATA%\\RestaurantPOS\\data` by default. For a disposable or redirected data location, pass an absolute path outside the portable folder:

```powershell
.\\Start-RestaurantPOS.ps1 -DataDirectory D:\\RestaurantPOS-data -Port 3000
```

It starts the fixed Supervisor entrypoint, waits for `http://127.0.0.1:3000/api/health`, then opens the browser. A second launcher only reuses a healthy instance that has the matching Supervisor lock and command line. A different process using the port is reported and left alone.

Use `Stop-RestaurantPOS.cmd` or `Restart-RestaurantPOS.cmd` rather than closing processes in Task Manager. The stop script verifies the control record's PID and fixed Supervisor command line, then asks the local IPC endpoint to stop its managed Express child gracefully. It never kills an unrelated process. Logs are in `<data directory>\\logs`.

## Windows verification

Run this from an interactive Windows desktop after building. It creates a fresh disposable data directory and a separate backup directory under `%TEMP%`; it never uses a restaurant database or backup directory.

```powershell
cd .\\release\\windows\\RestaurantPOS-portable
.\\tools\\Test-Portable.ps1 -InteractiveDesktopChecks
```

The automated portion verifies:

1. bundled Node 24, `win32/x64`, `better-sqlite3`, and `argon2` loading;
2. database initialization, migrations, loopback startup, and health;
3. a random temporary first admin (no default password), menu, paid cash order, and receipt;
4. saved backup-directory persistence through a graceful restart;
5. manual online backup validity;
6. Supervisor restore of disposable data, paid receipt preservation, and invalidation of the pre-restore session; and
7. graceful stop/restart.

The script removes its temporary directory unless `-KeepTestData` is supplied. It does not alter a real database, and it never sets firewall policy or fakes a native dialog. With `-InteractiveDesktopChecks`, it prints the remaining operator checks:

- in the Backup page, use **Choose Folder** and confirm the actual Windows `FolderBrowserDialog`; choose a safe empty external folder and confirm the saved location persists after restart;
- use **Open Backup Folder** and verify Explorer opens that selected directory;
- run a real backup and UI restore using the disposable database; watch that the interface returns to login after restore;
- disconnect or firewall-isolate the Windows machine from external networks, then repeat startup, login, checkout, reports, backup, and restore. The browser must continue to use only `127.0.0.1`;
- check `logs\\supervisor.stdout.log` and `logs\\supervisor.stderr.log`, browser Console, and failed Network requests; and
- validate real 58 mm/80 mm printer output only with the actual supported printer. Browser print dialog opening is not physical-print proof.

## Security and recovery boundaries

Express remains bound to `127.0.0.1`; the Supervisor IPC is a local named pipe and is not an HTTP/API listener. The server child receives a per-run secret only through its inherited environment. The launcher-specific stop secret is per-run and stored only in a restrictive data-directory control record so the same local user can request a graceful stop. Neither mechanism accepts command text, arbitrary paths, or remote connections.

Application data, backups, sessions, and logs stay outside the portable folder, so replacing that folder does not overwrite data. Backups must still be on another physical drive for disk-failure protection. Restore preserves the existing pre-restore/rollback recovery mechanism, removes stale SQLite WAL/SHM sidecars only while the managed backend is stopped, validates before and after replacement, and invalidates sessions.

No installer, code signing, Windows service, silent printing, printer driver support, or hardware result is included in Stage 9A.

## Stage 9B release build

On a Windows x64 release machine with Inno Setup 6 installed, run:

```powershell
npm run windows:release
```

This produces `RestaurantPOS-Portable.zip`, `RestaurantPOS-Setup.exe`, and `SHA256SUMS.txt` under `release\\windows`. It invokes the same Windows-native portable build before packaging, so the installer contains exactly the verified portable folder rather than a second runtime design. See [Windows installer](WINDOWS_INSTALLER.md).
