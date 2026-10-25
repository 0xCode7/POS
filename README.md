# Local Restaurant POS

A local/offline point-of-sale application for one counter/takeaway restaurant and one Windows PC. Stage 8B/8C adds a cohesive Arabic-first RTL interface and responsive POS/admin workflows without changing the validated Stage 1–7 business logic. This restaurant has no dine-in tables or inventory. Card/split payments, refunds, profit calculation, and native silent printing are not implemented. Administrative purchase-cost tracking is available separately from sales; it is not inventory or profit reporting. A Windows portable build is prepared in Stage 9A but has not been executed on Windows or turned into an installer.

## Requirements and installation

- Node.js 24 LTS
- npm 11 or newer
- A supported native build environment if npm cannot use a prebuilt `better-sqlite3` or `argon2` binary

```bash
npm install
cp .env.example .env # optional configuration
npm run dev
```

Open `http://127.0.0.1:5173`. On an empty database the UI requires creation of the first administrator; no default or demonstration password exists. Vite proxies API calls to Express on `127.0.0.1:3000`. Both bind only to loopback.

After login, cashiers can browse only active categories and currently sellable items. Administrators can create and edit categories/items, control availability, search/filter the menu, and archive or restore items. Archiving never deletes an item. Prices are entered as EGP in the UI and stored as integer piastres/minor units.

The counter screen creates and reopens `OPEN` takeaway orders. Item names and prices are captured when added, so later menu edits do not alter an existing order. Quantity, notes, item removal, and totals are persisted by the server. Only admins can cancel. Nonempty open orders can be settled once using cash; the backend recomputes the amount due, validates tendered cash, computes change, creates one payment and receipt, and marks the order `PAID` in a single transaction. `PAID` and `CANCELLED` orders are immutable.

Receipt preview supports 80 mm and 58 mm CSS layouts. Print/reprint invokes the ordinary browser print dialog. Opening that dialog does not prove that a physical receipt printed, and no silent/native printer integration is claimed.

Administrators also have a reporting dashboard with today, yesterday, last-seven-days, month-to-date, and custom filters. Reports use payment time in `Africa/Cairo`, with an inclusive local start date and exclusive local end date. Revenue is the amount due from successful paid orders—not cash tendered—and is shown separately from cash received and change. Reports include daily/hourly sales, immutable sold-item snapshots, checkout-actor totals, and searchable receipt history. Cashiers cannot access reporting routes.

Administrators can also record **المشتريات** (restaurant purchases) with a name, optional unit, exact quantity, EGP unit cost, and Cairo-local purchase date. Quantities are stored in thousandths and money in integer piastres; the server calculates the stored total. This is an independent administrative cost register with day/month/search filters and soft deletion. It has no inventory, supplier, tax, payment, revenue, or profit effect. Cashiers cannot view or modify it.

## Production-like operation

```bash
npm run check
npm run build
npm start
```

Open `http://127.0.0.1:3000`. Express serves the compiled client and API. Vite, TypeScript, file watchers, and tests do not run in production. Dependency installation and builds need internet access; the resulting application makes no external runtime requests.

## Electron desktop application (experimental)

Electron hosts the existing local service boundary rather than moving SQLite or
financial logic into React: Electron owns the window, starts a trusted
Supervisor using Electron's bundled Node runtime, and the Supervisor owns the
loopback-only Express process and SQLite connection. React receives no Node,
database, shell, or generic filesystem capability. The window waits for
`/api/health` before navigation, so it does not intentionally load a
connection-refused page.

```bash
npm run desktop:build
npm run desktop:dev
npm run desktop:linux
npm run test:electron:linux
```

Desktop data stays outside the installed app. On Windows, a new installation
uses `%LOCALAPPDATA%\\RestaurantPOS\\data`; Electron settings and logs use
`%LOCALAPPDATA%\\RestaurantPOS\\desktop`. During an upgrade, exactly one
database found in the earlier Electron location is retained in place. If more
than one database is found, startup stops and names the locations rather than
risk selecting, copying, or replacing customer data. The backup location is
shown read-only in the UI; folder selection/opening controls are intentionally
not available in this delivery. UI restore is also disabled until its complete
supervisor lifecycle is revalidated; use the documented local recovery CLI.
Electron printing opens its normal print dialog only: silent printing and
physical output remain unverified.

The Electron NSIS installer keeps the fixed app identity
`com.efendina.restaurantpos` and the fixed upgrade GUID
`5D39E18D-5FC2-4A76-8E89-3D864EC4A98D`. It detects the published legacy Inno
Setup installation record and reuses that installation directory, while still
using the same external `%LOCALAPPDATA%\\RestaurantPOS\\data` SQLite file.
The portable ZIP is a standalone extraction; it is not an installer and does
not perform an automatic in-place upgrade.

`npm run test:electron:linux` uses a fresh temporary Electron user-data
directory, creates an administrator and a paid order through the rendered UI,
checks the receipt preview, report, and automatically created verified backup, then
fully closes and reopens the app three times while checking that the same sale
remains. It deletes that temporary directory afterward. A human must still
confirm the system print dialog on the target desktop.

