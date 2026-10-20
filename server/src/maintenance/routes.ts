import { Router, type RequestHandler } from 'express';
import { randomBytes } from 'node:crypto';
import { z, ZodError } from 'zod';
import { OrderError } from '../orders/service.js';
import type { BackupService } from './backup.js';
import { SupervisorClient } from './supervisor-client.js';

export function createMaintenanceRouter(
  backups: BackupService,
  middleware: {
    authenticate: RequestHandler;
    requireAdmin: RequestHandler;
    csrf: RequestHandler;
  },
) {
  const router = Router();
  const supervisor = new SupervisorClient();
  router.use(
    '/admin/backups',
    middleware.authenticate,
    middleware.requireAdmin,
  );
  router.get('/admin/backups', (_request, response) =>
    response.json({ backups: backups.status() }),
  );
  router.get('/admin/backups/history', (request, response) => {
    const query = parse(
      z.object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        search: z.string().trim().max(100).optional(),
      }),
      request.query,
    );
    response.json(backups.paginatedHistory(query));
  });
  router.get('/admin/backups/restore-status', async (_request, response) => {
    if (!supervisor.available)
      return response.json({
        ready: false,
        operation: { status: 'IDLE', message: 'مشرف التشغيل غير قيد التشغيل.' },
      });
    try {
      response.json(await supervisor.request('status'));
    } catch {
      response.json({
        ready: false,
        operation: { status: 'IDLE', message: 'مشرف التشغيل غير متاح.' },
      });
    }
  });
  router.post(
    '/admin/backups/:filename/restore-preflight',
    middleware.csrf,
    async (request, response) => {
      try {
        const input = parse(
          z.strictObject({
            password: z.string().min(5).max(128),
            confirmation: z.string().max(1200),
          }),
          request.body,
        );
        response.json(
          await backups.prepareRestore({
            filename: String(request.params.filename),
            actorId: response.locals.user.id,
            ...input,
          }),
        );
      } catch (error) {
        throw new OrderError(
          400,
          'RESTORE_PREFLIGHT_FAILED',
          error instanceof Error ? error.message : 'فشل فحص جاهزية الاستعادة.',
        );
      }
    },
  );
  router.post(
    '/admin/backups/:filename/restore-request',
    middleware.csrf,
    async (request, response) => {
      try {
        if (!supervisor.available)
          throw new Error(
            'الاستعادة من الواجهة تتطلب تشغيل مشرف التطبيق الموثوق.',
          );
        const input = parse(
          z.strictObject({
            password: z.string().min(5).max(128),
            confirmation: z.string().max(1200),
          }),
          request.body,
        );
        const filename = String(request.params.filename);
        const backup = await backups.authorizeSupervisorRestore({
          filename,
          actorId: response.locals.user.id,
          ...input,
        });
        const result = await supervisor.request('restore', {
          filename,
          actorId: response.locals.user.id,
          token: randomBytes(32).toString('base64url'),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        response.status(202).json({ backup, result });
      } catch (error) {
        throw new OrderError(
          400,
          'RESTORE_REQUEST_FAILED',
          error instanceof Error ? error.message : 'فشل طلب الاستعادة.',
        );
      }
    },
  );
  return router;
}

function parse<T>(schema: z.ZodType<T>, value: unknown) {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError)
      throw new OrderError(
        400,
        'VALIDATION_ERROR',
        error.issues.map((issue) => issue.message).join(' '),
      );
    throw error;
  }
}
