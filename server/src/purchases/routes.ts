import { Router, type RequestHandler } from 'express';
import { DateTime } from 'luxon';
import { z, ZodError } from 'zod';
import type { AppDatabase } from '../db/database.js';
import { DEFAULT_REPORT_TIMEZONE } from '../reports/service.js';
import { PurchaseError, PurchaseService } from './service.js';

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      DateTime.fromISO(value, { zone: DEFAULT_REPORT_TIMEZONE }).toISODate() ===
      value,
    'Purchase date must be a valid Cairo calendar date.',
  );
const month = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .refine(
    (value) =>
      DateTime.fromFormat(value, 'yyyy-LL', {
        zone: DEFAULT_REPORT_TIMEZONE,
      }).isValid,
    'Month must use YYYY-MM.',
  );
const quantityMilli = z
  .union([z.string(), z.number()])
  .transform((value, context) => {
    const raw = typeof value === 'string' ? value.trim() : String(value);
    const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(raw);
    if (!match) {
      context.addIssue({
        code: 'custom',
        message: 'Quantity must be a positive decimal with at most 3 places.',
      });
      return z.NEVER;
    }
    const scaled =
      Number(match[1]) * 1_000 + Number((match[2] ?? '').padEnd(3, '0'));
    if (!Number.isSafeInteger(scaled) || scaled < 1 || scaled > 10_000_000) {
      context.addIssue({
        code: 'custom',
        message: 'Quantity is outside the supported range.',
      });
      return z.NEVER;
    }
    return scaled;
  });
const purchaseInput = z.strictObject({
  name: z.string().trim().min(1).max(160),
  quantity: quantityMilli,
  unit: z.string().trim().max(30).nullable().optional(),
  unitPriceMinor: z.number().int().min(0).max(100_000_000),
  purchaseDate: date,
});
const query = z
  .object({
    search: z.string().trim().max(160).default(''),
    day: date.optional(),
    month: month.optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((value) => !(value.day && value.month), {
    message: 'Use either a day or a month filter, not both.',
  });

export function createPurchaseRouter(
  database: AppDatabase,
  middleware: {
    authenticate: RequestHandler;
    requireAdmin: RequestHandler;
    csrf: RequestHandler;
  },
) {
  const router = Router();
  const purchases = new PurchaseService(database);
  router.use(
    '/admin/purchases',
    middleware.authenticate,
    middleware.requireAdmin,
  );
  router.get('/admin/purchases', (request, response) => {
    const input = parse(query, request.query);
    response.json(purchases.list(input));
  });
  router.get('/admin/purchases/summary', (request, response) => {
    const input = parse(query, request.query);
    response.json(purchases.summary(input));
  });
  router.post('/admin/purchases', middleware.csrf, (request, response) => {
    const input = parse(purchaseInput, request.body);
    response.status(201).json({
      purchase: purchases.create(
        { ...input, quantityMilli: input.quantity },
        response.locals.user.id,
      ),
    });
  });
  router.patch('/admin/purchases/:id', middleware.csrf, (request, response) => {
    const input = parse(purchaseInput, request.body);
    response.json({
      purchase: purchases.update(
        String(request.params.id),
        { ...input, quantityMilli: input.quantity },
        response.locals.user.id,
      ),
    });
  });
  router.delete(
    '/admin/purchases/:id',
    middleware.csrf,
    (request, response) => {
      purchases.remove(String(request.params.id), response.locals.user.id);
      response.status(204).end();
    },
  );
  return router;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError)
      throw new PurchaseError(
        400,
        'VALIDATION_ERROR',
        'تعذر التحقق من بيانات المشتريات.',
        error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    throw error;
  }
}
