# Roadmap

## Electron migration (in progress)

- Electron main/preload host with sandboxed renderer and loopback backend
- Electron-owned startup readiness, native folder chooser bridge, and print dialog
- Linux AppImage and Windows NSIS/portable packaging preparation
- Linux Electron acceptance now covers isolated setup/login, POS payment,
  receipt preview, reports, backup, Supervisor restore, session invalidation,
  clean close, and reopen. Pending: interactive confirmation of the native
  folder/print dialogs, Windows CI package execution, Windows installer/restore
  acceptance, signing, and physical printer tests.

## Stage 1 — Project foundation (complete)

- npm workspaces for React/Vite and Express/TypeScript
- loopback-only development/production services
- health endpoint, production SPA serving, linting, formatting, builds, and tests

## Stage 2 — Persistence and access control (complete)

- SQLite with Drizzle versioned migrations and external writable data location
- WAL, foreign keys, busy timeout, and full synchronous durability
- one-time race-safe first-admin setup
- Argon2id passwords and hashed opaque sessions
- admin/cashier server-side authorization
- user creation, listing, activation/deactivation, and password reset
- CSRF/origin defenses, secure cookie policy, and login rate limiting
- setup, login, authenticated shell, logout, and admin user UI
- isolated persistence and security integration tests

## Stage 3 — Restaurant menu management (complete)

- non-destructive category and menu-item migration
- integer-minor-unit EGP prices and bounded server validation
- normalized duplicate protection and archive-only item lifecycle
- authenticated menu browsing with search, filters, and pagination
- admin-only management APIs with Zod validation
- Arabic-first responsive admin and cashier menu interfaces
- migration-upgrade, persistence, role, validation, CSRF, and filtering tests

## Stage 4 — Counter POS and takeaway orders (complete)

- persistent unique counter-order numbering
- open-order item, quantity, and notes workflow with server-owned prices/totals
- immutable item-name and unit-price snapshots
- idempotent creation/addition and optimistic concurrency versions
- append-only modification/cancellation events
- admin-only cancellation with reason, actor, and timestamp
- Arabic-first RTL counter interface and open-order reopening
- no table, seat, occupancy, or dine-in management

## Stage 5 — Cash checkout, receipts, and browser printing (complete)

- atomic cash-only payment and `PAID` lifecycle
- backend amount/change calculation and one-settlement constraint
- idempotent checkout with request fingerprints
- immutable receipt snapshots and persistent numbering
- Arabic 80 mm/58 mm browser-print layouts and reprinting
- explicit print-attempt/error tracking independent of payment

## Stage 6 — Admin dashboard and sales reporting (complete)

- sales reporting derived only from successful paid orders
- revenue, paid-order, average-ticket, cash-received, and change summaries
- Cairo-local daily/hourly grouping with DST-aware exclusive date boundaries
- immutable top-item snapshots and checkout-actor attribution
- searchable paginated receipt history with existing reprint flow
- Arabic-first responsive admin dashboard and server-enforced admin access
- indexed range queries, isolated report tests, and restart persistence checks

## Stage 7 — Security, backup, restore, reliability, and browser testing (complete)

- consistent SQLite Online Backup with integrity and foreign-key validation
- manual admin and automatic daily backup with external-drive configuration
- conservative automatic retention and visible backup status/history
- offline, reauthenticated, explicitly confirmed restore CLI
- pre-restore backup, session invalidation, safe-path enforcement, and interrupted-restore rollback
- runtime maintenance lock, storage/busy error responses, security headers, and bounded local logs
- hourly expired-session cleanup without deleting financial/audit records
- isolated real-Chromium end-to-end workflow with external network blocking
- isolated recovery, regression, and reporting performance tests

## Stage 8A — Manual testing and review (complete)

- isolated Linux test data and backup directories
- one-shot development sample menu with no default credentials
- admin, cashier, menu, order, checkout, receipt, report, backup, restart, and logout checklist
- browser console, failed-request, and backend error review
- no Windows packaging or physical printer claim

## Stage 8B/8C — Professional UI/UX redesign (complete)

- cohesive Arabic-first RTL design system and responsive application shell
- locally bundled IBM Plex Sans Arabic with third-party license notice
- streamlined POS catalog, sticky desktop order summary, and clear checkout
- consistent admin, menu, users, reports, receipts, backup, and auth screens
- keyboard focus treatment, modal focus trapping/restoration, and Escape close
- Chromium captures and overflow checks at 390, 768, 1024, 1366, and 1920 widths
- unchanged API, database, settlement, report, backup, and receipt-print rules

## Stage 9A — Windows portable build and native verification (prepared; Windows execution pending)

- Windows-only portable build script with SHA-256 verified Node 24 x64 runtime
- production dependencies installed on Windows so `better-sqlite3` and `argon2` are win32-x64 binaries for the bundled Node ABI
- portable launcher, local trusted Supervisor, managed Express lifecycle, health wait, duplicate-instance protection, and verified graceful stop/restart path
- Windows-only disposable data test script for native modules, data initialization, checkout, receipt, backup, restore, session invalidation, restart, and persistence
- real Windows GUI folder picker/Explorer, file-lock behavior, offline network isolation, hardware printing, and all Windows execution remain pending an interactive Windows session

## Stage 9B — Portable ZIP and Setup.exe (prepared; Windows build pending)

- Windows-only release script creates `RestaurantPOS-Portable.zip`, `RestaurantPOS-Setup.exe`, and `SHA256SUMS.txt` from the exact portable tree
- per-user Inno Setup definition, VBS no-console launcher, Start Menu/desktop shortcuts, uninstaller, and external persistent data location
- disposable installer acceptance script covers install, shortcut start, random first admin, payment/receipt, backup/restore, restart, update, and uninstall data preservation
- manually triggered GitHub Actions Windows workflow installs Inno Setup, runs checks, builds artifacts, runs installer verification, and uploads only release outputs
- no actual Windows build, installer execution, native module verification, native GUI test, or hardware test has occurred from this Linux environment

## Stage 9C and later (not started; requires approval)

- optional native Windows thermal-printer adapter after hardware validation
- audited account-recovery tooling, backup/restore workflows
- final installer/signing/service registration only after Stage 9A Windows evidence
- optional native Windows thermal-printer adapter after hardware validation

Future work must preserve offline operation, migrate existing data without resets, store money in integer minor units, and add tests for every migration and permission boundary.
