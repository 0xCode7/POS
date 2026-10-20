# Stage 8A manual testing

Stage 8A reviews the existing local application. It does not package Windows binaries or claim physical printer validation.

## Create an isolated Linux test environment

Run these commands from the repository root in one terminal. `mktemp` creates a unique directory under `/tmp`; the sample-data command refuses any existing database or non-empty data directory.

```bash
export POS_MANUAL_ROOT="$(mktemp -d /tmp/restaurant-pos-stage8a-XXXXXX)"
export POS_DATA_DIR="$POS_MANUAL_ROOT/data"
export POS_BACKUP_DIR="$POS_MANUAL_ROOT/backups"
printf 'Test root: %s\nData: %s\nBackups: %s\n' "$POS_MANUAL_ROOT" "$POS_DATA_DIR" "$POS_BACKUP_DIR"
npm run sample-data
npm run dev
```

Open `http://127.0.0.1:5173`. Create the first administrator through the setup screen using credentials chosen only for this temporary test. The sample loader creates no user and contains no password or secret.

Keep this terminal visible: backend exceptions and Vite errors are labelled `server` and `client`. In the browser, open Developer Tools (`F12`), select **Console**, enable **Preserve log**, then use the **Network** panel to inspect failed `/api` requests. Any red console entry, uncaught exception, HTTP 5xx, or unexpected HTTP 4xx should be recorded with its action, time, screenshot, and terminal output.

To test the compiled production-like service, stop `npm run dev` with `Ctrl+C`, keep the same exported paths, then run:

```bash
npm run build
npm start
```

Open `http://127.0.0.1:3000`. This uses the same isolated Stage 8A database, not the default Linux data location.

## Included illustrative menu

- Burgers: classic burger EGP 95, cheeseburger EGP 110, double burger EGP 155
- Sandwiches: chicken shawarma EGP 90, kofta EGP 105, crispy chicken EGP 120
- Drinks: water EGP 15, cola EGP 25, orange juice EGP 45
- Sides: fries EGP 40, onion rings EGP 55, coleslaw EGP 30

Prices are illustrative test values stored as integer minor units. The command is intentionally one-shot and refuses to seed an existing database.

## Manual checklist

Record pass/fail and notes for every item.

### First setup and administrator

- [ ] The first page requests initial administrator setup; choose a unique test username, display name, and password of at least five characters.
- [ ] Setup succeeds once and does not expose the password in the UI, browser console, Network response, or backend terminal.
- [ ] Logout returns to login; incorrect credentials show a controlled error; correct credentials restore the admin workspace.
- [ ] Create a cashier with a separate test password, confirm it appears active, then test password reset and login with the replacement password.
- [ ] Confirm a cashier cannot see users, reports, or backup controls and direct protected API requests return 403.

### Menu management

- [ ] All four sample categories and twelve items appear with the documented EGP prices.
- [ ] Real-time search filters by item name/description and clearing it restores all items.
- [ ] Category filtering works; category edit/options open inside the app.
- [ ] Add a temporary category and item, edit their names/prices, toggle availability, archive and restore the item.
- [ ] A cashier sees only active categories and available, non-archived items.

### Open orders

- [ ] Create a new order and add multiple items from different categories.
- [ ] Increase/decrease quantity, add preparation notes, remove a line, and verify the server-calculated total after each action.
- [ ] Navigate through the sidebar and return; the open order and its state remain without a full-page reload.
- [ ] Reopen the order from the open-order list.
- [ ] As admin, cancel a separate test order with a reason and verify it cannot be edited afterward.

### Cash checkout and receipt

- [ ] Empty checkout is unavailable; underpayment is rejected without recording a sale.
- [ ] Complete one exact-cash checkout and one overpayment checkout; verify amount due, cash received, and change.
- [ ] Double-click/retry does not create a second payment or receipt.
- [ ] Receipt number, order number, items, quantities, total, tendered cash, change, and local timestamp are correct.
- [ ] The browser print dialog opens automatically after successful checkout and reprint opens it again without changing the sale.
- [ ] Preview 80 mm and 58 mm layouts. Cancel the dialog and confirm payment remains complete.
- [ ] Verify preview is one receipt page. Physical paper output and silent printing remain unverified until Stage 8 hardware testing.

### Reports

- [ ] Admin KPIs count only the two paid orders; open/cancelled orders are excluded.
- [ ] Revenue equals amounts due, not cash tendered; cash received and change are separate.
- [ ] Daily, hourly, top-item, and cashier sections match the completed checkouts.
- [ ] Date presets and a valid custom inclusive-start/exclusive-end range work; invalid ranges show a controlled error.
- [ ] Receipt search finds order/receipt numbers; opening and reprinting a historical receipt does not change KPIs.

### Backup and restart

- [ ] Open **النسخ الاحتياطية** after startup; confirm status/history shows a successful verified automatic file under `$POS_BACKUP_DIR`. Confirm folder choice, manual path entry, folder opening, and manual-create controls are absent.
- [ ] Keep an open order, stop the app cleanly with `Ctrl+C`, restart with the same exported paths, and verify users, menu, open order, paid sales, receipts, and backup history persist.
- [ ] Confirm files exist only inside the printed temporary data/backup paths. Do not exercise restore against a running service; follow `BACKUP_RECOVERY.md` for a separate offline restore rehearsal.
- [ ] Confirm logout removes access to authenticated pages and browser Back does not reveal usable protected data.

## Review boundaries

- Browser print-dialog invocation can be reviewed; physical output, cutter behavior, cash drawer control, and silent printing cannot.
- Linux manual review does not validate Windows startup, native Node modules, packaging, installer behavior, permissions, or antivirus interaction.
- A backup on `/tmp` is isolation for testing, not disaster protection. Production backups should be on another physical drive.
- Keep the temporary directory for defect investigation if needed. Delete it only after the app is stopped and after verifying the printed path is the intended Stage 8A temporary directory.
