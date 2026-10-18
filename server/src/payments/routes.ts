import { Router, type RequestHandler } from 'express';
import { z, ZodError } from 'zod';
import type { AppDatabase } from '../db/database.js';
import { OrderError } from '../orders/service.js';
import { PaymentService } from './service.js';

const checkout = z.strictObject({
  cashTenderedMinor: z.number().int().positive().max(1_000_000_000),
  expectedVersion: z.number().int().positive(),
});
const printAttempt = z.strictObject({
  outcome: z.enum(['DIALOG_OPENED', 'ERROR']),
  errorMessage: z.string().trim().max(500).nullable().optional(),
});

export function createPaymentRouter(
  database: AppDatabase,
  middleware: { authenticate: RequestHandler; csrf: RequestHandler },
) {
  const router = Router();
  const service = new PaymentService(database);
  router.post(
    '/orders/:id/checkout',
    middleware.csrf,
    middleware.authenticate,
    (request, response) => {
      response.json({
        receipt: service.checkout(
          String(request.params.id),
          response.locals.user.id,
          idempotencyKey(request.get('Idempotency-Key')),
          parse(checkout, request.body),
        ),
      });
    },
  );
  router.get('/receipts/:id', middleware.authenticate, (request, response) =>
    response.json({ receipt: service.get(String(request.params.id)) }),
  );
  router.post(
    '/receipts/:id/print-attempts',
    middleware.csrf,
    middleware.authenticate,
    (request, response) => {
      response.status(201).json({
        receipt: service.recordPrint(
          String(request.params.id),
          response.locals.user.id,
          parse(printAttempt, request.body),
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
