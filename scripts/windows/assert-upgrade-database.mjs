import fs from 'node:fs';
import Database from 'better-sqlite3';

const [phase, databaseFile, stateFile] = process.argv.slice(2);
if (!['legacy', 'upgraded'].includes(phase) || !databaseFile || !stateFile) {
  throw new Error(
    'Usage: node assert-upgrade-database.mjs <legacy|upgraded> <database-file> <state-file>',
  );
}
if (!fs.existsSync(databaseFile)) {
  throw new Error(`Expected database was not found: ${databaseFile}`);
}
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const database = new Database(databaseFile, { readonly: true });
try {
  const migrations = database
    .prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations')
    .get().count;
  const order = database
    .prepare(
      'SELECT id, status, total_minor AS totalMinor FROM orders WHERE id = ?',
    )
    .get(state.orderId);
  const receipt = database
    .prepare(
      `SELECT receipts.id, payments.amount_due_minor AS amountDueMinor
         FROM receipts JOIN payments ON payments.id = receipts.payment_id
        WHERE receipts.id = ?`,
    )
    .get(state.receiptId);
  const user = database
    .prepare('SELECT username FROM users WHERE username = ?')
    .get(state.username);
  const foreignKeyErrors = database.pragma('foreign_key_check');

  if (migrations !== (phase === 'legacy' ? 5 : 6)) {
    throw new Error(
      `Expected ${phase === 'legacy' ? 5 : 6} migrations, found ${migrations}.`,
    );
  }
  if (
    !user ||
    !order ||
    order.status !== 'PAID' ||
    order.totalMinor !== state.amountDueMinor
  ) {
    throw new Error(
      'The original administrator or paid order changed during upgrade.',
    );
  }
  if (!receipt || receipt.amountDueMinor !== state.amountDueMinor) {
    throw new Error('The original receipt changed during upgrade.');
  }
  if (foreignKeyErrors.length !== 0) {
    throw new Error(
      `Foreign-key check failed: ${JSON.stringify(foreignKeyErrors)}`,
    );
  }

  if (phase === 'upgraded') {
    const purchasesTable = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'purchases'",
      )
      .get();
    const purchases = database
      .prepare(
        "SELECT COUNT(*) AS count FROM purchases WHERE name = 'توريد ترقية إلكترون'",
      )
      .get().count;
    if (!purchasesTable || purchases !== 1) {
      throw new Error(
        'Migration 0005 was not applied exactly once with its persisted purchase.',
      );
    }
  }
  console.log(`${phase} database verification passed: ${databaseFile}`);
} finally {
  database.close();
}
