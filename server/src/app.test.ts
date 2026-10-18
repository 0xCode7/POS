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
  displayName: 'Restaurant Owner',
  password: 'correct horse battery staple',
};

describe('database and authentication API', () => {
  let temporaryDirectory: string;
  let database: AppDatabase;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'restaurant-pos-test-'),
    );
    database = openDatabase({ dataDirectory: temporaryDirectory });
  });

  afterEach(() => {
    database.sqlite.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('runs migrations, enables safety pragmas, and persists across a restart', async () => {
    expect(database.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(database.sqlite.pragma('journal_mode', { simple: true })).toBe(
      'wal',
    );
    expect(database.sqlite.pragma('synchronous', { simple: true })).toBe(2);
    await request(app())
      .post('/api/auth/setup')
      .set(csrf)
      .send(admin)
      .expect(201);

    database.sqlite.close();
    database = openDatabase({ dataDirectory: temporaryDirectory });

    const status = await request(app())
      .get('/api/auth/setup-status')
      .expect(200);
    expect(status.body).toEqual({ needsSetup: false });
    const migrations = database.sqlite
      .prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations')
      .get() as { count: number };
    expect(migrations.count).toBe(5);
  });

  it('allows first-admin setup exactly once under concurrent requests', async () => {
    const application = app();
    const results = await Promise.all([
      request(application).post('/api/auth/setup').set(csrf).send(admin),
      request(application)
        .post('/api/auth/setup')
        .set(csrf)
        .send({ ...admin, username: 'second' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(
      database.sqlite.prepare('SELECT COUNT(*) AS count FROM users').get(),
    ).toEqual({ count: 1 });
  });

  it('uses generic login failures and returns a secure host-only session cookie on success', async () => {
    await setup();
    const missing = await request(app())
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: 'missing', password: admin.password })
      .expect(401);
    const wrong = await request(app())
      .post('/api/auth/login')
      .set(csrf)
      .send({
        username: admin.username,
        password: 'this password is incorrect',
      })
      .expect(401);
    expect(missing.body).toEqual(wrong.body);

    const success = await request(app())
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: admin.username, password: admin.password })
      .expect(200);
    const cookie = success.headers['set-cookie'][0] as string;
    const rawToken = cookie.split(';')[0]!.split('=')[1]!;
    const stored = database.sqlite
      .prepare('SELECT token_hash AS tokenHash FROM sessions')
      .get() as { tokenHash: string };
    expect(cookie).toContain('pos_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toContain('Domain=');
    expect(stored.tokenHash).not.toBe(rawToken);
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(success.body)).not.toContain('passwordHash');
    expect(JSON.stringify(success.body)).not.toContain(rawToken);
  });

  it('rate limits repeated authentication attempts', async () => {
    await setup();
    const application = createApp({ database });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(application)
        .post('/api/auth/login')
        .set(csrf)
        .send({ username: 'missing', password: admin.password })
        .expect(401);
    }
    await request(application)
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: 'missing', password: admin.password })
      .expect(429);
  });

  it('requires authentication and expires and revokes sessions', async () => {
    await setup();
    await request(app()).get('/api/auth/me').expect(401);
    const agent = request.agent(app());
    await agent
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: admin.username, password: admin.password })
      .expect(200);
    await agent.get('/api/auth/me').expect(200);

    database.sqlite.prepare('UPDATE sessions SET expires_at = 0').run();
    await agent.get('/api/auth/me').expect(401);

    await agent
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: admin.username, password: admin.password })
      .expect(200);
    await agent.post('/api/auth/logout').set(csrf).expect(204);
    await agent.get('/api/auth/me').expect(401);
  });

  it('enforces admin role, disables accounts, resets passwords, and omits secrets', async () => {
    await setup();
    const adminAgent = await loggedInAgent(admin.username, admin.password);
    const created = await adminAgent
      .post('/api/admin/users')
      .set(csrf)
      .send({
        username: 'cashier',
        displayName: 'Cashier One',
        password: 'cashier secure password',
        role: 'cashier',
      })
      .expect(201);
    const cashierId = created.body.user.id as string;
    const list = await adminAgent.get('/api/admin/users').expect(200);
    expect(JSON.stringify(list.body)).not.toMatch(
      /password_hash|passwordHash|token_hash|tokenHash/,
    );

    const cashierAgent = await loggedInAgent(
      'cashier',
      'cashier secure password',
    );
    await cashierAgent.get('/api/admin/users').expect(403);
    await cashierAgent.post('/api/admin/users').set(csrf).send({}).expect(403);

    await adminAgent
      .post(`/api/admin/users/${cashierId}/reset-password`)
      .set(csrf)
      .send({ password: 'replacement password secure' })
      .expect(204);
    await cashierAgent.get('/api/auth/me').expect(401);
    await request(app())
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: 'cashier', password: 'cashier secure password' })
      .expect(401);
    await request(app())
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: 'cashier', password: 'replacement password secure' })
      .expect(200);

    await adminAgent
      .patch(`/api/admin/users/${cashierId}/status`)
      .set(csrf)
      .send({ active: false })
      .expect(204);
    await request(app())
      .post('/api/auth/login')
      .set(csrf)
      .send({ username: 'cashier', password: 'replacement password secure' })
      .expect(401);
  });

  it('prevents deactivating the last active admin', async () => {
    await setup();
    const agent = await loggedInAgent(admin.username, admin.password);
    const me = await agent.get('/api/auth/me').expect(200);
    await agent
      .patch(`/api/admin/users/${me.body.user.id}/status`)
      .set(csrf)
      .send({ active: false })
      .expect(409);
  });

  it('rejects missing CSRF proof and cross-origin state changes', async () => {
    await request(app()).post('/api/auth/setup').send(admin).expect(403);
    await request(app())
      .post('/api/auth/setup')
      .set(csrf)
      .set('Origin', 'http://evil.example')
      .send(admin)
      .expect(403);
    await request(app())
      .post('/api/auth/setup')
      .set(csrf)
      .set('Origin', 'http://127.0.0.1')
      .set('Host', '127.0.0.1')
      .send(admin)
      .expect(201);
  });

  it('preserves the health endpoint and keeps API 404s as JSON', async () => {
    const health = await request(app())
      .get('/api/health')
      .expect(200)
      .expect('Content-Type', /json/);
    expect(health.body).toMatchObject({
      status: 'ok',
      service: 'restaurant-pos-server',
    });
    await request(app())
      .get('/api/missing')
      .expect(404)
      .expect({ error: 'API route not found' });
  });

  it('serves the production SPA without intercepting API routes', async () => {
    const clientDirectory = path.join(temporaryDirectory, 'client');
    fs.mkdirSync(clientDirectory);
    fs.writeFileSync(
      path.join(clientDirectory, 'index.html'),
      '<!doctype html><title>POS fixture</title>',
    );
    const application = createApp({
      database,
      serveClient: true,
      clientDirectory,
      disableRateLimit: true,
    });
    await request(application)
      .get('/future-route')
      .expect(200)
      .expect(/POS fixture/);
    await request(application)
      .get('/api/nope')
      .expect(404)
      .expect('Content-Type', /json/);
  });

  function app() {
    return createApp({ database, disableRateLimit: true });
  }
  async function setup() {
    await request(app())
      .post('/api/auth/setup')
      .set(csrf)
      .send(admin)
      .expect(201);
  }
  async function loggedInAgent(username: string, password: string) {
    const agent = request.agent(app());
    await agent
      .post('/api/auth/login')
      .set(csrf)
      .send({ username, password })
      .expect(200);
    return agent;
  }
});
