import { Router, type RequestHandler } from 'express';
import { z, ZodError } from 'zod';
import type { AppDatabase } from '../db/database.js';
import { MenuError, MenuService } from './service.js';

const name = z.string().trim().min(1).max(100);
const sortOrder = z.number().int().min(0).max(1_000_000).default(0);
const categoryCreate = z.strictObject({
  name,
  sortOrder,
  isActive: z.boolean().default(true),
});
const categoryUpdate = categoryCreate
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    'At least one field is required.',
  );
const itemCreate = z.strictObject({
  categoryId: z.uuid(),
  name,
  description: z.string().trim().max(500).nullable().optional(),
  priceMinor: z.number().int().min(1).max(100_000_000),
  sortOrder,
  isAvailable: z.boolean().default(true),
});
const itemUpdate = itemCreate
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    'At least one field is required.',
  );
const listQuery = z.object({
  categoryId: z.uuid().optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  includeUnavailable: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export function createMenuRouter(
  database: AppDatabase,
  middleware: {
    authenticate: RequestHandler;
    requireAdmin: RequestHandler;
    csrf: RequestHandler;
  },
) {
  const router = Router();
  const menu = new MenuService(database);
  router.get('/menu/categories', middleware.authenticate, (request, response) =>
    response.json({
      categories: menu.listCategories(
        response.locals.user.role,
        request.query.includeInactive === 'true',
      ),
    }),
  );
  router.post(
    '/admin/menu/categories',
    middleware.csrf,
    middleware.authenticate,
    middleware.requireAdmin,
    (request, response) =>
      response.status(201).json({
        category: menu.createCategory(parse(categoryCreate, request.body)),
      }),
  );
  router.patch(
    '/admin/menu/categories/:id',
    middleware.csrf,
    middleware.authenticate,
    middleware.requireAdmin,
    (request, response) =>
      response.json({
        category: menu.updateCategory(
          String(request.params.id),
          parse(categoryUpdate, request.body),
        ),
      }),
  );
  router.get('/menu/items', middleware.authenticate, (request, response) =>
    response.json(
      menu.listItems({
        role: response.locals.user.role,
        ...parse(listQuery, request.query),
      }),
    ),
  );
  router.post(
    '/admin/menu/items',
    middleware.csrf,
    middleware.authenticate,
    middleware.requireAdmin,
    (request, response) =>
      response
        .status(201)
        .json({ item: menu.createItem(parse(itemCreate, request.body)) }),
  );
  router.patch(
    '/admin/menu/items/:id',
    middleware.csrf,
    middleware.authenticate,
    middleware.requireAdmin,
    (request, response) =>
      response.json({
        item: menu.updateItem(
          String(request.params.id),
          parse(itemUpdate, request.body),
        ),
      }),
  );
  router.patch(
    '/admin/menu/items/:id/availability',
    middleware.csrf,
    middleware.authenticate,
    middleware.requireAdmin,
    (request, response) =>
      response.json({
        item: menu.setAvailability(
          String(request.params.id),
          parse(z.strictObject({ isAvailable: z.boolean() }), request.body)
            .isAvailable,
        ),
      }),
  );
  router.patch(
    '/admin/menu/items/:id/archive',
    middleware.csrf,
    middleware.authenticate,
    middleware.requireAdmin,
    (request, response) =>
      response.json({
        item: menu.setArchived(
          String(request.params.id),
          parse(z.strictObject({ isArchived: z.boolean() }), request.body)
            .isArchived,
        ),
      }),
  );
  return router;
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError)
      throw new MenuError(
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
