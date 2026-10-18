# Architecture

## Runtime topology

```text
Ordinary browser -> 127.0.0.1:3000 -> Express -> services -> Drizzle -> SQLite
                                      |-- /api/*
                                      `-- compiled React assets + SPA fallback
```

Development adds Vite at `127.0.0.1:5173`; it proxies `/api` to Express. Production runs only compiled Express and bundled static assets. Unknown `/api` routes return JSON before the SPA fallback. No component contacts cloud services, CDNs, analytics, remote fonts, or remote databases.

The production process acquires a data-directory runtime lock before opening SQLite. This separates normal operation from offline restore maintenance; a stale lock is reclaimed only when its recorded PID no longer exists. The Windows portable launcher starts a separate trusted Supervisor which holds its own lock and starts this process as its only managed child.

## Database

`better-sqlite3` provides a synchronous, in-process SQLite connection and Drizzle provides typed schema access and versioned migrations. Each connection enables:

- `foreign_keys=ON`
- `busy_timeout=5000` milliseconds
- WAL journal mode
- `synchronous=FULL` for stronger local durability than the common WAL `NORMAL` setting

The database is created in an absolute, writable per-user OS data directory outside application/source files. Migrations are copied into the compiled server and applied at startup. Native `better-sqlite3` and `argon2` binaries must be validated for the exact Node 24 ABI, Windows architecture, and packaging format; otherwise the installer needs a native compilation toolchain. This remains a Windows-packaging risk, not a completed deployment.

The restaurant operates counter/takeaway service only. There are no table, seat, occupancy, or dine-in assignment entities anywhere in the schema or API.

### Implemented schema

`users`:

- UUID text primary key
- case-insensitive unique normalized username
- display name, Argon2id password hash
- constrained `admin`/`cashier` role and boolean active flag
- millisecond creation/update timestamps
- role/active index

`sessions`:

- UUID text primary key and user foreign key with cascade delete
- unique SHA-256 hash of a random 256-bit opaque token
- creation and expiration timestamps
- user and expiration indexes

`menu_categories`:

- UUID text primary key
- case-insensitive unique normalized name
- non-negative sort order and active flag
- millisecond creation/update timestamps

`menu_items`:

- UUID text primary key and restricted category foreign key
- category-scoped, case-insensitive unique normalized name
- optional normalized description
- positive integer `price_minor`, capped at 100,000,000 minor units
- availability, archive, and sort-order fields
- millisecond creation/update timestamps and filtering indexes

Normal menu APIs never delete items. Archiving also disables availability, preserving records for future order-history references. Search uses bound Drizzle parameters and escapes SQL wildcard characters.

`orders`, `order_items`, and `order_events`:

- persistent unique `ORD-000001` numbers allocated transactionally from `order_number_sequence`
- `OPEN`, `CANCELLED`, and `PAID` states; paid and cancelled orders are immutable
- creator, server-calculated integer subtotal/total, optimistic version, and timestamps
- immutable menu-item name and unit-price snapshots with quantity, line total, and optional notes
- cancellation actor, reason, and timestamp
- append-only JSON audit metadata for creation, item changes, removals, and cancellation

`idempotency_records` stores operation/key pairs for order creation and item addition. All order mutations use immediate SQLite transactions. The submitted expected version must match the stored order version; stale changes return HTTP 409. Totals are recomputed from stored lines, and frontend-supplied prices are never accepted.

`payments`, `receipts`, and `print_attempts`:

- exactly one unique cash payment per order
- server-derived amount due, integer cash tendered, and integer change
- persistent unique `RCP-000001` receipt sequence
- immutable JSON receipt snapshot containing order lines and settlement totals
- persisted checkout request fingerprint for safe idempotent retries and payload-conflict detection
- non-financial print-attempt records (`DIALOG_OPENED` or `ERROR`)

Checkout runs in one immediate transaction: validate nonempty/open/version, recompute totals from item snapshots, insert payment and receipt, transition to `PAID`, append `ORDER_PAID`, and save the idempotency fingerprint. Any failure rolls the whole settlement back. Printing happens afterward through a browser adapter boundary and cannot undo payment. Reprinting retrieves the same receipt and never creates another financial record.

### Sales reporting

`payments` is the authoritative sales source. Every reporting query joins it to a `PAID` order; `OPEN`/`CANCELLED` orders and print attempts are excluded. Revenue is `SUM(payments.amount_due_minor)`, paid-order count is the payment count, average ticket is revenue divided by count and rounded to the nearest minor unit, cash received is `SUM(cash_tendered_minor)`, and change is `SUM(change_minor)`. Tendered cash is not revenue.

Top items aggregate quantity and `unit_price_minor × quantity` from immutable `order_items` snapshots. Cashier reports group by `payments.processed_by_user_id`, not the order creator. Receipt search joins the same payment source and reuses the existing immutable receipt detail and print-attempt flow. There are no persisted aggregates or second financial source of truth.

Range filtering uses `payment.created_at >= start AND payment.created_at < end`. Local date boundaries and daily/hourly buckets use the IANA `Africa/Cairo` zone through Luxon, so UTC offsets and daylight-saving transitions are honored. Daily and hourly bucketing follows an indexed range scan because SQLite does not include an IANA timezone database; summary, item, cashier, and receipt work remains SQL-based. `0004_reporting_indexes.sql` adds non-destructive indexes on payment time and `(checkout actor, payment time)`.

Historical reporting is limited to settlements recorded in `payments`; legacy orders without a successful Stage 5 payment are intentionally not inferred as sales. Exact-name top-item grouping keeps differently named historical snapshots separate. Refunds, costs, profit, taxes, expenses, and shift closing are outside Stage 6.

Expired sessions are rejected at lookup and cleaned on service startup. Deactivation and password reset revoke all sessions for the affected user.

### Backup, restore, and maintenance

`better-sqlite3`'s Online Backup API creates a consistent temporary file while WAL writes may continue. Each backup passes `integrity_check`, `foreign_key_check`, migration metadata, and required-table checks before an atomic rename publishes it. Automatic daily and manual backups use generated safe filenames. Daily retention is 30 days by default, preserves at least seven daily copies, and never automatically removes manual or pre-restore copies.

Backup-directory precedence is `POS_BACKUP_DIR`, then the locally persisted setting, then the default data-adjacent `backups` directory. The persisted `backup-settings.json` is written atomically beside the database, outside installation files in the supported deployment. A UI change requires an absolute writable path, rejects filesystem root, the live database directory, and the installation tree, and records up to ten previous locations without moving old copies. The service probes write access and compares filesystem device IDs where available. On a supported Linux desktop, a protected endpoint can invoke the fixed Zenity directory chooser and return only its validated result; browser folder handles are intentionally not treated as backend filesystem authority. Windows native picking remains a launcher responsibility.

Manual backup display names are normalized server-side and stored in an atomic `<generated-backup>.metadata.json` sidecar tied to the immutable generated SQLite filename, type, and timestamp. The sidecar makes the name portable when the backup pair is copied together, while missing or invalid sidecars degrade safely to a generated default label. Friendly names never participate in filesystem paths or restore identifiers.

The UI accepts only a validated generated filename from the active directory, reauthenticates the current admin, requires the exact Arabic confirmation phrase, and rechecks integrity/schema eligibility. Direct server execution retains preflight/CLI-only restore. When the process is a child of the trusted Supervisor, the API sends an authenticated local IPC request with the safe filename, a one-minute request token, and actor identifier; it never accepts an arbitrary command or database path. The Supervisor stops only its managed child, invokes the fixed restore routine, creates a verified pre-restore backup, removes stale WAL/SHM sidecars, atomically swaps a verified staged file, deletes sessions in the restored copy, restarts the backend, and health-checks it on loopback. A rollback file and startup recovery routine recover the prior database if interruption occurs between renames.

The Supervisor IPC uses a per-run random secret inherited only by its backend child. Its local stop control uses a second per-run secret in a restrictive data-directory control record and verifies the recorded PID and fixed Supervisor command line before the portable stop script sends the request. The IPC endpoint is a Unix socket on Linux or a named pipe scoped to the local host on Windows; it is never an HTTP endpoint and is not exposed on the network. Stage 9A has prepared but not Windows-verified this launcher path.

The Stage 9B Inno Setup definition installs the same portable tree per user under `%LOCALAPPDATA%\\Programs\\Restaurant POS`, with no Windows service or administrator privilege. It places VBS-based Start Menu and desktop shortcuts which run PowerShell hidden but surface a local Arabic error dialog when startup fails. Application data remains in `%LOCALAPPDATA%\\RestaurantPOS\\data`, not `{app}`, so installation repair, update, and uninstall do not intentionally delete databases, backups, settings, receipts, or logs. The definition is currently unexecuted because this development host has no Windows/Inno environment.

Expired sessions are cleaned hourly. Financial records, receipts, order events, checkout idempotency records, and print attempts are retained. Reports keep their 366-day query bound and indexed filters. Operational JSON-line logs rotate at 2 MiB and record bounded event/error text, never bodies, credentials, cookies, or tokens.

### Future schema outline (not migrated)

- optional native Windows printer configuration after actual hardware is known
- additional operational audit events where future features need them

Money must use integer minor units (for example piastres/cents), never IEEE floating point. Exact tax, rounding, void, and immutable-snapshot rules must be decided before these tables are migrated.

## Authentication and authorization

Argon2id uses 19 MiB memory, two iterations, and one lane. Passwords are 5–128 characters. Login errors are generic and login/setup attempts are rate limited in process.

Sessions use host-only, HttpOnly, SameSite=Strict cookies. State-changing requests require `X-CSRF-Protection: 1`; browser requests with an `Origin` must exactly match the request host. This custom header and origin verification complement SameSite cookies. HTTPS deployments can enable `Secure`; loopback HTTP cannot.

Responses set CSP, clickjacking denial, MIME-sniffing protection, no-referrer, permissions restrictions, and same-origin opener policy. API responses are `no-store`. React escapes rendered values and no raw HTML injection API is used. Backup paths are absolute configuration values; restore never accepts an arbitrary server path.

Every admin route authenticates the current, active database user and checks `role=admin` server-side. React navigation is convenience only, not a security boundary. Initial setup and last-admin deactivation use immediate SQLite transactions to prevent races.

The process logs operational errors but never request bodies, passwords, password hashes, cookies, or session tokens.

## API surface

- `GET /api/health`
- `GET /api/auth/setup-status`
- `POST /api/auth/setup` — only when no users exist
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/admin/users` — admin only
- `POST /api/admin/users` — admin only
- `PATCH /api/admin/users/:id/status` — admin only
- `POST /api/admin/users/:id/reset-password` — admin only
- `GET /api/menu/categories` — authenticated; inactive categories only visible to admins on request
- `GET /api/menu/items` — authenticated; category/search/page/limit filters
- `POST /api/admin/menu/categories` — admin only
- `PATCH /api/admin/menu/categories/:id` — admin only
- `POST /api/admin/menu/items` — admin only
- `PATCH /api/admin/menu/items/:id` — admin only
- `PATCH /api/admin/menu/items/:id/availability` — admin only
- `PATCH /api/admin/menu/items/:id/archive` — admin only
- `GET /api/orders` — authenticated, paginated order list
- `POST /api/orders` — authenticated, idempotent order creation
- `GET /api/orders/:id` — authenticated order, lines, and events
- `DELETE /api/orders/:id` — discard an empty `OPEN` order only, version checked
- `POST /api/orders/:id/items` — authenticated, idempotent item addition
- `PATCH /api/orders/:id/items/:itemId` — authenticated quantity/notes edit
- `DELETE /api/orders/:id/items/:itemId` — authenticated line removal
- `POST /api/orders/:id/cancel` — admin only, reason required
- `GET /api/admin/orders` — admin-only paginated status/search history
- `GET /api/admin/orders/:id` — admin-only order and cancellation details
- `POST /api/orders/:id/checkout` — authenticated atomic cash settlement
- `GET /api/receipts/:id` — authenticated receipt retrieval/reprint
- `POST /api/receipts/:id/print-attempts` — authenticated non-financial print logging
- `GET /api/admin/reports/summary` — admin-only revenue/order/cash summary
- `GET /api/admin/reports/daily` — admin-only local-calendar daily series
- `GET /api/admin/reports/top-items` — admin-only snapshot item aggregation
- `GET /api/admin/reports/by-cashier` — admin-only checkout-actor aggregation
- `GET /api/admin/reports/hourly` — admin-only restaurant-local hour series
- `GET /api/admin/reports/receipts` — admin-only searchable/paginated receipt history
- `GET /api/admin/backups` — admin-only backup status/history
- `POST /api/admin/backups` — admin-only, CSRF-protected online backup
- `GET /api/admin/backups/history` — validated, searchable paginated history
- `PATCH /api/admin/backups/settings` — validate and persist a future backup directory
- `POST /api/admin/backups/:filename/restore-preflight` — reauthentication and compatibility check only; never restores

