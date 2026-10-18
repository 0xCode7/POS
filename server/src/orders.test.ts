import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

describe('counter orders API', () => {
  let directory: string;
  let database: AppDatabase;
  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'restaurant-orders-test-'),
    );
    database = openDatabase({ dataDirectory: directory });
  });
  afterEach(() => {
    database.sqlite.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('creates idempotent orders with persistent unique numbers across restart', async () => {
    const { cashierAgent } = await fixture();
    const first = await createOrder(cashierAgent, 'create-key-0001');
    const retry = await cashierAgent
      .post('/api/orders')
      .set(csrf)
      .set('Idempotency-Key', 'create-key-0001')
      .expect(201);
    expect(retry.body.order.id).toBe(first.id);
    expect(first.orderNumber).toBe('ORD-000001');
    database.sqlite.close();
    database = openDatabase({ dataDirectory: directory });
    const nextAgent = await login('cashier', 'cashier secure password');
    const second = await createOrder(nextAgent, 'create-key-0002');
    expect(second.orderNumber).toBe('ORD-000002');
    expect(
      database.sqlite.prepare('SELECT COUNT(*) AS count FROM orders').get(),
    ).toEqual({ count: 2 });
  });

  it('adds, edits, and removes items with backend totals and idempotent retries', async () => {
    const { cashierAgent, menuItemId } = await fixture();
    const order = await createOrder(cashierAgent, 'order-items-01');
    const added = await addItem(
      cashierAgent,
      order.id,
      menuItemId,
      order.version,
      'add-item-key-01',
      2,
      'بدون بصل',
    );
    expect(added).toMatchObject({
      subtotalMinor: 5000,
      totalMinor: 5000,
      version: 2,
    });
    expect(added.items[0]).toMatchObject({
      itemNameSnapshot: 'شاي',
      unitPriceMinor: 2500,
      quantity: 2,
      lineTotalMinor: 5000,
      notes: 'بدون بصل',
    });
    const retry = await addItem(
      cashierAgent,
      order.id,
      menuItemId,
      order.version,
      'add-item-key-01',
      2,
    );
    expect(retry.items).toHaveLength(1);
    const updated = await cashierAgent
      .patch(`/api/orders/${order.id}/items/${added.items[0].id}`)
      .set(csrf)
      .send({ quantity: 3, notes: 'سكر قليل', expectedVersion: added.version })
      .expect(200);
    expect(updated.body.order.totalMinor).toBe(7500);
    const removed = await cashierAgent
      .delete(
        `/api/orders/${order.id}/items/${added.items[0].id}?expectedVersion=${updated.body.order.version}`,
      )
      .set(csrf)
      .expect(200);
    expect(removed.body.order.items).toHaveLength(0);
    expect(removed.body.order.totalMinor).toBe(0);
    expect(
      removed.body.order.events.map(
        (event: { eventType: string }) => event.eventType,
      ),
    ).toEqual(['ORDER_CREATED', 'ITEM_ADDED', 'ITEM_UPDATED', 'ITEM_REMOVED']);
  });

  it('preserves price/name snapshots when the menu changes', async () => {
    const { adminAgent, cashierAgent, menuItemId } = await fixture();
    const order = await createOrder(cashierAgent, 'snapshot-order');
    const added = await addItem(
      cashierAgent,
      order.id,
      menuItemId,
      order.version,
      'snapshot-add',
      1,
    );
    await adminAgent
      .patch(`/api/admin/menu/items/${menuItemId}`)
      .set(csrf)
      .send({ name: 'شاي فاخر', priceMinor: 9999 })
      .expect(200);
    const fetched = await cashierAgent
      .get(`/api/orders/${order.id}`)
      .expect(200);
    expect(fetched.body.order.items[0]).toMatchObject({
      itemNameSnapshot: 'شاي',
      unitPriceMinor: 2500,
      lineTotalMinor: 2500,
    });
    expect(added.totalMinor).toBe(2500);
  });

  it('rejects unavailable items and invalid quantities atomically', async () => {
    const { adminAgent, cashierAgent, menuItemId } = await fixture();
    const order = await createOrder(cashierAgent, 'unavailable-order');
    await adminAgent
      .patch(`/api/admin/menu/items/${menuItemId}/availability`)
      .set(csrf)
      .send({ isAvailable: false })
      .expect(200);
    await cashierAgent
      .post(`/api/orders/${order.id}/items`)
      .set(csrf)
      .set('Idempotency-Key', 'unavailable-add')
      .send({ menuItemId, quantity: 1, expectedVersion: order.version })
      .expect(409);
    await cashierAgent
      .post(`/api/orders/${order.id}/items`)
      .set(csrf)
      .set('Idempotency-Key', 'bad-quantity')
      .send({ menuItemId, quantity: 0, expectedVersion: order.version })
      .expect(400);
    const stored = await cashierAgent
      .get(`/api/orders/${order.id}`)
      .expect(200);
    expect(stored.body.order).toMatchObject({ version: 1, totalMinor: 0 });
    expect(stored.body.order.items).toHaveLength(0);
  });

  it('rejects stale and concurrent edits using order versions', async () => {
    const { cashierAgent, menuItemId } = await fixture();
    const order = await createOrder(cashierAgent, 'conflict-order');
    const added = await addItem(
      cashierAgent,
      order.id,
      menuItemId,
      order.version,
      'conflict-add',
      1,
    );
    const endpoint = `/api/orders/${order.id}/items/${added.items[0].id}`;
    const results = await Promise.all([
      cashierAgent
        .patch(endpoint)
        .set(csrf)
        .send({ quantity: 2, expectedVersion: added.version }),
      cashierAgent
        .patch(endpoint)
        .set(csrf)
        .send({ quantity: 3, expectedVersion: added.version }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    await cashierAgent
      .patch(endpoint)
      .set(csrf)
      .send({ quantity: 4, expectedVersion: added.version })
      .expect(409);
  });

  it('requires admin cancellation, records actor/reason, and freezes cancelled orders', async () => {
    const { adminAgent, cashierAgent, menuItemId } = await fixture();
    const order = await createOrder(cashierAgent, 'cancel-order');
    const added = await addItem(
      cashierAgent,
      order.id,
      menuItemId,
      order.version,
      'cancel-add',
      1,
    );
    await cashierAgent
      .post(`/api/orders/${order.id}/cancel`)
      .set(csrf)
      .send({ reason: 'طلب العميل', expectedVersion: added.version })
      .expect(403);
    await adminAgent
      .post(`/api/orders/${order.id}/cancel`)
      .send({ reason: 'طلب العميل', expectedVersion: added.version })
      .expect(403);
    const cancelled = await adminAgent
      .post(`/api/orders/${order.id}/cancel`)
      .set(csrf)
      .send({ reason: 'طلب العميل', expectedVersion: added.version })
      .expect(200);
    expect(cancelled.body.order).toMatchObject({
      status: 'CANCELLED',
      cancellationReason: 'طلب العميل',
    });
    expect(cancelled.body.order.cancelledByUserId).toBeTruthy();
    expect(cancelled.body.order.cancelledAt).toBeTruthy();
    await cashierAgent
      .patch(`/api/orders/${order.id}/items/${added.items[0].id}`)
      .set(csrf)
      .send({ quantity: 2, expectedVersion: cancelled.body.order.version })
      .expect(409);
    expect(cancelled.body.order.events.at(-1)).toMatchObject({
      eventType: 'ORDER_CANCELLED',
      metadata: { reason: 'طلب العميل' },
    });
  });

  it('discards empty open orders without a cancellation reason or history row', async () => {
    const { cashierAgent, menuItemId } = await fixture();
    const empty = await createOrder(cashierAgent, 'discard-empty');
    await cashierAgent
      .delete(`/api/orders/${empty.id}?expectedVersion=${empty.version}`)
      .set(csrf)
      .expect(200, { discarded: true });
    await cashierAgent.get(`/api/orders/${empty.id}`).expect(404);
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) AS count FROM orders WHERE id = ?')
        .get(empty.id),
    ).toEqual({ count: 0 });

    const filled = await createOrder(cashierAgent, 'discard-filled');
    const withItem = await addItem(
      cashierAgent,
      filled.id,
      menuItemId,
      filled.version,
      'discard-filled-add',
      1,
    );
    await cashierAgent
      .delete(`/api/orders/${filled.id}?expectedVersion=${withItem.version}`)
      .set(csrf)
      .expect(409);
    await cashierAgent
      .delete(`/api/orders/${filled.id}?expectedVersion=${filled.version}`)
      .set(csrf)
      .expect(409);
  });

  it('provides an admin-only filterable order history with cancellation details', async () => {
    const { adminAgent, cashierAgent, menuItemId } = await fixture();
    await createOrder(cashierAgent, 'history-empty-hidden');
    const order = await createOrder(cashierAgent, 'history-cancel');
    const added = await addItem(
      cashierAgent,
      order.id,
      menuItemId,
      order.version,
      'history-cancel-add',
      2,
    );
    await adminAgent
      .post(`/api/orders/${order.id}/cancel`)
      .set(csrf)
      .send({ reason: 'غيّر العميل رأيه', expectedVersion: added.version })
      .expect(200);

    await cashierAgent.get('/api/admin/orders').expect(403);
    const allHistory = await adminAgent.get('/api/admin/orders').expect(200);
    expect(allHistory.body.pagination.total).toBe(1);
    const history = await adminAgent
      .get(`/api/admin/orders?status=CANCELLED&search=${order.orderNumber}`)
      .expect(200);
    expect(history.body.orders).toHaveLength(1);
    expect(history.body.orders[0]).toMatchObject({
      id: order.id,
      cancellationReason: 'غيّر العميل رأيه',
      createdByDisplayName: 'Cashier',
      cancelledByDisplayName: 'Owner',
    });
    const details = await adminAgent
      .get(`/api/admin/orders/${order.id}`)
      .expect(200);
    expect(details.body.order.items[0]).toMatchObject({
      itemNameSnapshot: 'شاي',
      quantity: 2,
    });
  });

  it('validates pagination, idempotency headers, authentication, and origins', async () => {
    const { cashierAgent } = await fixture();
    await request(app()).get('/api/orders').expect(401);
    await cashierAgent.get('/api/orders?page=0').expect(400);
    await cashierAgent.get('/api/orders?limit=101').expect(400);
    await cashierAgent.post('/api/orders').set(csrf).expect(400);
    await cashierAgent
      .post('/api/orders')
      .set(csrf)
      .set('Origin', 'http://evil.example')
      .set('Idempotency-Key', 'origin-key')
      .expect(403);
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
        description: null,
        priceMinor: 2500,
        sortOrder: 0,
        isAvailable: true,
      })
      .expect(201);
    return {
      adminAgent,
      cashierAgent: await login('cashier', 'cashier secure password'),
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
  const response = await agent
    .post('/api/orders')
    .set(csrf)
    .set('Idempotency-Key', key)
    .expect(201);
  return response.body.order;
}
async function addItem(
  agent: ReturnType<typeof request.agent>,
  orderId: string,
  menuItemId: string,
  expectedVersion: number,
  key: string,
  quantity: number,
  notes?: string,
) {
  const response = await agent
    .post(`/api/orders/${orderId}/items`)
    .set(csrf)
    .set('Idempotency-Key', key)
    .send({ menuItemId, quantity, notes, expectedVersion })
    .expect(201);
  return response.body.order;
}
