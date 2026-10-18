# Backup and recovery

## Backup configuration

By default, backups are stored in a `backups` subdirectory of the local data directory. For real protection, use an absolute path on a different physical drive.

```dotenv
POS_BACKUP_DIR=E:\RestaurantPOS-Backups
POS_BACKUP_RETENTION_DAYS=30
```

Directory precedence is:

1. `POS_BACKUP_DIR`, when set before service startup. The UI shows that the location is environment-managed and cannot override it.
2. The administrator-selected path in `backup-settings.json` beside the live database.
3. The default `backups` subdirectory.

The dedicated **النسخ الاحتياطية** page offers **اختيار مجلد** first when the local service is running in a supported Linux desktop session with Zenity available. The protected local backend opens the fixed directory-only Zenity dialog itself; the browser never submits a filesystem path or command. The chosen path is validated, displayed, and must be confirmed before it is saved. In headless Linux, ordinary browser-only operation, and future Windows builds before the launcher exists, the control is disabled with an explanation and **إدخال مسار يدوي** remains available. Browser folder-selection APIs are not used because a browser permission does not grant the Node service write access. “Open Folder” remains disabled until a trusted Windows launcher exists.

Manual backups may have an optional Arabic or English friendly name. The generated SQLite filename remains the immutable technical identifier. The name is normalized and stored in a restrictive adjacent `<filename>.metadata.json` sidecar that contains the filename, type, and timestamp, so copying the SQLite file **together with its matching metadata sidecar** preserves the label on another drive. If a sidecar is absent, corrupt, or belongs to a different file, the application safely falls back to a default label; old backups remain usable. Do not rename either member of this backup pair.

The service creates a daily backup when no successful daily copy exists in the preceding 24 hours. An admin can also choose **إنشاء نسخة الآن** on the dedicated backup page. Checkout does not wait for automatic failure recovery and a failed backup does not roll back or alter a payment.

SQLite's Online Backup API, rather than copying the live `.sqlite` file, captures WAL-consistent state. The application writes to a `.partial` file, runs `integrity_check`, `foreign_key_check`, verifies migration metadata and required tables, applies restrictive permissions where supported, then publishes with an atomic rename. A backup appears in history only after those steps succeed.

Automatic retention applies only to daily copies: the configured 7–365 day window is used while at least seven newest daily copies are preserved. Manual and pre-restore backups require deliberate operator removal. Monitor free space. A same-disk copy does not protect against disk or machine loss.

## Tested restore procedure

Direct `npm start` mode keeps the page's **استعادة** action as a preflight only and the maintenance CLI is required. The portable Windows launcher instead starts a trusted Supervisor. In that mode, the page requires the current admin password and the exact `استعادة <filename>` phrase, then sends the Supervisor only the already validated generated filename. The Supervisor stops its own child process, creates and verifies a pre-restore backup, performs the same fixed restore procedure, restarts Express, checks health, and records the outcome. All sessions in the restored database are deleted, so the operator must sign in again.

For direct/server mode:

1. Record the chosen generated backup filename from the admin backup history.
2. Stop the Restaurant POS service completely. Do not leave a development server running.
3. Ensure the configured backup drive and live data directory are available and writable.
4. Run from the installed application directory:

   ```bash
   npm run restore --workspace server -- --file restaurant-pos-YYYYMMDDTHHMMSSZ-manual-1234abcd.sqlite --username owner
   ```

5. Enter the admin password at the hidden prompt.
6. Type the exact displayed `RESTORE <filename>` confirmation.
7. Start the service and sign in again. Every prior session is intentionally invalidated.
8. Confirm users, menu, recent paid orders, receipts, and reports before resuming sales.

The restore tool refuses path separators, files outside `POS_BACKUP_DIR`, corrupt databases, foreign-key violations, missing required tables, mismatched applied migrations, inactive/non-admin accounts, bad passwords, and incorrect confirmation. It also refuses to run while the server runtime lock belongs to a live process.

## Interruption recovery

Before replacement, restore creates and verifies a `pre-restore` online backup. After closing SQLite it removes stale WAL/SHM sidecars, renames the current database to a rollback filename, publishes the prepared candidate, validates it again, then removes the rollback file. If the process stops between these operations, the next startup detects the rollback state: it restores the old database when no valid live file exists, or keeps the valid restored file. Staging files are removed.

This interruption path and an intentional simulated failure after the live-file rename are automated tests. If startup still fails, keep all database, rollback, WAL, and SHM files untouched; copy the whole data directory to safe storage and seek technical assistance before another attempt.

## Current limitations

Stage 9A includes a trusted Supervisor, Windows folder picker (`FolderBrowserDialog`), Explorer opening, and a portable launcher, but they are prepared only: this Linux development run has not verified them in a real Windows session. There is still no Windows service registration, signed executable/installer, removable-drive discovery, or physical printer validation. Browser print remains non-silent, and a mocked `window.print()` test proves only application behavior—not paper output.

Stage 9B adds an unexecuted Inno Setup definition that installs this same portable runtime without moving the data directory. Its installer test procedure performs backups and restore only against generated disposable data. A real Windows desktop must still verify FolderBrowserDialog, Explorer, removable media, and physical printer hardware before operational approval.