The service creates one verified SQLite Online Backup per day while running and
checks for a missed daily copy at startup. The backup page is read-only: it
shows automatic status, active location, validation history, and errors; it
intentionally has no folder picker, path entry, folder opening, or manual
backup action. Existing configured paths and historical manual copies are
preserved. Use another physical drive for protection against primary-disk loss.
Same-disk backups only protect against some logical failures. Interactive
restore is disabled pending another full supervisor lifecycle validation;
preserve the documented offline maintenance CLI. Follow
[Backup and recovery](docs/BACKUP_RECOVERY.md).

## Data location and migrations

The default SQLite file is outside the installation tree:

- Windows: `%LOCALAPPDATA%\RestaurantPOS\data\restaurant-pos.sqlite`
- Linux: `$XDG_DATA_HOME/restaurant-pos/restaurant-pos.sqlite`, or `~/.local/share/restaurant-pos/restaurant-pos.sqlite`

Set `POS_DATA_DIR` to an **absolute writable directory** to override this. The database, `-wal`/`-shm` files, and backups are ignored by Git. Back up the database only with SQLite-aware tooling or while the service is stopped cleanly; copying only the main file while WAL is active can lose committed data.

Versioned SQL migrations live in `server/drizzle`. Startup applies pending migrations transactionally through Drizzle and preserves existing data. `0003_cash_settlement.sql` expands the order lifecycle to `PAID` and adds payments, receipts, receipt numbering, checkout fingerprints, and print attempts. It rebuilds the constrained SQLite order tables while copying existing Stage 4 rows. `0004_reporting_indexes.sql` only adds indexes for payment-time ranges and checkout-actor grouping; it creates no reporting or duplicate financial tables. `0005_purchases.sql` only adds the independent, soft-deletable purchases register and its indexes. Never use schema push or destructive resets against a restaurant database. Back up and test the exact database before upgrading.

## Accounts and recovery

- The first-run endpoint works only while there are zero users and creates one admin transactionally.
- Admins can create admin/cashier accounts, deactivate or reactivate users, and reset passwords.
- Password reset and deactivation revoke that user's sessions.
- The last active admin cannot be deactivated.
- Keep at least two individually assigned admin accounts for operational recovery. If the only admin password is lost, there is deliberately no backdoor or default credential: restore a known-good encrypted backup or use a future audited offline recovery procedure. Direct database editing is unsupported.

Sessions last 12 hours. Tokens exist only in host-only, HttpOnly, SameSite=Strict cookies and only SHA-256 token hashes are stored. Local HTTP cannot use the `Secure` cookie flag; keep `COOKIE_SECURE=false` on the loopback-only HTTP deployment. Set it to `true` only after HTTPS is actually configured, otherwise login cookies will not work.

Loopback binding prevents network clients from connecting, but local HTTP is not encryption and does not protect against malicious software or another person controlling the Windows account. Use a dedicated least-privilege OS account, full-disk encryption, screen locking, OS patching, and physically secure the PC. Stage 9A prepares a portable Windows x64 build and its Windows-only verification procedure. It is not an installer and has not been executed on a Windows desktop from this Linux development environment. Physical printer hardware remains unverified.

See [Architecture](docs/ARCHITECTURE.md) and [Roadmap](docs/ROADMAP.md).

The interface uses IBM Plex Sans Arabic bundled locally under the SIL Open Font
License; see [third-party notices](THIRD_PARTY_NOTICES.md). Design decisions,
responsive browser evidence, and before/after captures are documented in the
[Stage 8B/8C UI redesign report](docs/UI_REDESIGN.md).

Stage 8A manual review must use a newly created isolated data directory. Follow
[the manual testing guide](docs/MANUAL_TESTING.md); its optional sample-menu
command refuses existing databases and never creates credentials.

## Windows portable build (Stage 9A — prepared, not Windows-verified)

Run the build only from a clean Windows x64 build checkout, not from Linux:

```powershell
npm run windows:portable
```

It creates `release\\windows\\RestaurantPOS-portable` by default. The script downloads and SHA-256 verifies Node `v24.13.0` for Windows x64 (or accepts a supplied local `-NodeZip`), rebuilds the application, and runs `npm ci --omit=dev` **inside Windows** with the bundled runtime. That is required so `better-sqlite3` and `argon2` are Windows binaries for Node 24's exact ABI, not Linux artifacts. The portable folder contains no project `node_modules` copied from the builder and no application data.

Use `Launch-RestaurantPOS.vbs` (or the `.cmd` wrapper) to start it and `Stop-RestaurantPOS.cmd` for a verified graceful stop. The hidden VBS launcher shows Arabic startup errors without leaving a terminal visible. The launcher uses `%LOCALAPPDATA%\\RestaurantPOS\\data` by default (or its absolute `-DataDirectory` option), not the installation directory. It starts the trusted Supervisor, waits for `127.0.0.1` health, and then opens the default browser. `tools\\Test-Portable.ps1 -InteractiveDesktopChecks` is the disposable-data Windows verification procedure. `npm run windows:release` builds the portable ZIP and Inno Setup installer on Windows. See [Windows portable verification](docs/WINDOWS_PORTABLE.md) and [Windows installer](docs/WINDOWS_INSTALLER.md) for prerequisites, exact evidence required, and the distinction between automated checks and real Windows GUI/hardware checks.
