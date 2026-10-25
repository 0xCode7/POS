import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { openDatabase, type AppDatabase } from './db/database.js';
import { BackupService } from './maintenance/backup.js';
import { restoreBackup } from './maintenance/restore.js';

const csrf = { 'X-CSRF-Protection': '1' };
const admin = {
  username: 'owner',
  displayName: 'المدير',
  password: 'correct horse battery staple',
};

describe('admin purchases management', () => {
  let directory: string;
  let database: AppDatabase;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'restaurant-purchases-'));
    database = openDatabase({ dataDirectory: directory });
  });
  afterEach(() => {
    if (database.sqlite.open) database.sqlite.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('creates exact fractional purchases, edits them, and calculates totals server-side', async () => {
    const { adminAgent } = await actors();
    const created = await add(adminAgent, {
      name: '  طماطم   طازجة ',
      quantity: '1.25',
      unit: 'كيلو',
      unitPriceMinor: 1_350,
      purchaseDate: '2026-04-24',
    });
    expect(created).toMatchObject({
      name: 'طماطم طازجة',
      quantityMilli: 1_250,
      unit: 'كيلو',
      unitPriceMinor: 1_350,
      // 1.25 × 13.50 EGP = 16.875 EGP, rounded once to a piaster.
      totalMinor: 1_688,
      purchaseDate: '2026-04-24',
    });
    const edited = await adminAgent
      .patch(`/api/admin/purchases/${created.id}`)
      .set(csrf)
      .send({
        name: 'طماطم بلدي',
        quantity: '2.5',
        unit: 'كجم',
        unitPriceMinor: 1_200,
        purchaseDate: '2026-04-25',
      })
      .expect(200);
    expect(edited.body.purchase).toMatchObject({
      name: 'طماطم بلدي',
      quantityMilli: 2_500,
      totalMinor: 3_000,
      purchaseDate: '2026-04-25',
    });
  });

  it('enforces admin authentication, CSRF, origin checks, and validated inputs', async () => {
    const application = app();
    await request(application).get('/api/admin/purchases').expect(401);
    const { adminAgent, cashierAgent } = await actors();
    await cashierAgent.get('/api/admin/purchases').expect(403);
    await cashierAgent
      .post('/api/admin/purchases')
      .set(csrf)
      .send(purchase())
      .expect(403);
    await adminAgent.post('/api/admin/purchases').send(purchase()).expect(403);
    await adminAgent
      .post('/api/admin/purchases')
      .set(csrf)
      .set('Origin', 'http://evil.example')
      .send(purchase())
      .expect(403);
    await adminAgent
      .post('/api/admin/purchases')
      .set(csrf)
      .send({ ...purchase(), quantity: '0' })
      .expect(400);
    await adminAgent
      .post('/api/admin/purchases')
      .set(csrf)
      .send({ ...purchase(), quantity: '1.0001' })
      .expect(400);
    await adminAgent
      .post('/api/admin/purchases')
      .set(csrf)
      .send({ ...purchase(), unitPriceMinor: -1 })
      .expect(400);
  });

  it('filters Arabic names by Cairo-local day/month, paginates, and excludes deleted costs', async () => {
    const { adminAgent } = await actors();
    const first = await add(adminAgent, {
      ...purchase(),
      name: 'خضار طازج',
      quantity: '2',
      unitPriceMinor: 1_000,
      purchaseDate: '2026-04-23',
    });
    await add(adminAgent, {
      ...purchase(),
      name: 'خبز بلدي',
      quantity: '1',
      unitPriceMinor: 500,
      purchaseDate: '2026-04-24',
    });
    await add(adminAgent, {
      ...purchase(),
      name: 'خضار مجمد',
      quantity: '3',
      unitPriceMinor: 900,
      purchaseDate: '2026-05-01',
    });
    const day = await adminAgent
      .get('/api/admin/purchases?day=2026-04-24')
      .expect(200);
    expect(day.body.items.map((row: { name: string }) => row.name)).toEqual([
      'خبز بلدي',
    ]);
    const month = await adminAgent
      .get('/api/admin/purchases?month=2026-04&page=1&limit=1')
      .expect(200);
    expect(month.body.pagination).toEqual({
      page: 1,
      limit: 1,
      total: 2,
      pages: 2,
    });
    const search = await adminAgent
      .get('/api/admin/purchases?month=2026-04&search=%D8%AE%D8%B6%D8%A7%D8%B1')
      .expect(200);
    expect(search.body.items).toHaveLength(1);
    expect(search.body.items[0].name).toBe('خضار طازج');
    await adminAgent
      .delete(`/api/admin/purchases/${first.id}`)
      .set(csrf)
      .expect(204);
    const remaining = await adminAgent
      .get('/api/admin/purchases?month=2026-04')
      .expect(200);
    expect(remaining.body.pagination.total).toBe(1);
    expect(
      database.sqlite
        .prepare('SELECT deleted_at AS deletedAt FROM purchases WHERE id = ?')
        .get(first.id),
    ).toHaveProperty('deletedAt');
    await adminAgent
      .patch(`/api/admin/purchases/${first.id}`)
      .set(csrf)
      .send(purchase())
      .expect(404);
    await adminAgent
      .get('/api/admin/purchases?day=2026-04-24&month=2026-04')
      .expect(400);
  });

  it('persists purchases and restores them from safe SQLite online backups without affecting sales tables', async () => {
    const { adminAgent } = await actors();
    const created = await add(adminAgent, {
      ...purchase(),
      name: 'زيت',
      quantity: '3.5',
      unitPriceMinor: 4_000,
      purchaseDate: '2026-05-10',
    });
    const backup = await new BackupService(database).create('manual');
    const copy = new Database(
      path.join(directory, 'backups', backup.filename),
      {
        readonly: true,
      },
    );
    expect(
      copy
        .prepare('SELECT total_minor AS totalMinor FROM purchases WHERE id = ?')
        .get(created.id),
    ).toEqual({ totalMinor: 14_000 });
    copy.close();
    database.sqlite
      .prepare('UPDATE purchases SET name = ? WHERE id = ?')
      .run('تعديل مؤقت', created.id);
    database.sqlite.close();
    await restoreBackup({
      dataDirectory: directory,
      backupDirectory: path.join(directory, 'backups'),
      filename: backup.filename,
      username: admin.username,
      password: admin.password,
      confirmation: `RESTORE ${backup.filename}`,
    });
    database = openDatabase({ dataDirectory: directory });
    expect(
      database.sqlite
        .prepare('SELECT name FROM purchases WHERE id = ?')
        .get(created.id),
    ).toEqual({ name: 'زيت' });
    expect(
      database.sqlite.prepare('SELECT COUNT(*) AS total FROM payments').get(),
    ).toEqual({
      total: 0,
    });
  });

  it('adds the purchases table when an existing Stage 6 database starts the newer application', () => {
    database.sqlite.close();
    fs.unlinkSync(path.join(directory, 'restaurant-pos.sqlite'));
    const migrations = path.join(directory, 'stage6-migrations');
    fs.mkdirSync(path.join(migrations, 'meta'), { recursive: true });
    const source = path.resolve('drizzle');
    for (const name of [
      '0000_auth.sql',
      '0001_menu.sql',
      '0002_orders.sql',
      '0003_cash_settlement.sql',
      '0004_reporting_indexes.sql',
    ])
      fs.copyFileSync(path.join(source, name), path.join(migrations, name));
    const journal = JSON.parse(
      fs.readFileSync(path.join(source, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    journal.entries = journal.entries.slice(0, 5);
    fs.writeFileSync(
      path.join(migrations, 'meta', '_journal.json'),
      JSON.stringify(journal),
    );
    database = openDatabase({
      dataDirectory: directory,
      migrationsFolder: migrations,
    });
    database.sqlite
      .prepare(
        "INSERT INTO users (id,username,display_name,password_hash,role,active,created_at,updated_at) VALUES ('owner','owner','Owner','hash','admin',1,1,1)",
      )
      .run();
    database.sqlite.close();
    database = openDatabase({ dataDirectory: directory });
    expect(
      database.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'purchases'",
        )
        .get(),
    ).toEqual({
      name: 'purchases',
    });
    expect(database.sqlite.prepare('SELECT username FROM users').get()).toEqual(
      {
        username: 'owner',
      },
    );
  });

  function app() {
    return createApp({ database, disableRateLimit: true });
  }
  async function actors() {
    await request(app())
      .post('/api/auth/setup')
      .set(csrf)
      .send(admin)
      .expect(201);
    const adminAgent = request.agent(app());
    await adminAgent
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: admin.username, password: admin.password })
      .expect(200);
    await adminAgent
      .post('/api/admin/users')
      .set(csrf)
      .send({
        username: 'cashier',
        displayName: 'كاشير',
        password: 'cashier secure password',
        role: 'cashier',
      })
      .expect(201);
    const cashierAgent = request.agent(app());
    await cashierAgent
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: 'cashier', password: 'cashier secure password' })
      .expect(200);
    return { adminAgent, cashierAgent };
  }
});

function purchase() {
  return {
    name: 'مشتريات تجريبية',
    quantity: '1',
    unit: null,
    unitPriceMinor: 1_000,
    purchaseDate: '2026-04-24',
  };
}

async function add(
  agent: ReturnType<typeof request.agent>,
  input: ReturnType<typeof purchase>,
) {
  const response = await agent
    .post('/api/admin/purchases')
    .set(csrf)
    .send(input)
    .expect(201);
  return response.body.purchase as {
    id: string;
    name: string;
    quantityMilli: number;
    unit: string | null;
    unitPriceMinor: number;
    totalMinor: number;
    purchaseDate: string;
  };
}
