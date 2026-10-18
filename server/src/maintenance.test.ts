import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { openDatabase, type AppDatabase } from './db/database.js';
import { BackupService, verifyBackup } from './maintenance/backup.js';
import { restoreBackup } from './maintenance/restore.js';

const csrf = { 'X-CSRF-Protection': '1' };
const admin = {
  username: 'owner',
  displayName: 'Owner',
  password: 'correct horse battery staple',
};

describe('backup, restore, and reliability', () => {
  let directory: string;
  let backupDirectory: string;
  let database: AppDatabase;

  beforeEach(async () => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'restaurant-maintenance-'),
    );
    backupDirectory = path.join(directory, 'external-backups');
    database = openDatabase({ dataDirectory: path.join(directory, 'data') });
    await request(createApp({ database, disableRateLimit: true }))
      .post('/api/auth/setup')
      .set(csrf)
      .send(admin)
      .expect(201);
  });

  afterEach(() => {
    delete process.env.POS_BACKUP_DIR;
    if (database.sqlite.open) database.sqlite.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('creates an integrity-checked online backup while writes continue', async () => {
    const backups = configuredBackups();
    const agent = await login('owner', admin.password);
    const [backup, category] = await Promise.all([
      backups.create('manual'),
      agent
        .post('/api/admin/menu/categories')
        .set(csrf)
        .send({ name: 'أثناء النسخ', sortOrder: 0, isActive: true }),
    ]);
    expect(category.status).toBe(201);
    expect(verifyBackup(path.join(backupDirectory, backup.filename))).toBe(5);
    expect(
      fs.readdirSync(backupDirectory).some((name) => name.includes('.partial')),
    ).toBe(false);
    expect(backups.status()).toMatchObject({
      lastSuccessfulAt: backup.createdAt,
      retentionDays: 30,
    });
    expect(database.sqlite.pragma('journal_mode', { simple: true })).toBe(
      'wal',
    );
    expect(database.sqlite.pragma('synchronous', { simple: true })).toBe(2);
    expect(database.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(database.sqlite.pragma('integrity_check', { simple: true })).toBe(
      'ok',
    );
  });

  it('protects backup APIs with admin authentication and CSRF', async () => {
    process.env.POS_BACKUP_DIR = backupDirectory;
    const app = createApp({ database, disableRateLimit: true });
    const adminAgent = request.agent(app);
    await adminAgent
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: admin.username, password: admin.password });
    await adminAgent.get('/api/admin/backups').expect(200);
    await request(app).get('/api/admin/backups/history').expect(401);
    await request(app).post('/api/admin/backups/pick-directory').expect(401);
    await adminAgent.post('/api/admin/backups').expect(403);
    const created = await adminAgent
      .post('/api/admin/backups')
      .set(csrf)
      .expect(201);
    expect(created.body.backup.filename).toMatch(/^restaurant-pos-/);
    expect(created.headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
    expect(created.headers['x-content-type-options']).toBe('nosniff');
    await adminAgent
      .post('/api/admin/users')
      .set(csrf)
      .send({
        username: 'backup-cashier',
        displayName: 'Backup Cashier',
        password: 'cashier password',
        role: 'cashier',
      })
      .expect(201);
    const cashier = request.agent(app);
    await cashier
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: 'backup-cashier', password: 'cashier password' })
      .expect(200);
    await cashier.get('/api/admin/backups/history').expect(403);
    await cashier
      .patch('/api/admin/backups/settings')
      .set(csrf)
      .send({ directory: path.join(directory, 'cashier-attempt') })
      .expect(403);
    await cashier
      .post('/api/admin/backups/pick-directory')
      .set(csrf)
      .expect(403);
    delete process.env.POS_BACKUP_DIR;
  });

  it('stores safe Arabic and English friendly names beside backups without filename collisions', async () => {
    const service = configuredBackups();
    const arabic = await service.create('manual', {
      friendlyName: '  نسخة   نهاية   اليوم  ',
    });
    const english = await service.create('manual', {
      friendlyName: 'Closing backup',
    });
    const duplicate = await service.create('manual', {
      friendlyName: 'Closing backup',
    });
    const unnamed = await service.create('manual', { friendlyName: '   ' });

    expect(arabic).toMatchObject({
      friendlyName: 'نسخة نهاية اليوم',
      hasCustomName: true,
    });
    expect(english).toMatchObject({
      friendlyName: 'Closing backup',
      hasCustomName: true,
    });
    expect(duplicate.filename).not.toBe(english.filename);
    expect(unnamed).toMatchObject({
      friendlyName: 'نسخة يدوية',
      hasCustomName: false,
    });
    expect(
      fs.existsSync(
        path.join(backupDirectory, `${arabic.filename}.metadata.json`),
      ),
    ).toBe(true);
    service.changeDirectory(backupDirectory);
    expect(new BackupService(database).inspect(arabic.filename)).toMatchObject({
      friendlyName: 'نسخة نهاية اليوم',
      hasCustomName: true,
    });

    const copiedDirectory = path.join(directory, 'copied-backups');
    fs.mkdirSync(copiedDirectory);
    fs.copyFileSync(
      path.join(backupDirectory, arabic.filename),
      path.join(copiedDirectory, arabic.filename),
    );
    fs.copyFileSync(
      path.join(backupDirectory, `${arabic.filename}.metadata.json`),
      path.join(copiedDirectory, `${arabic.filename}.metadata.json`),
    );
    service.changeDirectory(copiedDirectory);
    expect(service.inspect(arabic.filename)).toMatchObject({
      friendlyName: 'نسخة نهاية اليوم',
      hasCustomName: true,
    });
    await expect(
      service.create('manual', { friendlyName: 'اسم/غير صالح' }),
    ).rejects.toThrow('رموز غير مسموح');
    await expect(
      service.create('manual', { friendlyName: 'CON' }),
    ).rejects.toThrow('محجوز');
  });

  it('changes the backup directory safely and persists it across service restart', async () => {
    const service = new BackupService(database);
    const app = createApp({
      database,
      backupService: service,
      disableRateLimit: true,
    });
    const agent = request.agent(app);
    await agent
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: admin.username, password: admin.password })
      .expect(200);
    const selected = path.join(directory, 'selected-backups');
    const changed = await agent
      .patch('/api/admin/backups/settings')
      .set(csrf)
      .send({ directory: selected })
      .expect(200);
    expect(changed.body.backups).toMatchObject({
      directory: selected,
      directorySource: 'saved',
      environmentManaged: false,
    });
    expect(changed.body.backups.previousDirectories).toContain(
      path.join(directory, 'data', 'backups'),
    );
    const created = await agent
      .post('/api/admin/backups')
      .set(csrf)
      .expect(201);
    expect(
      fs.existsSync(path.join(selected, created.body.backup.filename)),
    ).toBe(true);
    expect(new BackupService(database).directory).toBe(selected);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(directory, 'data', 'backup-settings.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ directory: selected });
  });

  it('rejects unsafe, unwritable or non-directory, and environment-managed backup directory changes', async () => {
    const service = new BackupService(database);
    const app = createApp({
      database,
      backupService: service,
      disableRateLimit: true,
    });
    const agent = request.agent(app);
    await agent
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: admin.username, password: admin.password })
      .expect(200);
    await agent
      .patch('/api/admin/backups/settings')
      .set(csrf)
      .send({ directory: 'relative/backups' })
      .expect(400);
    await agent
      .patch('/api/admin/backups/settings')
      .set(csrf)
      .send({ directory: path.join(directory, 'data') })
      .expect(400);
    await agent
      .patch('/api/admin/backups/settings')
      .set(csrf)
      .send({ directory: process.cwd() })
      .expect(400);
    const readOnly = path.join(directory, 'read-only');
    fs.mkdirSync(readOnly, { mode: 0o500 });
    if (process.platform === 'win32') {
      // Windows does not enforce POSIX directory modes such as 0500. Use an
      // existing file instead, which reliably cannot become a backup folder.
      const nonDirectory = path.join(directory, 'not-a-directory');
      fs.writeFileSync(nonDirectory, 'not a directory');
      await agent
        .patch('/api/admin/backups/settings')
        .set(csrf)
        .send({ directory: nonDirectory })
        .expect(400);
    } else {
      await agent
        .patch('/api/admin/backups/settings')
        .set(csrf)
        .send({ directory: readOnly })
        .expect(400);
    }

    process.env.POS_BACKUP_DIR = backupDirectory;
    const managed = new BackupService(database);
    const managedAgent = request.agent(
      createApp({ database, backupService: managed, disableRateLimit: true }),
    );
    await managedAgent
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: admin.username, password: admin.password })
      .expect(200);
    await managedAgent
      .patch('/api/admin/backups/settings')
      .set(csrf)
      .send({ directory: path.join(directory, 'other') })
      .expect(400);
    delete process.env.POS_BACKUP_DIR;
  });

  it('paginates validated history and performs reauthenticated restore preflight without restoring', async () => {
    const service = configuredBackups();
    const first = await service.create('manual');
    await service.create('manual');
    const corrupt = 'restaurant-pos-20200101T000000Z-manual-deadbeef.sqlite';
    fs.writeFileSync(path.join(backupDirectory, corrupt), 'not sqlite');
    const app = createApp({
      database,
      backupService: service,
      disableRateLimit: true,
    });
    const agent = request.agent(app);
    await agent
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: admin.username, password: admin.password })
      .expect(200);
    const pageOne = await agent
      .get('/api/admin/backups/history?page=1&limit=2')
      .expect(200);
    expect(pageOne.body.items).toHaveLength(2);
    expect(pageOne.body.pagination).toMatchObject({ total: 3, pages: 2 });
    const corruptResult = await agent
      .get(`/api/admin/backups/history?search=${corrupt}`)
      .expect(200);
    expect(corruptResult.body.items[0]).toMatchObject({
      validation: 'corrupt',
      integrity: 'corrupt',
      compatibility: 'unverified',
      restoreEligible: false,
    });
    await agent
      .post(`/api/admin/backups/${first.filename}/restore-preflight`)
      .set(csrf)
      .send({
        password: 'wrong password',
        confirmation: `RESTORE ${first.filename}`,
      })
      .expect(400);
    const prepared = await agent
      .post(`/api/admin/backups/${first.filename}/restore-preflight`)
      .set(csrf)
      .send({
        password: admin.password,
        confirmation: `RESTORE ${first.filename}`,
      })
      .expect(200);
    expect(prepared.body).toMatchObject({
      restoreAvailable: false,
      mode: 'offline-cli',
    });
    expect(
      fs
        .readdirSync(backupDirectory)
        .filter((name) => name.includes('pre-restore')),
    ).toHaveLength(0);
  });

  it('distinguishes valid, corrupt, incompatible, and missing backups without changing financial data', async () => {
    const service = configuredBackups();
    const valid = await service.create('manual');
    const financialBefore = database.sqlite
      .prepare('SELECT COUNT(*) AS payments FROM payments')
      .get();

    expect(service.inspect(valid.filename)).toMatchObject({
      validation: 'valid',
      integrity: 'valid',
      compatibility: 'compatible',
      restoreEligible: true,
    });

    const incompatibleName =
      'restaurant-pos-20200101T000001Z-manual-acde0001.sqlite';
    const incompatiblePath = path.join(backupDirectory, incompatibleName);
    fs.copyFileSync(
      path.join(backupDirectory, valid.filename),
      incompatiblePath,
    );
    const incompatible = new Database(incompatiblePath);
    incompatible
      .prepare(
        'UPDATE __drizzle_migrations SET hash = ? WHERE created_at = (SELECT MAX(created_at) FROM __drizzle_migrations)',
      )
      .run('diverged-migration-signature');
    incompatible.close();
    expect(service.inspect(incompatibleName)).toMatchObject({
      validation: 'incompatible',
      integrity: 'valid',
      compatibility: 'incompatible',
      restoreEligible: false,
    });

    const corruptName =
      'restaurant-pos-20200101T000002Z-manual-acde0002.sqlite';
    fs.writeFileSync(path.join(backupDirectory, corruptName), 'broken sqlite');
    expect(service.inspect(corruptName)).toMatchObject({
      validation: 'corrupt',
      integrity: 'corrupt',
      compatibility: 'unverified',
      restoreEligible: false,
    });
    expect(() =>
      service.inspect('restaurant-pos-20200101T000003Z-manual-acde0003.sqlite'),
    ).toThrow('غير موجود');
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) AS payments FROM payments')
        .get(),
    ).toEqual(financialBefore);
  });

  it('accepts an intact older migration prefix and safely migrates only the staging restore copy', async () => {
    const service = configuredBackups();
    fs.mkdirSync(backupDirectory, { recursive: true });
    const olderMigrations = path.join(directory, 'older-migrations');
    fs.mkdirSync(path.join(olderMigrations, 'meta'), { recursive: true });
    for (const migration of [
      '0000_auth.sql',
      '0001_menu.sql',
      '0002_orders.sql',
      '0003_cash_settlement.sql',
    ])
      fs.copyFileSync(
        path.resolve('drizzle', migration),
        path.join(olderMigrations, migration),
      );
    const journal = JSON.parse(
      fs.readFileSync(path.resolve('drizzle/meta/_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    journal.entries = journal.entries.slice(0, 4);
    fs.writeFileSync(
      path.join(olderMigrations, 'meta/_journal.json'),
      JSON.stringify(journal),
    );
    const olderDatabase = openDatabase({
      dataDirectory: path.join(directory, 'older-data'),
      migrationsFolder: olderMigrations,
    });
    await request(
      createApp({ database: olderDatabase, disableRateLimit: true }),
    )
      .post('/api/auth/setup')
      .set(csrf)
      .send(admin)
      .expect(201);
    const filename = 'restaurant-pos-20200101T000004Z-manual-acde0004.sqlite';
    const backupPath = path.join(backupDirectory, filename);
    await olderDatabase.sqlite.backup(backupPath);
    olderDatabase.sqlite.close();

    expect(service.inspect(filename)).toMatchObject({
      validation: 'valid',
      integrity: 'valid',
      compatibility: 'compatible',
      pendingMigrations: 1,
      restoreEligible: true,
    });
    const originalBackupMigrations = new Database(backupPath, {
      readonly: true,
    });
    expect(
      originalBackupMigrations
        .prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations')
        .get(),
    ).toEqual({ count: 4 });
    originalBackupMigrations.close();

    database.sqlite.close();
    await restoreBackup({
      dataDirectory: path.join(directory, 'data'),
      backupDirectory,
      filename,
      username: admin.username,
      password: admin.password,
      confirmation: `RESTORE ${filename}`,
    });
    database = openDatabase({ dataDirectory: path.join(directory, 'data') });
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations')
        .get(),
    ).toEqual({ count: 5 });
    const untouchedBackup = new Database(backupPath, { readonly: true });
    expect(
      untouchedBackup
        .prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations')
        .get(),
    ).toEqual({ count: 4 });
    untouchedBackup.close();
  });

  it('restores only a compatible safe backup, invalidates sessions, and keeps a pre-restore backup', async () => {
    const backup = await configuredBackups().create('manual');
    database.sqlite
      .prepare('UPDATE users SET display_name = ? WHERE username = ?')
      .run('Changed', admin.username);
    database.sqlite.close();
    const result = await restoreBackup({
      dataDirectory: path.join(directory, 'data'),
      backupDirectory,
      filename: backup.filename,
      username: admin.username,
      password: admin.password,
      confirmation: `RESTORE ${backup.filename}`,
    });
    expect(result.preRestoreBackup).toContain('pre-restore');
    database = openDatabase({ dataDirectory: path.join(directory, 'data') });
    expect(
      database.sqlite
        .prepare('SELECT display_name AS name FROM users WHERE username = ?')
        .get(admin.username),
    ).toEqual({ name: admin.displayName });
    expect(
      database.sqlite.prepare('SELECT COUNT(*) count FROM sessions').get(),
    ).toEqual({ count: 0 });
  });

  it('recovers the original database after an interrupted restore', async () => {
    const backup = await configuredBackups().create('manual');
    database.sqlite
      .prepare('UPDATE users SET display_name = ? WHERE username = ?')
      .run('Must survive', admin.username);
    database.sqlite.close();
    await expect(
      restoreBackup({
        dataDirectory: path.join(directory, 'data'),
        backupDirectory,
        filename: backup.filename,
        username: admin.username,
        password: admin.password,
        confirmation: `RESTORE ${backup.filename}`,
        simulateInterruptionAfterLiveRename: true,
      }),
    ).rejects.toThrow('Simulated interruption');
    database = openDatabase({ dataDirectory: path.join(directory, 'data') });
    expect(
      database.sqlite
        .prepare('SELECT display_name AS name FROM users WHERE username = ?')
        .get(admin.username),
    ).toEqual({ name: 'Must survive' });
  });

  it('rejects traversal, bad confirmation, non-admin credentials, and corrupt backups', async () => {
    const backup = await configuredBackups().create('manual');
    database.sqlite.close();
    const base = {
      dataDirectory: path.join(directory, 'data'),
      backupDirectory,
      username: admin.username,
      password: admin.password,
    };
    await expect(
      restoreBackup({
        ...base,
        filename: '../escape.sqlite',
        confirmation: 'RESTORE ../escape.sqlite',
      }),
    ).rejects.toThrow('غير مسموح');
    await expect(
      restoreBackup({
        ...base,
        filename: backup.filename,
        confirmation: 'yes',
      }),
    ).rejects.toThrow('تأكيد');
    await expect(
      restoreBackup({
        ...base,
        filename: backup.filename,
        password: 'wrong password',
        confirmation: `RESTORE ${backup.filename}`,
      }),
    ).rejects.toThrow('مصادقة');
    const corrupt = 'restaurant-pos-20200101T000000Z-manual-deadbeef.sqlite';
    fs.writeFileSync(
      path.join(backupDirectory, corrupt),
      'not a sqlite database',
    );
    await expect(
      restoreBackup({
        ...base,
        filename: corrupt,
        confirmation: `RESTORE ${corrupt}`,
      }),
    ).rejects.toThrow();
    database = openDatabase({ dataDirectory: path.join(directory, 'data') });
  });

  it('conservatively removes expired daily backups but preserves seven recent copies and manual copies', async () => {
    const backups = configuredBackups();
    const source = await backups.create('manual');
    const sourcePath = path.join(backupDirectory, source.filename);
    for (let index = 1; index <= 9; index += 1) {
      const day = String(index).padStart(2, '0');
      fs.copyFileSync(
        sourcePath,
        path.join(
          backupDirectory,
          `restaurant-pos-202001${day}T000000Z-daily-0000000${index}.sqlite`,
        ),
      );
    }
    await backups.create('daily');
    const history = backups.history(100);
    expect(history.filter((entry) => entry.kind === 'daily')).toHaveLength(7);
    expect(history.some((entry) => entry.filename === source.filename)).toBe(
      true,
    );
  });

  function configuredBackups() {
    process.env.POS_BACKUP_DIR = backupDirectory;
    const service = new BackupService(database);
    delete process.env.POS_BACKUP_DIR;
    return service;
  }

  async function login(username: string, password: string) {
    const agent = request.agent(
      createApp({
        database,
        backupService: configuredBackups(),
        disableRateLimit: true,
      }),
    );
    await agent
      .post('/api/auth/login')
      .set(csrf)
      .send({ username, password })
      .expect(200);
    return agent;
  }
});
