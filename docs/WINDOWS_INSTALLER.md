# Windows installer (Stage 9B)

> **Electron migration notice:** the VBS/browser launcher material below is
> legacy deployment documentation. The active experimental desktop path is the
> `desktop/` Electron Builder configuration, which produces an NSIS installer
> and portable Electron ZIP without opening an external browser. Interactive
> Windows startup, restore, and printer testing remain required before any
> production approval.

The Electron build embeds its own compatible Node runtime. Its managed
Supervisor starts Express directly; the Electron NSIS shortcuts start the
packaged Electron executable, not `Launch-RestaurantPOS.vbs`, `wscript.exe`, or
the legacy browser launcher. SQLite data stays in Electron's per-user data
directory outside the installation directory. The legacy material below is
retained only as historical context until the Electron Windows acceptance run
replaces it.

## In-place upgrade safety

The active Electron installer has a fixed `appId`
`com.efendina.restaurantpos` and fixed NSIS GUID
`5D39E18D-5FC2-4A76-8E89-3D864EC4A98D`; do not change either after release.
Its migration bridge reads the v0.2.2 Inno Setup uninstall record and, when the
legacy launcher is present, installs into that exact recorded directory. This
is an application-file migration only. The authoritative database remains
`%LOCALAPPDATA%\\RestaurantPOS\\data\\restaurant-pos.sqlite`, outside both
old and new installation folders. A versioned startup migration applies
`0005_purchases.sql` once; it does not reset users, orders, payments, or
receipts.

`Test-ElectronUpgrade.ps1` downloads the checksum-verified published v0.2.2
installer into a disposable directory, creates an admin/menu/paid receipt with
the old executable, installs the Electron installer without a `/D` override,
then verifies the original records, migration count, one new purchase, complete
shutdown/relaunch, and foreign keys. It is run by the Windows release workflow.
The Portable ZIP is not an installer and never performs this migration
automatically.

Stage 9B defines a real Inno Setup installer, but this Linux environment has not built or executed it. Do not distribute it until the Windows release workflow or an interactive Windows x64 build machine produces the actual files and records test evidence.

## Build release artifacts on Windows x64

Prerequisites on the **build** machine:

- Windows 10/11 x64;
- Node `24.13.0` and npm 11 for the source build only;
- Inno Setup 6 (`ISCC.exe`), installed locally or passed with `-InnoSetupCompiler`;
- internet access or an approved npm cache/Node ZIP while building. Runtime does not need internet.

```powershell
cd C:\\work\\RestaurantPOS
npm ci
npm run windows:release
```

For an air-gapped release build, pre-verify Node and provide it explicitly:

```powershell
.\\scripts\\windows\\Build-Release.ps1 `
  -NodeZip E:\\approved-media\\node-v24.13.0-win-x64.zip `
  -NodeZipSha256 '<verified-node-archive-sha256>' `
  -InnoSetupCompiler 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe' `
  -Force
```

The release script fails if any required file is absent. It creates:

```text
release\\windows\\RestaurantPOS-portable\\
release\\windows\\RestaurantPOS-Portable.zip
release\\windows\\RestaurantPOS-Setup.exe
release\\windows\\SHA256SUMS.txt
```

It records the semantic version in `portable-manifest.json` and Inno Setup metadata. `SHA256SUMS.txt` covers the ZIP and Setup.exe; verify it before transfer. The build runs `npm ci --omit=dev` under bundled Windows Node and requires `better-sqlite3` and `argon2` from that win32/x64 runtime. Linux `.node` files are never copied to the release tree.

`windows-release.yml` provides a manually triggered GitHub Actions Windows runner alternative. It deliberately uploads only the ZIP, installer, and checksum file—not customer databases, backups, logs, or secrets.

### Trigger and retrieve the GitHub Actions build

After the repository has been pushed to a **private** GitHub repository, open **Actions** → **Windows release verification** → **Run workflow**. Optionally enter a numeric `major.minor.patch` release version. The workflow uses `windows-2022`, Node `24.13.0`, pinned action commit IDs, and pinned Inno Setup `6.5.4`. It verifies native `better-sqlite3`/`argon2`, artifact existence, and the SHA-256 file before upload.

When the job succeeds, open its **Artifacts** section and download `RestaurantPOS-Windows-x64`. It contains exactly:

```text
RestaurantPOS-Portable.zip
RestaurantPOS-Setup.exe
SHA256SUMS.txt
```

Verify downloaded files locally before transfer:

```powershell
Get-FileHash .\RestaurantPOS-Portable.zip -Algorithm SHA256
Get-FileHash .\RestaurantPOS-Setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

