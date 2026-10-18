import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { openDatabase, type AppDatabase } from './db/database.js';
import { parseReportRange } from './reports/service.js';

const csrf = { 'X-CSRF-Protection': '1' };
const password = 'correct horse battery staple';

describe('admin sales reports', () => {
  let directory: string;
  let database: AppDatabase;
  let adminAgent: ReturnType<typeof request.agent>;
  let cashierAgent: ReturnType<typeof request.agent>;
  let adminId: string;
  let cashierId: string;
  let menuItemId: string;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'restaurant-reports-'));
    database = openDatabase({ dataDirectory: directory });
    const app = () => createApp({ database, disableRateLimit: true });
    await request(app()).post('/api/auth/setup').set(csrf).send({
      username: 'owner',
      displayName: 'المدير',
      password,
    });
    adminAgent = request.agent(app());
    await adminAgent
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: 'owner', password });
    await adminAgent.post('/api/admin/users').set(csrf).send({
      username: 'cashier',
      displayName: 'أحمد',
      password,
      role: 'cashier',
    });
    cashierAgent = request.agent(app());
    await cashierAgent
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: 'cashier', password });
    const users = database.sqlite
      .prepare('SELECT id, username FROM users')
      .all() as Array<{ id: string; username: string }>;
    adminId = users.find((user) => user.username === 'owner')!.id;
    cashierId = users.find((user) => user.username === 'cashier')!.id;
    const categoryId = randomUUID();
    menuItemId = randomUUID();
    const now = Date.now();
    database.sqlite
      .prepare(
        'INSERT INTO menu_categories (id,name,sort_order,is_active,created_at,updated_at) VALUES (?,?,0,1,?,?)',
      )
      .run(categoryId, 'مشروبات', now, now);
    database.sqlite
      .prepare(
        'INSERT INTO menu_items (id,category_id,name,price_minor,is_available,is_archived,sort_order,created_at,updated_at) VALUES (?,?,?,1000,1,0,0,?,?)',
      )
      .run(menuItemId, categoryId, 'حالي', now, now);
  });

  afterEach(() => {
    database.sqlite.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('calculates revenue, cash and immutable item totals and attributes checkout actor', async () => {
    insertSale(
      'ORD-1',
      'شاي قديم',
      2,
      1000,
      2500,
      cashierId,
      '2026-06-10T10:00:00+03:00',
    );
    insertSale(
      'ORD-2',
      'قهوة',
      1,
      1500,
      1500,
      adminId,
      '2026-06-10T14:00:00+03:00',
    );
    insertOrderOnly('ORD-OPEN', 'OPEN');
    insertOrderOnly('ORD-CANCELLED', 'CANCELLED');
    database.sqlite
      .prepare('UPDATE menu_items SET name = ?, price_minor = ? WHERE id = ?')
      .run('اسم جديد', 9999, menuItemId);
    const query = 'start=2026-06-10&end=2026-06-11&timezone=Africa%2FCairo';
    const summary = await adminAgent
      .get(`/api/admin/reports/summary?${query}`)
      .expect(200);
    expect(summary.body).toMatchObject({
      revenueMinor: 3500,
      paidOrders: 2,
      averageTicketMinor: 1750,
      cashReceivedMinor: 4000,
      changeMinor: 500,
    });
    const items = await adminAgent
      .get(`/api/admin/reports/top-items?${query}`)
      .expect(200);
    expect(items.body.items).toEqual([
      { name: 'شاي قديم', quantity: 2, revenueMinor: 2000 },
      { name: 'قهوة', quantity: 1, revenueMinor: 1500 },
    ]);
    const cashiers = await adminAgent
      .get(`/api/admin/reports/by-cashier?${query}`)
      .expect(200);
    expect(cashiers.body.cashiers).toEqual([
      {
        userId: cashierId,
        displayName: 'أحمد',
        paidOrders: 1,
        revenueMinor: 2000,
      },
      {
        userId: adminId,
        displayName: 'المدير',
        paidOrders: 1,
        revenueMinor: 1500,
      },
    ]);
  });

  it('uses payment timestamps with inclusive/exclusive Cairo boundaries and DST', async () => {
    insertSale(
      'BEFORE',
      'قبل',
      1,
      1000,
      1000,
      cashierId,
      '2026-04-23T23:59:59+02:00',
    );
    insertSale(
      'INSIDE',
      'داخل',
      1,
      2000,
      2000,
      cashierId,
      '2026-04-24T01:00:00+03:00',
    );
    insertSale(
      'END',
      'نهاية',
      1,
      3000,
      3000,
      cashierId,
      '2026-04-25T00:00:00+03:00',
    );
    const response = await adminAgent
      .get('/api/admin/reports/summary?start=2026-04-24&end=2026-04-25')
      .expect(200);
    expect(response.body).toMatchObject({ revenueMinor: 2000, paidOrders: 1 });
    const spring = parseReportRange({ start: '2026-04-24', end: '2026-04-25' });
    const autumn = parseReportRange({ start: '2026-10-29', end: '2026-10-30' });
    expect((spring.endMs - spring.startMs) / 3_600_000).toBe(23);
    expect((autumn.endMs - autumn.startMs) / 3_600_000).toBe(25);
    const daily = await adminAgent
      .get('/api/admin/reports/daily?start=2026-04-24&end=2026-04-25')
      .expect(200);
    expect(daily.body.days[0]).toMatchObject({
      date: '2026-04-24',
      revenueMinor: 2000,
      paidOrders: 1,
    });
  });

  it('supports empty ranges, receipt pagination/search, and reprints do not alter sales', async () => {
    const receiptId = insertSale(
      'FIND-ME',
      'كشري',
      1,
      4200,
      5000,
      cashierId,
      '2026-07-01T12:00:00+03:00',
    );
    insertSale(
      'OTHER',
      'شاي',
      1,
      1000,
      1000,
      cashierId,
      '2026-07-01T13:00:00+03:00',
    );
    const query = 'start=2026-07-01&end=2026-07-02';
    const found = await adminAgent
      .get(`/api/admin/reports/receipts?${query}&search=FIND-ME&page=1&limit=1`)
      .expect(200);
    expect(found.body.pagination).toMatchObject({ total: 1, pages: 1 });
    expect(found.body.items[0]).toMatchObject({
      orderNumber: 'FIND-ME',
      amountDueMinor: 4200,
      cashTenderedMinor: 5000,
      changeMinor: 800,
    });
    const paged = await adminAgent
      .get(`/api/admin/reports/receipts?${query}&page=2&limit=1`)
      .expect(200);
    expect(paged.body.pagination).toMatchObject({
      page: 2,
      limit: 1,
      total: 2,
      pages: 2,
    });
    expect(paged.body.items).toHaveLength(1);
    await cashierAgent
      .post(`/api/receipts/${receiptId}/print-attempts`)
      .set(csrf)
      .send({ outcome: 'DIALOG_OPENED' })
      .expect(201);
    const after = await adminAgent
      .get(`/api/admin/reports/summary?${query}`)
      .expect(200);
    expect(after.body).toMatchObject({ revenueMinor: 5200, paidOrders: 2 });
    const empty = await adminAgent
      .get('/api/admin/reports/summary?start=2025-01-01&end=2025-01-02')
      .expect(200);
    expect(empty.body).toMatchObject({
      revenueMinor: 0,
      paidOrders: 0,
      averageTicketMinor: 0,
    });
    await adminAgent
      .get('/api/admin/reports/receipts?start=bad&end=2026-01-01')
      .expect(400);
    await adminAgent
      .get(`/api/admin/reports/receipts?${query}&page=0`)
      .expect(400);
  });

  it('denies cashier API access and persists reports across database restart', async () => {
    insertSale(
      'PERSIST',
      'طبق',
      2,
      1250,
      3000,
      cashierId,
      '2026-08-02T12:00:00+03:00',
    );
    await cashierAgent
      .get('/api/admin/reports/summary?start=2026-08-02&end=2026-08-03')
      .expect(403);
    database.sqlite.close();
    database = openDatabase({ dataDirectory: directory });
    const app = createApp({ database, disableRateLimit: true });
    adminAgent = request.agent(app);
    await adminAgent
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: 'owner', password })
      .expect(200);
    const result = await adminAgent
      .get('/api/admin/reports/summary?start=2026-08-02&end=2026-08-03')
      .expect(200);
    expect(result.body).toMatchObject({
      revenueMinor: 2500,
      paidOrders: 1,
      cashReceivedMinor: 3000,
      changeMinor: 500,
    });
  });

  function insertOrderOnly(orderNumber: string, status: 'OPEN' | 'CANCELLED') {
    const now = Date.now();
    database.sqlite
      .prepare(
        'INSERT INTO orders (id,order_number,status,created_by_user_id,subtotal_minor,total_minor,version,created_at,updated_at) VALUES (?,?,?,?,0,0,1,?,?)',
      )
      .run(randomUUID(), orderNumber, status, adminId, now, now);
  }

  function insertSale(
    orderNumber: string,
    name: string,
    quantity: number,
    unitPrice: number,
    tendered: number,
    actorId: string,
    paidAt: string,
  ) {
    const orderId = randomUUID();
    const paymentId = randomUUID();
    const receiptId = randomUUID();
    const total = quantity * unitPrice;
    const paidMs = DateTime.fromISO(paidAt, { setZone: true })
      .toUTC()
      .toMillis();
    const orderCreated = DateTime.fromISO('2020-01-01T00:00:00Z').toMillis();
    database.sqlite
      .prepare(
        "INSERT INTO orders (id,order_number,status,created_by_user_id,subtotal_minor,total_minor,version,created_at,updated_at) VALUES (?,?,'PAID',?,?,?,2,?,?)",
      )
      .run(orderId, orderNumber, adminId, total, total, orderCreated, paidMs);
    database.sqlite
      .prepare(
        'INSERT INTO order_items (id,order_id,menu_item_id,item_name_snapshot,unit_price_minor,quantity,line_total_minor,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        randomUUID(),
        orderId,
        menuItemId,
        name,
        unitPrice,
        quantity,
        total,
        orderCreated,
        orderCreated,
      );
    database.sqlite
      .prepare(
        "INSERT INTO payments (id,order_id,method,amount_due_minor,cash_tendered_minor,change_minor,processed_by_user_id,created_at) VALUES (?,?,'CASH',?,?,?,?,?)",
      )
      .run(
        paymentId,
        orderId,
        total,
        tendered,
        tendered - total,
        actorId,
        paidMs,
      );
    const receiptNumber = `TEST-${orderNumber}`;
    const snapshot = {
      receiptNumber,
      orderNumber,
      paidAt: new Date(paidMs).toISOString(),
      items: [
        {
          name,
          unitPriceMinor: unitPrice,
          quantity,
          lineTotalMinor: total,
          notes: null,
        },
      ],
      subtotalMinor: total,
      totalMinor: total,
      cashTenderedMinor: tendered,
      changeMinor: tendered - total,
      paymentMethod: 'CASH',
    };
    database.sqlite
      .prepare(
        'INSERT INTO receipts (id,receipt_number,order_id,payment_id,snapshot_json,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(
        receiptId,
        receiptNumber,
        orderId,
        paymentId,
        JSON.stringify(snapshot),
        paidMs,
      );
    return receiptId;
  }
});
