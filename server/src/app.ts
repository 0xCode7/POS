import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { rateLimit } from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthError, AuthService, type PublicUser } from './auth/service.js';
import { parseCookie, SESSION_COOKIE } from './auth/security.js';
import { openDatabase, type AppDatabase } from './db/database.js';
import { createMenuRouter } from './menu/routes.js';
import { MenuError } from './menu/service.js';
import { createOrderRouter } from './orders/routes.js';
import { OrderError } from './orders/service.js';
import { createPaymentRouter } from './payments/routes.js';
import { createReportRouter } from './reports/routes.js';
import { BackupService } from './maintenance/backup.js';
import { createMaintenanceRouter } from './maintenance/routes.js';
import type { LocalLogger } from './maintenance/logger.js';

type AppOptions = {
  database?: AppDatabase;
  clientDirectory?: string;
  serveClient?: boolean;
  disableRateLimit?: boolean;
  backupService?: BackupService;
  logger?: LocalLogger;
};

export function createApp(options: AppOptions = {}) {
  const app = express();
  const database = options.database ?? openDatabase();
  const auth = new AuthService(database);
  const backups = options.backupService ?? new BackupService(database);
  const secureCookie = process.env.COOKIE_SECURE === 'true';

  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.set({
      'Content-Security-Policy':
        "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use('/api', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', (_request, response) =>
    response.json({
      status: 'ok',
      service: 'restaurant-pos-server',
      timestamp: new Date().toISOString(),
    }),
  );
  app.get('/api/auth/setup-status', (_request, response) =>
    response.json({ needsSetup: auth.needsSetup() }),
  );

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: options.disableRateLimit ? 10_000 : 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts. Try again later.' },
  });

  app.post(
    '/api/auth/setup',
    csrfProtection,
    authLimiter,
    asyncHandler(async (request, response) => {
      response.status(201).json({ user: await auth.setup(request.body) });
    }),
  );
  app.post(
    '/api/auth/login',
    csrfProtection,
    authLimiter,
    asyncHandler(async (request, response) => {
      const result = await auth.login(
        request.body?.username ?? '',
        request.body?.password ?? '',
      );
      setSessionCookie(response, result.token, result.expiresAt, secureCookie);
      response.json({ user: result.user });
    }),
  );
  app.post('/api/auth/logout', csrfProtection, (request, response) => {
    auth.logout(sessionToken(request));
    clearSessionCookie(response, secureCookie);
    response.status(204).end();
  });
  app.get('/api/auth/me', authenticate(auth), (_request, response) =>
    response.json({ user: response.locals.user }),
  );

  app.get(
    '/api/admin/users',
    authenticate(auth),
    requireAdmin,
    (_request, response) => {
      response.json({ users: auth.listUsers() });
    },
  );
  app.post(
    '/api/admin/users',
    csrfProtection,
    authenticate(auth),
    requireAdmin,
    asyncHandler(async (request, response) => {
      response.status(201).json({ user: await auth.createUser(request.body) });
    }),
  );
  app.patch(
    '/api/admin/users/:id/status',
    csrfProtection,
    authenticate(auth),
    requireAdmin,
    asyncHandler(async (request, response) => {
      if (typeof request.body?.active !== 'boolean')
        throw new AuthError(400, 'Active must be a boolean.');
      auth.setActive(String(request.params.id), request.body.active);
      response.status(204).end();
    }),
  );
  app.post(
    '/api/admin/users/:id/reset-password',
    csrfProtection,
    authenticate(auth),
    requireAdmin,
    asyncHandler(async (request, response) => {
      await auth.resetPassword(
        String(request.params.id),
        request.body?.password,
      );
      response.status(204).end();
    }),
  );

  app.use(
    '/api',
    createMenuRouter(database, {
      authenticate: authenticate(auth),
      requireAdmin,
      csrf: csrfProtection,
    }),
  );
  app.use(
    '/api',
    createOrderRouter(database, {
      authenticate: authenticate(auth),
      requireAdmin,
      csrf: csrfProtection,
    }),
  );
  app.use(
    '/api',
    createPaymentRouter(database, {
      authenticate: authenticate(auth),
      csrf: csrfProtection,
    }),
  );
  app.use(
    '/api',
    createReportRouter(database, {
      authenticate: authenticate(auth),
      requireAdmin,
    }),
  );
  app.use(
    '/api',
    createMaintenanceRouter(backups, {
      authenticate: authenticate(auth),
      requireAdmin,
      csrf: csrfProtection,
    }),
  );

  app.use('/api', (_request, response) =>
    response.status(404).json({ error: 'API route not found' }),
  );

  const serveClient =
    options.serveClient ?? process.env.NODE_ENV === 'production';
  if (serveClient) {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const clientDirectory =
      options.clientDirectory ??
      path.resolve(moduleDirectory, '../../client/dist');
    app.use(express.static(clientDirectory));
    app.use((_request, response) => {
      response.sendFile(path.join(clientDirectory, 'index.html'), (error) => {
        if (error && !response.headersSent)
          response
            .status(503)
            .json({ error: 'Client application has not been built.' });
      });
    });
  }

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      void next;
      if (error instanceof AuthError) {
        response.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof MenuError || error instanceof OrderError) {
        response.status(error.status).json({
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        });
        return;
      }
      if (error instanceof SyntaxError) {
        response.status(400).json({ error: 'Invalid JSON request.' });
        return;
      }
      if (isStorageError(error)) {
        response.status(507).json({
          error:
            'Local storage is unavailable or full. No success was recorded.',
        });
        return;
      }
      if (isBusyError(error)) {
        response.status(503).json({
          error: 'The local database is busy. Please retry the operation.',
        });
        return;
      }
      console.error(
        'Request failed:',
        error instanceof Error ? error.message : 'Unknown error',
      );
      options.logger?.error('request_failed', error);
      response
        .status(500)
        .json({ error: 'An unexpected server error occurred.' });
    },
  );
  return app;
}

