import { and, count, eq, gt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import { sessions, users, type User, type UserRole } from '../db/schema.js';
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  SESSION_DURATION_MS,
  verifyPassword,
} from './security.js';

export type PublicUser = Pick<
  User,
  | 'id'
  | 'username'
  | 'displayName'
  | 'role'
  | 'active'
  | 'createdAt'
  | 'updatedAt'
>;

function publicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export class AuthService {
  constructor(private readonly database: AppDatabase) {}

  needsSetup() {
    return (
      this.database.db.select({ value: count() }).from(users).get()!.value === 0
    );
  }

  async setup(input: {
    username: string;
    displayName: string;
    password: string;
  }) {
    const validated = validateUserInput({ ...input, role: 'admin' });
    const passwordHash = await hashPassword(input.password);
    const now = new Date();
    const user: User = {
      id: randomUUID(),
      username: validated.username,
      displayName: validated.displayName,
      passwordHash,
      role: 'admin',
      active: true,
      createdAt: now,
      updatedAt: now,
    };

    const createInitialAdmin = this.database.sqlite.transaction(() => {
      const existing = this.database.sqlite
        .prepare('SELECT COUNT(*) AS count FROM users')
        .get() as { count: number };
      if (existing.count !== 0)
        throw new AuthError(409, 'Initial setup is already complete.');
      this.insertUser(user);
    });
    createInitialAdmin.immediate();
    return publicUser(user);
  }

  async login(username: string, password: string) {
    this.cleanupExpiredSessions();
    const user = this.database.db
      .select()
      .from(users)
      .where(eq(users.username, normalizeUsername(username)))
      .get();
    if (
      !user ||
      !user.active ||
      !(await verifyPassword(user.passwordHash, password))
    ) {
      throw new AuthError(401, 'Invalid username or password.');
    }
    return { user: publicUser(user), ...this.createSession(user.id) };
  }

  currentUser(token: string | undefined) {
    if (!token) return undefined;
    const now = new Date();
    const result = this.database.db
      .select({ user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(
        and(
          eq(sessions.tokenHash, hashSessionToken(token)),
          gt(sessions.expiresAt, now),
          eq(users.active, true),
        ),
      )
      .get();
    return result ? publicUser(result.user) : undefined;
  }

  logout(token: string | undefined) {
    if (token)
      this.database.db
        .delete(sessions)
        .where(eq(sessions.tokenHash, hashSessionToken(token)))
        .run();
  }

  cleanupExpiredSessions() {
    return this.database.sqlite
      .prepare('DELETE FROM sessions WHERE expires_at <= ?')
      .run(Date.now()).changes;
  }

  listUsers() {
    return this.database.db.select().from(users).all().map(publicUser);
  }

  async createUser(input: {
    username: string;
    displayName: string;
    password: string;
    role: UserRole;
  }) {
    const validated = validateUserInput(input);
    const now = new Date();
    const user: User = {
      id: randomUUID(),
      username: validated.username,
      displayName: validated.displayName,
      passwordHash: await hashPassword(input.password),
      role: validated.role,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    try {
      this.insertUser(user);
    } catch (error) {
      if (isUniqueConstraint(error))
        throw new AuthError(409, 'That username is already in use.');
      throw error;
    }
    return publicUser(user);
  }

  setActive(userId: string, active: boolean) {
    const update = this.database.sqlite.transaction(() => {
      const target = this.database.db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .get();
      if (!target) throw new AuthError(404, 'User not found.');
      if (!active && target.active && target.role === 'admin') {
        const activeAdmins = this.database.db
          .select({ value: count() })
          .from(users)
          .where(and(eq(users.role, 'admin'), eq(users.active, true)))
          .get()!.value;
        if (activeAdmins <= 1)
          throw new AuthError(
            409,
            'The last active admin cannot be deactivated.',
          );
      }
      this.database.db
        .update(users)
        .set({ active, updatedAt: new Date() })
        .where(eq(users.id, userId))
        .run();
      if (!active)
        this.database.db
          .delete(sessions)
          .where(eq(sessions.userId, userId))
          .run();
    });
    update.immediate();
  }

  async resetPassword(userId: string, password: string) {
    validatePassword(password);
    const result = this.database.db
      .update(users)
      .set({
        passwordHash: await hashPassword(password),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .run();
    if (result.changes === 0) throw new AuthError(404, 'User not found.');
    this.database.db.delete(sessions).where(eq(sessions.userId, userId)).run();
  }

  private insertUser(user: User) {
    this.database.db.insert(users).values(user).run();
  }

  private createSession(userId: string) {
    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    this.database.db
      .insert(sessions)
      .values({
        id: randomUUID(),
        userId,
        tokenHash: hashSessionToken(token),
        expiresAt,
        createdAt: new Date(),
      })
      .run();
    return { token, expiresAt };
  }
}

function normalizeUsername(value: string) {
  return value.trim().toLowerCase();
}
function validatePassword(value: string) {
  if (typeof value !== 'string' || value.length < 5 || value.length > 128) {
    throw new AuthError(400, 'Password must be between 5 and 128 characters.');
  }
}
function validateUserInput(input: {
  username: string;
  displayName: string;
  password: string;
  role: UserRole;
}) {
  const username = normalizeUsername(input.username ?? '');
  const displayName = input.displayName?.trim();
  if (!/^[a-z0-9._-]{3,40}$/.test(username))
    throw new AuthError(
      400,
      'Username must be 3–40 letters, numbers, dots, underscores, or hyphens.',
    );
  if (!displayName || displayName.length > 80)
    throw new AuthError(
      400,
      'Display name is required and must not exceed 80 characters.',
    );
  if (input.role !== 'admin' && input.role !== 'cashier')
    throw new AuthError(400, 'Role must be admin or cashier.');
  validatePassword(input.password);
  return { username, displayName, role: input.role };
}
function isUniqueConstraint(error: unknown) {
  return (
    error instanceof Error && error.message.includes('UNIQUE constraint failed')
  );
}
export class AuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
