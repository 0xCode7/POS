import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPassword } from '../auth/security.js';
import { openDatabase, resolveDataDirectory } from '../db/database.js';
import * as schema from '../db/schema.js';
import { BackupService, verifyBackup } from './backup.js';
import {
  migrationCompatibility,
  migrationSignatures,
} from './backup-validation.js';
import { resolveBackupDirectory, safeBackupPath } from './paths.js';
import { acquireRuntimeLock } from './runtime-lock.js';
import {
  recoverInterruptedRestore,
  removeSidecars,
  rollbackName,
  stagingName,
} from './recovery.js';

export async function restoreBackup(input: {
  dataDirectory?: string;
  backupDirectory?: string;
  filename: string;
  username?: string;
  password?: string;
  confirmation?: string;
  trustedSupervisor?: boolean;
  simulateInterruptionAfterLiveRename?: boolean;
}) {
  const dataDirectory = resolveDataDirectory(input.dataDirectory);
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  recoverInterruptedRestore(dataDirectory);
  const release = acquireRuntimeLock(dataDirectory, 'restore');
  let database: ReturnType<typeof openDatabase> | undefined;
  try {
    database = openDatabase({ dataDirectory });
    const backupDirectory = input.backupDirectory
      ? resolveBackupDirectory(database.filename, input.backupDirectory)
      : resolveBackupDirectory(database.filename);
    const candidate = safeBackupPath(backupDirectory, input.filename);
    if (
      !input.trustedSupervisor &&
      input.confirmation !== `RESTORE ${input.filename}`
    )
      throw new Error('عبارة تأكيد الاستعادة لا تطابق النسخة المحددة.');
    if (!input.trustedSupervisor) {
      const user = database.sqlite
        .prepare(
          'SELECT role, active, password_hash AS passwordHash FROM users WHERE username = ?',
        )
        .get(input.username?.trim().toLowerCase()) as
        { role: string; active: number; passwordHash: string } | undefined;
      if (
        !user ||
        user.role !== 'admin' ||
        !user.active ||
        !(await verifyPassword(user.passwordHash, input.password ?? ''))
      )
        throw new Error('فشلت إعادة مصادقة المدير بكلمة المرور الحالية.');
    }
    const expectedMigrations = migrationSignatures(database.sqlite);
    verifyBackup(candidate);
    removeSidecars(candidate);
    const candidateDatabase = new Database(candidate, { readonly: true });
    const candidateMigrations = migrationSignatures(candidateDatabase);
    candidateDatabase.close();
    removeSidecars(candidate);
    const compatibility = migrationCompatibility(
      candidateMigrations,
      expectedMigrations,
    );
    if (!compatibility.compatible)
      throw new Error(
        'مخطط النسخة الاحتياطية غير متوافق مع إصدار التطبيق الحالي.',
      );
    const preRestore = await new BackupService(database).create('pre-restore');
    const live = database.filename;
    database.sqlite.close();
    database = undefined;

    const staging = path.join(dataDirectory, stagingName);
    const rollback = path.join(dataDirectory, rollbackName);
    fs.rmSync(staging, { force: true });
    fs.copyFileSync(candidate, staging, fs.constants.COPYFILE_EXCL);
    verifyBackup(staging);
    removeSidecars(staging);
    migrateStagingDatabase(staging);
    verifyBackup(staging);
    invalidateSessions(staging);
    removeSidecars(live);
    fs.renameSync(live, rollback);
    if (input.simulateInterruptionAfterLiveRename)
      throw new Error('Simulated interruption after live database rename.');
    fs.renameSync(staging, live);
    verifyBackup(live);
    fs.rmSync(rollback, { force: true });
    return {
      restoredFrom: input.filename,
      preRestoreBackup: preRestore.filename,
    };
  } catch (error) {
    if (database?.sqlite.open) database.sqlite.close();
    recoverInterruptedRestore(dataDirectory);
    throw error;
  } finally {
    release();
  }
}

function migrateStagingDatabase(filename: string) {
  const sqlite = new Database(filename);
  try {
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('synchronous = FULL');
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    migrate(drizzle(sqlite, { schema }), {
      migrationsFolder: path.resolve(moduleDirectory, '../../drizzle'),
    });
    if (
      sqlite.pragma('integrity_check', { simple: true }) !== 'ok' ||
      (sqlite.pragma('foreign_key_check') as unknown[]).length > 0
    )
      throw new Error('فشل التحقق من النسخة بعد تطبيق الترحيلات المطلوبة.');
  } finally {
    sqlite.close();
    removeSidecars(filename);
  }
}

function invalidateSessions(filename: string) {
  const database = new Database(filename);
  try {
    database.pragma('foreign_keys = ON');
    database.prepare('DELETE FROM sessions').run();
    database.pragma('wal_checkpoint(TRUNCATE)');
    database.pragma('journal_mode = DELETE');
    const integrity = database.pragma('integrity_check') as Array<{
      integrity_check: string;
    }>;
    if (integrity[0]?.integrity_check !== 'ok')
      throw new Error(
        'Restored database failed validation after session invalidation.',
      );
  } finally {
    database.close();
  }
}