All state-changing endpoints require CSRF proof. API user representations never include hashes or tokens.

## Testing

The client is an Arabic-first RTL React SPA with one token-driven stylesheet and
local inline SVG interface icons. IBM Plex Sans Arabic is a packaged client
dependency: Vite emits its font files into the production assets directory, so
neither development nor production relies on a font CDN. Screen styles and the
58 mm/80 mm receipt print rules remain separate. Dialogs trap focus, support
Escape, and restore focus to their trigger; responsive browser checks cover
390–1920 px without horizontal page overflow.

Integration tests create a unique temporary data directory and real SQLite database per test, run migrations, then close and remove it. They cover restart persistence, setup races, authentication, cookies, session expiry/revocation, role checks, disabled accounts, last-admin protection, CSRF, secret omission, health, and production SPA behavior.

Stage 8A manual testing likewise uses an explicit temporary `POS_DATA_DIR` and separate `POS_BACKUP_DIR`. The development-only sample loader refuses an existing database or non-empty data directory, inserts only illustrative menu data through `MenuService`, runs `integrity_check`, and creates no user or credential. This keeps manual review away from default or restaurant data locations.

Menu tests additionally construct and upgrade a Stage 2-only database, validate fresh migration, preserve user data, exercise category/item management, validate prices and pagination, verify filtering/search, enforce cashier visibility, confirm CSRF/RBAC behavior, and prove that archived menu data persists after restart.

Order tests cover persistent numbering, idempotent retries, item mutations, price snapshots after menu edits, unavailable products, validation and transaction rollback, stale/concurrent version conflicts, cancellation authorization/auditing, cancelled-order immutability, CSRF/origin checks, and persistence after restart.

Payment tests cover exact/over/under payment, empty orders, atomic rollback, one-settlement uniqueness, concurrent checkout, request fingerprints, stale versions, paid-order immutability, receipt persistence/uniqueness, print-failure independence, permissions, CSRF, and origins.

Report tests use fixed timestamps and isolated databases. They cover multi-sale totals, tendered cash versus revenue, open/cancelled exclusion, checkout-actor attribution, immutable names/prices, payment versus creation date, Cairo DST days, item quantities, empty/invalid ranges, receipt pagination/search, reprint independence, cashier denial, and restart persistence.

Maintenance tests cover online backup during writes, integrity/durability pragmas, authorization/CSRF, safe-path rejection, compatible restore, session invalidation, pre-restore backup, simulated interruption recovery, and retention. Playwright runs setup, login, user/menu/order/payment/receipt/report/backup/logout and cashier restrictions in real Chromium with external requests blocked, print mocked, console/request failures observed, and a mobile overflow check.
