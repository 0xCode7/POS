import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import request, { type Test } from 'supertest';
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

describe('menu migrations and API', () => {
  let temporaryDirectory: string;
  let database: AppDatabase;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'restaurant-menu-test-'),
    );
    database = openDatabase({ dataDirectory: temporaryDirectory });
  });
  afterEach(() => {
    database.sqlite.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('adds menu tables to an existing Stage 2 database without changing existing data', async () => {
    database.sqlite.close();
    fs.unlinkSync(path.join(temporaryDirectory, 'restaurant-pos.sqlite'));
    const stage2Migrations = path.join(temporaryDirectory, 'stage2-migrations');
    fs.mkdirSync(path.join(stage2Migrations, 'meta'), { recursive: true });
    const source = path.resolve('drizzle');
    fs.copyFileSync(
      path.join(source, '0000_auth.sql'),
      path.join(stage2Migrations, '0000_auth.sql'),
    );
    fs.writeFileSync(
      path.join(stage2Migrations, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [
          {
            idx: 0,
            version: '6',
            when: 1792279800000,
            tag: '0000_auth',
            breakpoints: true,
          },
        ],
      }),
    );
    database = openDatabase({
      dataDirectory: temporaryDirectory,
      migrationsFolder: stage2Migrations,
    });
    await request(app())
      .post('/api/auth/setup')
      .set(csrf)
      .send(admin)
      .expect(201);
    database.sqlite.close();

    database = openDatabase({ dataDirectory: temporaryDirectory });
    expect(database.sqlite.prepare('SELECT username FROM users').get()).toEqual(
      { username: 'owner' },
    );
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('menu_categories','menu_items')",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('orders','order_items','order_events','idempotency_records','order_number_sequence')",
        )
        .get(),
    ).toEqual({ count: 5 });
    expect(
      database.sqlite
        .prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations')
        .get(),
    ).toEqual({ count: 6 });
  });

  it('requires authentication and admin permission for writes', async () => {
    await request(app()).get('/api/menu/categories').expect(401);
    const { adminAgent, cashierAgent } = await actors();
    await cashierAgent.get('/api/menu/categories').expect(200);
    await cashierAgent
      .post('/api/admin/menu/categories')
      .set(csrf)
      .send(category('Drinks'))
      .expect(403);
    await adminAgent
      .post('/api/admin/menu/categories')
      .send(category('Drinks'))
      .expect(403);
    await adminAgent
      .post('/api/admin/menu/categories')
      .set(csrf)
      .set('Origin', 'http://evil.example')
      .send(category('Drinks'))
      .expect(403);
  });

  it('creates and updates normalized categories and rejects duplicates', async () => {
    const { adminAgent } = await actors();
    const created = await createCategory(adminAgent, '  Hot   Drinks  ');
    expect(created.name).toBe('Hot Drinks');
    await adminAgent
      .post('/api/admin/menu/categories')
      .set(csrf)
      .send(category('hot drinks'))
      .expect(409);
    const updated = await adminAgent
      .patch(`/api/admin/menu/categories/${created.id}`)
      .set(csrf)
      .send({ name: 'Coffee', isActive: false, sortOrder: 3 })
      .expect(200);
    expect(updated.body.category).toMatchObject({
      name: 'Coffee',
      isActive: false,
      sortOrder: 3,
    });
    await adminAgent
      .patch(`/api/admin/menu/categories/${randomUUID()}`)
      .set(csrf)
      .send({ name: 'Missing' })
      .expect(404);
  });

  it('validates item input, category existence, prices, and duplicate names', async () => {
    const { adminAgent } = await actors();
    const categoryRow = await createCategory(adminAgent, 'Sandwiches');
    await createMenuItem(adminAgent, categoryRow.id, {
      name: '  Chicken   Shawarma ',
      priceMinor: 12_500,
    });
    await itemRequest(adminAgent, categoryRow.id, {
      name: 'chicken shawarma',
      priceMinor: 13_000,
    }).expect(409);
    await itemRequest(adminAgent, categoryRow.id, {
      name: 'Free',
      priceMinor: 0,
    }).expect(400);
    await itemRequest(adminAgent, categoryRow.id, {
      name: 'Too much',
      priceMinor: 100_000_001,
    }).expect(400);
    await itemRequest(adminAgent, randomUUID(), {
      name: 'Lost item',
      priceMinor: 100,
    }).expect(404);
    await itemRequest(adminAgent, 'not-a-uuid', {
      name: 'Bad category',
      priceMinor: 100,
    }).expect(400);
  });

  it('filters search, category and pagination and rejects invalid pagination', async () => {
    const { adminAgent } = await actors();
    const drinks = await createCategory(adminAgent, 'مشروبات');
    const meals = await createCategory(adminAgent, 'وجبات');
    await createMenuItem(adminAgent, drinks.id, {
      name: 'قهوة تركي',
      description: 'قهوة ساخنة',
      priceMinor: 4_500,
    });
    await createMenuItem(adminAgent, drinks.id, {
      name: 'شاي',
      priceMinor: 2_500,
    });
    await createMenuItem(adminAgent, meals.id, {
      name: 'وجبة دجاج',
      priceMinor: 18_000,
    });
    const search = await adminAgent
      .get('/api/menu/items?search=%D8%B3%D8%A7%D8%AE%D9%86%D8%A9')
      .expect(200);
    expect(search.body.items).toHaveLength(1);
    const filtered = await adminAgent
      .get(`/api/menu/items?categoryId=${drinks.id}&page=1&limit=1`)
      .expect(200);
    expect(filtered.body.items).toHaveLength(1);
    expect(filtered.body.pagination).toEqual({
      page: 1,
      limit: 1,
      total: 2,
      pages: 2,
    });
    await adminAgent.get('/api/menu/items?page=0').expect(400);
    await adminAgent.get('/api/menu/items?limit=101').expect(400);
    await adminAgent.get('/api/menu/items?categoryId=bad').expect(400);
  });

  it('hides inactive, unavailable, and archived menu data from cashiers while admins can request it', async () => {
    const { adminAgent, cashierAgent } = await actors();
    const active = await createCategory(adminAgent, 'Active');
    const inactive = await createCategory(adminAgent, 'Inactive');
    await adminAgent
      .patch(`/api/admin/menu/categories/${inactive.id}`)
      .set(csrf)
      .send({ isActive: false })
      .expect(200);
    const visible = await createMenuItem(adminAgent, active.id, {
      name: 'Visible',
      priceMinor: 500,
    });
    const unavailable = await createMenuItem(adminAgent, active.id, {
      name: 'Unavailable',
      priceMinor: 600,
    });
    await adminAgent
      .patch(`/api/admin/menu/items/${unavailable.id}/availability`)
      .set(csrf)
      .send({ isAvailable: false })
      .expect(200);
    const archived = await createMenuItem(adminAgent, active.id, {
      name: 'Archived',
      priceMinor: 700,
    });
    await adminAgent
      .patch(`/api/admin/menu/items/${archived.id}/archive`)
      .set(csrf)
      .send({ isArchived: true })
      .expect(200);
    await createMenuItem(adminAgent, inactive.id, {
      name: 'Hidden category item',
      priceMinor: 800,
    });

    const cashierCategories = await cashierAgent
      .get('/api/menu/categories?includeInactive=true')
      .expect(200);
    expect(
      cashierCategories.body.categories.map(
        (row: { name: string }) => row.name,
      ),
    ).toEqual(['Active']);
    const cashierItems = await cashierAgent
      .get('/api/menu/items?includeArchived=true&includeUnavailable=true')
      .expect(200);
    expect(
      cashierItems.body.items.map((row: { id: string }) => row.id),
    ).toEqual([visible.id]);
    const adminItems = await adminAgent
      .get('/api/menu/items?includeArchived=true&includeUnavailable=true')
      .expect(200);
    expect(adminItems.body.items).toHaveLength(4);
    const adminCategories = await adminAgent
      .get('/api/menu/categories?includeInactive=true')
      .expect(200);
    expect(adminCategories.body.categories).toHaveLength(2);
  });

  it('archives rather than deleting and persists menu data after restart', async () => {
    const { adminAgent } = await actors();
    const categoryRow = await createCategory(adminAgent, 'Dessert');
    const item = await createMenuItem(adminAgent, categoryRow.id, {
      name: 'Cake',
      priceMinor: 9_000,
    });
    await adminAgent
      .patch(`/api/admin/menu/items/${item.id}/archive`)
      .set(csrf)
      .send({ isArchived: true })
      .expect(200);
    expect(
      database.sqlite
        .prepare(
          'SELECT is_archived AS archived, is_available AS available FROM menu_items WHERE id = ?',
        )
        .get(item.id),
    ).toEqual({ archived: 1, available: 0 });
    database.sqlite.close();
    database = openDatabase({ dataDirectory: temporaryDirectory });
    expect(
      database.sqlite
        .prepare('SELECT name FROM menu_items WHERE id = ?')
        .get(item.id),
    ).toEqual({ name: 'Cake' });
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
        displayName: 'Cashier',
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

function category(name: string) {
  return { name, sortOrder: 0, isActive: true };
}
async function createCategory(
  agent: ReturnType<typeof request.agent>,
  name: string,
) {
  const response = await agent
    .post('/api/admin/menu/categories')
    .set(csrf)
    .send(category(name))
    .expect(201);
  return response.body.category as { id: string; name: string };
}
function itemRequest(
  agent: ReturnType<typeof request.agent>,
  categoryId: string,
  overrides: { name: string; priceMinor: number; description?: string },
): Test {
  return agent.post('/api/admin/menu/items').set(csrf).send({
    categoryId,
    name: overrides.name,
    description: overrides.description,
    priceMinor: overrides.priceMinor,
    sortOrder: 0,
    isAvailable: true,
  });
}
async function createMenuItem(
  agent: ReturnType<typeof request.agent>,
  categoryId: string,
  overrides: { name: string; priceMinor: number; description?: string },
) {
  const response = await itemRequest(agent, categoryId, overrides).expect(201);
  return response.body.item as { id: string; name: string };
}
