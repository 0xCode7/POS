import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type AppDatabase } from './db/database.js';
import { parseReportRange, ReportService } from './reports/service.js';

describe('isolated reporting performance smoke', () => {
  let directory: string;
  let database: AppDatabase;

  beforeAll(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'restaurant-performance-'),
    );
    database = openDatabase({ dataDirectory: directory });
    const now = Date.now();
    const userId = randomUUID();
    const categoryId = randomUUID();
    const menuItemId = randomUUID();
    database.sqlite
      .prepare(
        "INSERT INTO users (id,username,display_name,password_hash,role,active,created_at,updated_at) VALUES (?,?,?,?,'admin',1,?,?)",
      )
      .run(userId, 'performance', 'Performance', 'unused', now, now);
    database.sqlite
      .prepare(
        'INSERT INTO menu_categories (id,name,sort_order,is_active,created_at,updated_at) VALUES (?,?,0,1,?,?)',
      )
      .run(categoryId, 'Load', now, now);
    database.sqlite
      .prepare(
        'INSERT INTO menu_items (id,category_id,name,price_minor,is_available,is_archived,sort_order,created_at,updated_at) VALUES (?,?,?,1000,1,0,0,?,?)',
      )
      .run(menuItemId, categoryId, 'Item', now, now);
    const order = database.sqlite.prepare(
      "INSERT INTO orders (id,order_number,status,created_by_user_id,subtotal_minor,total_minor,version,created_at,updated_at) VALUES (?,?,'PAID',?,1000,1000,2,?,?)",
    );
    const item = database.sqlite.prepare(
      'INSERT INTO order_items (id,order_id,menu_item_id,item_name_snapshot,unit_price_minor,quantity,line_total_minor,created_at,updated_at) VALUES (?,?,?,?,1000,1,1000,?,?)',
    );
    const payment = database.sqlite.prepare(
      "INSERT INTO payments (id,order_id,method,amount_due_minor,cash_tendered_minor,change_minor,processed_by_user_id,created_at) VALUES (?,?,'CASH',1000,1000,0,?,?)",
    );
    database.sqlite.transaction(() => {
      for (let index = 0; index < 2_500; index += 1) {
        const orderId = randomUUID();
        const paidAt = Date.UTC(2026, 0, 1 + (index % 90), index % 24);
        order.run(
          orderId,
          `LOAD-${String(index).padStart(6, '0')}`,
          userId,
          paidAt,
          paidAt,
        );
        item.run(
          randomUUID(),
          orderId,
          menuItemId,
          'Item snapshot',
          paidAt,
          paidAt,
        );
        payment.run(randomUUID(), orderId, userId, paidAt);
      }
    })();
  });

  afterAll(() => {
    database.sqlite.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('aggregates 2,500 paid orders within a broad local smoke threshold', () => {
    const reports = new ReportService(database);
    const range = parseReportRange({
      start: '2026-01-01',
      end: '2026-04-02',
      timezone: 'Africa/Cairo',
    });
    const started = performance.now();
    const summary = reports.summary(range);
    reports.daily(range);
    reports.hourly(range);
    reports.topItems(range, 10);
    reports.byCashier(range);
    const elapsedMs = performance.now() - started;
    console.info(
      `REPORT_PERFORMANCE rows=2500 elapsed_ms=${elapsedMs.toFixed(2)}`,
    );
    expect(summary).toMatchObject({
      revenueMinor: 2_500_000,
      paidOrders: 2_500,
    });
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