function sqliteCode(error: unknown) {
  return error instanceof Error && 'code' in error
    ? String((error as Error & { code: unknown }).code)
    : '';
}
function isStorageError(error: unknown) {
  return [
    'SQLITE_FULL',
    'SQLITE_IOERR',
    'SQLITE_READONLY',
    'ENOSPC',
    'EACCES',
  ].some((code) => sqliteCode(error).startsWith(code));
}
function isBusyError(error: unknown) {
  return ['SQLITE_BUSY', 'SQLITE_LOCKED'].some((code) =>
    sqliteCode(error).startsWith(code),
  );
}

function csrfProtection(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  if (request.get('X-CSRF-Protection') !== '1') {
    response.status(403).json({ error: 'Request verification failed.' });
    return;
  }
  const origin = request.get('Origin');
  if (origin) {
    const allowed = new Set([
      `http://${request.get('host')}`,
      `https://${request.get('host')}`,
    ]);
    if (!allowed.has(origin)) {
      response.status(403).json({ error: 'Request origin is not allowed.' });
      return;
    }
  }
  next();
}

function authenticate(auth: AuthService) {
  return (request: Request, response: Response, next: NextFunction) => {
    const user = auth.currentUser(sessionToken(request));
    if (!user) {
      clearSessionCookie(response, process.env.COOKIE_SECURE === 'true');
      response.status(401).json({ error: 'Authentication required.' });
      return;
    }
    response.locals.user = user;
    next();
  };
}

function requireAdmin(
  _request: Request,
  response: Response,
  next: NextFunction,
) {
  const user = response.locals.user as PublicUser | undefined;
  if (user?.role !== 'admin') {
    response.status(403).json({ error: 'Administrator access required.' });
    return;
  }
  next();
}
function sessionToken(request: Request) {
  return parseCookie(request.get('Cookie'), SESSION_COOKIE);
}
function setSessionCookie(
  response: Response,
  token: string,
  expiresAt: Date,
  secure: boolean,
) {
  response.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    expires: expiresAt,
  });
}
function clearSessionCookie(response: Response, secure: boolean) {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
  });
}
function asyncHandler(
  handler: (request: Request, response: Response) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}
