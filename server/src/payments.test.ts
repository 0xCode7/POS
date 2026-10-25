import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { AppDatabase } from './db/database.js';
import { openDatabase } from './db/database.js';

const csrf = { 'X-CSRF-Protection': '1' };
const admin = {
  username: 'owner',
  displayName: 'Owner',
  password: 'correct horse battery staple',
};

describe('cash checkout and receipts', () => {
  let directory: string;
  let database: AppDatabase;
  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'restaurant-payments-test-'),
    );
    database = openDatabase({ dataDirectory: directory });
  });
  afterEach(() => {
    database.sqlite.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('settles exact cash atomically and creates one unique receipt', async () => {
    const { cashier, order } = await fixture();
    const receipt = await pay(cashier, order, 5000, 'checkout-exact');
    expect(receipt.snapshot).toMatchObject({
      orderNumber: order.orderNumber,
      totalMinor: 5000,
      cashTenderedMinor: 5000,
      changeMinor: 0,
      paymentMethod: 'CASH',
    });
    expect(receipt.receiptNumber).toBe('RCP-000001');
    expect(
      database.sqlite
        .prepare('SELECT status, version FROM orders WHERE id = ?')
        .get(order.id),
    ).toEqual({ status: 'PAID', version: order.version + 1 });
    expect(
      database.sqlite.prepare('SELECT COUNT(*) count FROM payments').get(),
    ).toEqual({ count: 1 });
    expect(
      database.sqlite.prepare('SELECT COUNT(*) count FROM receipts').get(),
    ).toEqual({ count: 1 });
  });

  it('upgrades a populated Stage 4 database without changing its order', async () => {
    database.sqlite.close();
    fs.unlinkSync(path.join(directory, 'restaurant-pos.sqlite'));
    const migrations = path.join(directory, 'stage4-migrations');
    fs.mkdirSync(path.join(migrations, 'meta'), { recursive: true });
    const source = path.resolve('drizzle');
    for (const name of ['0000_auth.sql', '0001_menu.sql', '0002_orders.sql'])
      fs.copyFileSync(path.join(source, name), path.join(migrations, name));
    const journal = JSON.parse(
      fs.readFileSync(path.join(source, 'meta', '_journal.json'), 'utf8'),
    ) as { version: string; dialect: string; entries: unknown[] };
    fs.writeFileSync(
      path.join(migrations, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 3) }),
    );
    database = openDatabase({
      dataDirectory: directory,
      migrationsFolder: migrations,
    });
    await request(app())
      .post('/api/auth/setup')
      .set(csrf)
      .send(admin)
      .expect(201);
    const adminAgent = await login(admin.username, admin.password);
    const category = await adminAgent
      .post('/api/admin/menu/categories')
      .set(csrf)
      .send({ name: 'قديم', sortOrder: 0, isActive: true })
      .expect(201);
    const menu = await adminAgent
      .post('/api/admin/menu/items')
      .set(csrf)
      .send({
        categoryId: category.body.category.id,
        name: 'صنف قديم',
        priceMinor: 5000,
        sortOrder: 0,
        isAvailable: true,
      })
      .expect(201);
    const user = database.sqlite
      .prepare('SELECT id FROM users WHERE username = ?')
      .get(admin.username) as { id: string };
    const order = { id: randomUUID(), orderNumber: 'ORD-000001' };
    const itemId = randomUUID();
    const now = Date.now();
    database.sqlite
      .prepare(
        "INSERT INTO orders (id,order_number,status,created_by_user_id,subtotal_minor,total_minor,version,created_at,updated_at) VALUES (?,?, 'OPEN', ?,5000,5000,2,?,?)",
      )
      .run(order.id, order.orderNumber, user.id, now, now);
    database.sqlite
      .prepare(
        'INSERT INTO order_items (id,order_id,menu_item_id,item_name_snapshot,unit_price_minor,quantity,line_total_minor,created_at,updated_at) VALUES (?,?,?,?,5000,1,5000,?,?)',
      )
      .run(itemId, order.id, menu.body.item.id, 'صنف قديم', now, now);
    database.sqlite.close();

    database = openDatabase({ dataDirectory: directory });
    expect(
      database.sqlite
        .prepare('SELECT status, total_minor AS total FROM orders WHERE id = ?')
        .get(order.id),
    ).toEqual({ status: 'OPEN', total: 5000 });
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) count FROM order_items WHERE order_id = ?')
        .get(order.id),
    ).toEqual({ count: 1 });
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) count FROM __drizzle_migrations')
        .get(),
    ).toEqual({ count: 6 });
  });

  it('computes change and rejects underpayment or empty checkout without partial records', async () => {
    const { cashier, order } = await fixture();
    const over = await pay(cashier, order, 8000, 'checkout-over');
    expect(over.snapshot.changeMinor).toBe(3000);
    const empty = await createOrder(cashier, 'empty-order');
    await cashier
      .post(`/api/orders/${empty.id}/checkout`)
      .set(csrf)
      .set('Idempotency-Key', 'empty-checkout')
      .send({ cashTenderedMinor: 1000, expectedVersion: empty.version })
      .expect(409);
    const second = await createOrder(cashier, 'under-order');
    const menuId = database.sqlite
      .prepare('SELECT id FROM menu_items LIMIT 1')
      .get() as { id: string };
    const withItem = await addItem(cashier, second, menuId.id, 'under-add');
    await cashier
      .post(`/api/orders/${second.id}/checkout`)
      .set(csrf)
      .set('Idempotency-Key', 'under-checkout')
      .send({ cashTenderedMinor: 4999, expectedVersion: withItem.version })
      .expect(400);
    expect(
      database.sqlite.prepare('SELECT COUNT(*) count FROM payments').get(),
    ).toEqual({ count: 1 });
    expect(
      database.sqlite
        .prepare('SELECT status FROM orders WHERE id = ?')
        .get(second.id),
    ).toEqual({ status: 'OPEN' });
  });

  it('makes retries idempotent and rejects a changed payload for the same key', async () => {
    const { cashier, order } = await fixture();
    const first = await pay(cashier, order, 6000, 'retry-checkout');
    const retry = await cashier
      .post(`/api/orders/${order.id}/checkout`)
      .set(csrf)
      .set('Idempotency-Key', 'retry-checkout')
      .send({ cashTenderedMinor: 6000, expectedVersion: order.version })
      .expect(200);
    expect(retry.body.receipt.id).toBe(first.id);
    await cashier
      .post(`/api/orders/${order.id}/checkout`)
      .set(csrf)
      .set('Idempotency-Key', 'retry-checkout')
      .send({ cashTenderedMinor: 7000, expectedVersion: order.version })
      .expect(409);
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) count FROM payments WHERE order_id = ?')
        .get(order.id),
    ).toEqual({ count: 1 });
  });

  it('allows only one concurrent settlement and rejects stale versions', async () => {
    const { cashier, order } = await fixture();
    const responses = await Promise.all([
      cashier
        .post(`/api/orders/${order.id}/checkout`)
        .set(csrf)
        .set('Idempotency-Key', 'concurrent-one')
        .send({ cashTenderedMinor: 5000, expectedVersion: order.version }),
      cashier
        .post(`/api/orders/${order.id}/checkout`)
        .set(csrf)
        .set('Idempotency-Key', 'concurrent-two')
        .send({ cashTenderedMinor: 5000, expectedVersion: order.version }),
    ]);
    expect(responses.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) count FROM payments WHERE order_id = ?')
        .get(order.id),
    ).toEqual({ count: 1 });
  });

  it('makes paid orders immutable and persists settlement after restart', async () => {
    const { adminAgent, cashier, order } = await fixture();
    const receipt = await pay(cashier, order, 5000, 'persist-checkout');
    await cashier
      .patch(`/api/orders/${order.id}/items/${order.items[0].id}`)
      .set(csrf)
      .send({ quantity: 3, expectedVersion: order.version + 1 })
      .expect(409);
    await adminAgent
      .post(`/api/orders/${order.id}/cancel`)
      .set(csrf)
      .send({ reason: 'لا يمكن', expectedVersion: order.version + 1 })
      .expect(409);
    database.sqlite.close();
    database = openDatabase({ dataDirectory: directory });
    const relogged = await login('cashier', 'cashier secure password');
    const stored = await relogged
      .get(`/api/receipts/${receipt.id}`)
      .expect(200);
    expect(stored.body.receipt.snapshot.totalMinor).toBe(5000);
  });

  it('uses edited menu details only for new sales and preserves paid receipts and reports', async () => {
    const { adminAgent, cashier, order, menuItemId } = await fixture();
    const originalReceipt = await pay(cashier, order, 5000, 'paid-before-edit');

    await adminAgent
      .patch(`/api/admin/menu/items/${menuItemId}`)
      .set(csrf)
      .send({ name: 'شاي فاخر', priceMinor: 6_000 })
      .expect(200);

    const nextEmptyOrder = await createOrder(cashier, 'order-after-menu-edit');
    const nextOrder = await addItem(
      cashier,
      nextEmptyOrder,
      menuItemId,
      'add-after-menu-edit',
      1,
    );
    expect(nextOrder.items[0]).toMatchObject({
      itemNameSnapshot: 'شاي فاخر',
      unitPriceMinor: 6_000,
      lineTotalMinor: 6_000,
    });
    const newReceipt = await pay(cashier, nextOrder, 6000, 'paid-after-edit');

    const historical = await cashier
      .get(`/api/receipts/${originalReceipt.id}`)
      .expect(200);
    expect(historical.body.receipt.snapshot).toMatchObject({
      totalMinor: 5_000,
      items: [
        {
          name: 'شاي',
          unitPriceMinor: 2_500,
          quantity: 2,
          lineTotalMinor: 5_000,
        },
      ],
    });
    expect(newReceipt.snapshot).toMatchObject({
      totalMinor: 6_000,
      items: [
        {
          name: 'شاي فاخر',
          unitPriceMinor: 6_000,
          quantity: 1,
          lineTotalMinor: 6_000,
        },
      ],
    });
    const reportDay = DateTime.now().setZone('Africa/Cairo').startOf('day');
    const reportQuery = `start=${reportDay.toISODate()}&end=${reportDay.plus({ days: 1 }).toISODate()}&timezone=Africa%2FCairo`;
    const summary = await adminAgent
      .get(`/api/admin/reports/summary?${reportQuery}`)
      .expect(200);
    expect(summary.body).toMatchObject({
      revenueMinor: 11_000,
      paidOrders: 2,
      cashReceivedMinor: 11_000,
      changeMinor: 0,
    });
    const topItems = await adminAgent
      .get(`/api/admin/reports/top-items?${reportQuery}`)
      .expect(200);
    expect(topItems.body.items).toEqual([
      { name: 'شاي', quantity: 2, revenueMinor: 5_000 },
      { name: 'شاي فاخر', quantity: 1, revenueMinor: 6_000 },
    ]);
  });

  it('records print dialog/error attempts without changing financial records', async () => {
    const { cashier, order } = await fixture();
    const receipt = await pay(cashier, order, 5000, 'print-checkout');
    await cashier
      .post(`/api/receipts/${receipt.id}/print-attempts`)
      .set(csrf)
      .send({ outcome: 'ERROR', errorMessage: 'Browser print unavailable' })
      .expect(201);
    await cashier
      .post(`/api/receipts/${receipt.id}/print-attempts`)
      .set(csrf)
      .send({ outcome: 'DIALOG_OPENED' })
      .expect(201);
    const result = await cashier.get(`/api/receipts/${receipt.id}`).expect(200);
    expect(result.body.receipt.printAttempts).toHaveLength(2);
    expect(
      database.sqlite.prepare('SELECT COUNT(*) count FROM payments').get(),
    ).toEqual({ count: 1 });
    expect(
      database.sqlite.prepare('SELECT COUNT(*) count FROM receipts').get(),
    ).toEqual({ count: 1 });
  });

  it('enforces authentication, CSRF, origins, and checkout validation', async () => {
    const { cashier, order } = await fixture();
    await request(app()).get('/api/receipts/anything').expect(401);
    await cashier
      .post(`/api/orders/${order.id}/checkout`)
      .set('Idempotency-Key', 'missing-csrf')
      .send({ cashTenderedMinor: 5000, expectedVersion: order.version })
      .expect(403);
    await cashier
      .post(`/api/orders/${order.id}/checkout`)
      .set(csrf)
      .set('Origin', 'http://evil.example')
      .set('Idempotency-Key', 'evil-origin')
      .send({ cashTenderedMinor: 5000, expectedVersion: order.version })
      .expect(403);
    await cashier
      .post(`/api/orders/${order.id}/checkout`)
      .set(csrf)
      .set('Idempotency-Key', 'bad-tender')
      .send({ cashTenderedMinor: 0, expectedVersion: order.version })
      .expect(400);
  });

  function app() {
    return createApp({ database, disableRateLimit: true });
  }
  async function fixture() {
    await request(app())
      .post('/api/auth/setup')
      .set(csrf)
      .send(admin)
      .expect(201);
    const adminAgent = await login(admin.username, admin.password);
    await adminAgent
      .post('/api/admin/users')
      .set(csrf)
      .send({
        username: 'cashier',
        displayName: 'Cashier',
        password: 'cashier secure password',
        role: 'cashier',
      })
      .expect(201);
    const category = await adminAgent
      .post('/api/admin/menu/categories')
      .set(csrf)
      .send({ name: 'مشروبات', sortOrder: 0, isActive: true })
      .expect(201);
    const menu = await adminAgent
      .post('/api/admin/menu/items')
      .set(csrf)
      .send({
        categoryId: category.body.category.id,
        name: 'شاي',
        priceMinor: 2500,
        sortOrder: 0,
        isAvailable: true,
      })
      .expect(201);
    const cashier = await login('cashier', 'cashier secure password');
    const empty = await createOrder(cashier, 'fixture-order');
    const order = await addItem(
      cashier,
      empty,
      menu.body.item.id,
      'fixture-add',
      2,
    );
    return {
      adminAgent,
      cashier,
      order,
      menuItemId: menu.body.item.id as string,
    };
  }
  async function login(username: string, password: string) {
    const agent = request.agent(app());
    await agent
      .post('/api/auth/login')
      .set(csrf)
      .send({ username, password })
      .expect(200);
    return agent;
  }
});

async function createOrder(
  agent: ReturnType<typeof request.agent>,
  key: string,
) {
  const result = await agent
    .post('/api/orders')
    .set(csrf)
    .set('Idempotency-Key', key)
    .expect(201);
  return result.body.order;
}
async function addItem(
  agent: ReturnType<typeof request.agent>,
  order: { id: string; version: number },
  menuItemId: string,
  key: string,
  quantity = 2,
) {
  const result = await agent
    .post(`/api/orders/${order.id}/items`)
    .set(csrf)
    .set('Idempotency-Key', key)
    .send({ menuItemId, quantity, expectedVersion: order.version })
    .expect(201);
  return result.body.order;
}
async function pay(
  agent: ReturnType<typeof request.agent>,
  order: { id: string; version: number },
  cashTenderedMinor: number,
  key: string,
) {
  const result = await agent
    .post(`/api/orders/${order.id}/checkout`)
    .set(csrf)
    .set('Idempotency-Key', key)
    .send({ cashTenderedMinor, expectedVersion: order.version })
    .expect(200);
  return result.body.receipt;
}