No public GitHub Release is created by this workflow.

### Private repository setup

Git has been initialized locally for this project, with no remote, commit, credential, or push configured. The ignore rules exclude environment files, SQLite/WAL/rollback files, backup metadata/settings, logs, `release/`, and dependency directories. Review `git status` before the first commit.

When you are ready to create a private GitHub repository, create it in the GitHub web UI without adding a README, then run these commands yourself after substituting your private URL:

```bash
git branch -M main
git add .
git commit -m "Prepare Windows release workflow"
git remote add origin https://github.com/YOUR-ACCOUNT/YOUR-PRIVATE-REPOSITORY.git
git push -u origin main
```

No remote was added and nothing was pushed by this task.

## Installation and first launch

Run `RestaurantPOS-Setup.exe`. It installs for the current Windows user, does not need administrator rights, and defaults to:

```text
%LOCALAPPDATA%\\Programs\\Restaurant POS
```

The installer creates Start Menu and desktop shortcuts. They run the system `wscript.exe` host with `Launch-RestaurantPOS.vbs` as its quoted argument; a `.vbs` script is never executed directly as a Win32 program. This prevents Windows `CreateProcess` error 193 and leaves no terminal/PowerShell window during normal startup. It starts the trusted Supervisor, waits for local health, then opens the default browser. If startup fails, a local Arabic dialog is shown; detailed logs are in `%LOCALAPPDATA%\\RestaurantPOS\\data\\logs`.

The downloadable Windows artifacts are currently **Experimental**. The installer acceptance workflow intentionally remains failing while the separate Windows Supervisor shutdown/temporary-file-lock issue is unresolved; this is not hidden or treated as production approval.

The first launch has no built-in user or password. Create the first admin through the setup screen. The backend stays bound to `127.0.0.1`; no external server, cloud service, or runtime internet connection is required.

## Data, updates, and uninstall

SQLite, WAL/SHM files, backup settings, backups, restore status, and logs live outside the installation directory:

```text
%LOCALAPPDATA%\\RestaurantPOS\\data
```

Run a current manual backup before every update. Installing a newer Setup.exe over the same per-user directory replaces application files only; migrations are versioned and non-destructive. The uninstaller removes only `{app}` and intentionally leaves the data directory untouched. Deleting customer data is always an explicit operator action outside uninstall.

## Backup, restore, and printing

The installed application retains the existing Backup page: fixed native Windows folder chooser, Explorer opening, persistent validated destination, custom Arabic labels, automatic daily copies, integrity/migration checks, and supervisor-managed restore. Restore always needs a recent admin password and exact confirmation, generates a pre-restore backup, stops the managed backend, validates/rolls back safely, restarts on loopback, and invalidates sessions.

Receipts retain browser print for 80 mm/58 mm layouts. This release does not provide silent printing. Seeing a print dialog is not proof of physical output; test each thermal printer, driver, paper width, and Arabic rendering at the restaurant.

## Release acceptance test

After building, execute only against disposable data:

```powershell
.\\scripts\\windows\\Test-Installer.ps1 `
  -SetupPath .\\release\\windows\\RestaurantPOS-Setup.exe
```

It validates clean installation, shortcut target/startup, a random temporary initial admin, menu/order/cash checkout/receipt, backup configuration and manual backup, supervisor restore/session invalidation, restart, in-place update, and uninstall preserving the temporary external database. It does not fake or pass native FolderBrowserDialog, Explorer, printer, or network-isolation checks; perform these manually in an interactive Windows desktop session.

## Security and troubleshooting

The installer is currently **unsigned**. Windows SmartScreen may warn until code signing and reputation are established. Do not bypass organization policy or distribute unsigned files without approval. There is no machine-wide service and no public Supervisor endpoint.

If startup fails, do not copy a live `.sqlite` file by hand while WAL is active. Review the local logs, retain the entire data directory, and use the in-app verified backup/restore process. Confirm port `3000` is not occupied by another process; the launcher will refuse to reuse an unrelated service. Use `Stop-RestaurantPOS.cmd` and `Restart-RestaurantPOS.cmd` rather than ending processes manually.
