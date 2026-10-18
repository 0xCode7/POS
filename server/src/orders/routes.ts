import { Router, type RequestHandler } from 'express';
import { z, ZodError } from 'zod';
import type { AppDatabase } from '../db/database.js';
import { OrderError, OrderService } from './service.js';

const version = z.number().int().positive();
const notes = z.string().trim().max(500).nullable().optional();
const itemInput = z.strictObject({
  menuItemId: z.uuid(),
  quantity: z.number().int().min(1).max(99),
  notes,
  expectedVersion: version,
});
const updateInput = z.strictObject({
  quantity: z.number().int().min(1).max(99),
  notes,
  expectedVersion: version,
});
const cancelInput = z.strictObject({
  reason: z.string().trim().min(3).max(500),
  expectedVersion: version,
});
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['OPEN', 'CANCELLED', 'PAID']).optional(),
});
const adminListQuery = listQuery.extend({
  search: z.string().trim().max(50).optional(),
});

export function createOrderRouter(
  database: AppDatabase,
  middleware: {
    authenticate: RequestHandler;
    requireAdmin: RequestHandler;
    csrf: RequestHandler;
  },
) {
  const router = Router();
  const orders = new OrderService(database);
  router.get('/orders', middleware.authenticate, (request, response) => {
    const query = parse(listQuery, request.query);
    response.json(orders.list(query.page, query.limit, query.status));
  });
  router.get(
    '/admin/orders',
    middleware.authenticate,
    middleware.requireAdmin,
    (request, response) => {
      const query = parse(adminListQuery, request.query);
      response.json(
        orders.adminList(query.page, query.limit, query.status, query.search),
      );
    },
  );
  router.get(
    '/admin/orders/:id',
    middleware.authenticate,
    middleware.requireAdmin,
    (request, response) =>
      response.json({ order: orders.adminGet(String(request.params.id)) }),
  );
  router.post(
    '/orders',
    middleware.csrf,
    middleware.authenticate,
    (request, response) =>
      response.status(201).json({
        order: orders.create(
          response.locals.user.id,
          idempotencyKey(request.get('Idempotency-Key')),
        ),
      }),
  );
  router.get('/orders/:id', middleware.authenticate, (request, response) =>
    response.json({ order: orders.get(String(request.params.id)) }),
  );
  router.post(
    '/orders/:id/items',
    middleware.csrf,
    middleware.authenticate,
    (request, response) =>
      response.status(201).json({
        order: orders.addItem(
          String(request.params.id),
          response.locals.user.id,
          idempotencyKey(request.get('Idempotency-Key')),
          parse(itemInput, request.body),
        ),
      }),
  );
  router.patch(
    '/orders/:id/items/:itemId',
    middleware.csrf,
    middleware.authenticate,
    (request, response) =>
      response.json({
        order: orders.updateItem(
          String(request.params.id),
          String(request.params.itemId),
          response.locals.user.id,
          parse(updateInput, request.body),
        ),
      }),
  );
  router.delete(
    '/orders/:id',
    middleware.csrf,
    middleware.authenticate,
    (request, response) => {
      const input = parse(
        z.object({ expectedVersion: z.coerce.number().int().positive() }),
        request.query,
      );
      orders.discardEmpty(String(request.params.id), input.expectedVersion);
      response.json({ discarded: true });
    },
  );
  router.delete(
    '/orders/:id/items/:itemId',
    middleware.csrf,
    middleware.authenticate,
    (request, response) =>
      response.json({
        order: orders.removeItem(
          String(request.params.id),
          String(request.params.itemId),
          response.locals.user.id,
          parse(
            z.object({ expectedVersion: z.coerce.number().int().positive() }),
            request.query,
          ).expectedVersion,
        ),
      }),
  );
  router.post(
    '/orders/:id/cancel',
    middleware.csrf,
    middleware.authenticate,
    middleware.requireAdmin,
    (request, response) => {
      const input = parse(cancelInput, request.body);
      response.json({
        order: orders.cancel(
          String(request.params.id),
          response.locals.user.id,
          input.reason,
          input.expectedVersion,
        ),
      });
    },
  );
  return router;
}
function idempotencyKey(value: string | undefined) {
  const result = z.string().min(8).max(100).safeParse(value);
  if (!result.success)
    throw new OrderError(
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
      'A valid Idempotency-Key header is required.',
    );
  return result.data;
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError)
      throw new OrderError(
        400,
        'VALIDATION_ERROR',
        'Request validation failed.',
        error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    throw error;
  }
}
