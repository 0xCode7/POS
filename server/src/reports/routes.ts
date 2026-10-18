import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { AppDatabase } from '../db/database.js';
import { OrderError } from '../orders/service.js';
import { parseReportRange, ReportService } from './service.js';

const integer = (fallback: number, maximum: number) =>
  z.preprocess(
    (value) => (value === undefined ? fallback : value),
    z.coerce.number().int().positive().max(maximum),
  );

export function createReportRouter(
  database: AppDatabase,
  middleware: { authenticate: RequestHandler; requireAdmin: RequestHandler },
) {
  const router = Router();
  const service = new ReportService(database);
  router.use(
    '/admin/reports',
    middleware.authenticate,
    middleware.requireAdmin,
  );
  router.get('/admin/reports/summary', (request, response) =>
    response.json(service.summary(parseReportRange(request.query))),
  );
  router.get('/admin/reports/daily', (request, response) =>
    response.json(service.daily(parseReportRange(request.query))),
  );
  router.get('/admin/reports/top-items', (request, response) => {
    const parsed = integer(10, 100).safeParse(request.query.limit);
    if (!parsed.success)
      throw new OrderError(400, 'VALIDATION_ERROR', 'Invalid item limit.');
    const limit = parsed.data;
    response.json(service.topItems(parseReportRange(request.query), limit));
  });
  router.get('/admin/reports/by-cashier', (request, response) =>
    response.json(service.byCashier(parseReportRange(request.query))),
  );
  router.get('/admin/reports/hourly', (request, response) =>
    response.json(service.hourly(parseReportRange(request.query))),
  );
  router.get('/admin/reports/receipts', (request, response) => {
    const parsed = z
      .object({
        page: integer(1, 100_000),
        limit: integer(20, 100),
        search: z.string().trim().max(100).default(''),
      })
      .safeParse(request.query);
    if (!parsed.success)
      throw new OrderError(400, 'VALIDATION_ERROR', 'Invalid receipt filters.');
    response.json(
      service.receipts(parseReportRange(request.query), parsed.data),
    );
  });
  return router;
}
