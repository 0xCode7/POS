import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';
import { recoverInterruptedRestore } from '../maintenance/recovery.js';

export type AppDatabase = ReturnType<typeof openDatabase>;

export function resolveDataDirectory(configured = process.env.POS_DATA_DIR) {
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error('POS_DATA_DIR must be an absolute path.');
    }
    return path.normalize(configured);
  }

  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? process.env.APPDATA;
    if (!base || !path.isAbsolute(base)) {
      throw new Error('LOCALAPPDATA or APPDATA is required on Windows.');
    }
    return path.join(base, 'RestaurantPOS', 'data');
  }

  const xdg = process.env.XDG_DATA_HOME;
  return xdg && path.isAbsolute(xdg)
    ? path.join(xdg, 'restaurant-pos')
    : path.join(os.homedir(), '.local', 'share', 'restaurant-pos');
}

export function openDatabase(
  options: { dataDirectory?: string; migrationsFolder?: string } = {},
) {
  const dataDirectory = resolveDataDirectory(options.dataDirectory);
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  recoverInterruptedRestore(dataDirectory);
  const filename = path.join(dataDirectory, 'restaurant-pos.sqlite');
  const sqlite = new Database(filename);

  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = FULL');

  const db = drizzle(sqlite, { schema });
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const configuredMigrations =
    options.migrationsFolder ?? process.env.POS_MIGRATIONS_DIR;
  if (configuredMigrations && !path.isAbsolute(configuredMigrations))
    throw new Error('POS_MIGRATIONS_DIR must be an absolute path.');
  const migrationsFolder =
    configuredMigrations ?? path.resolve(moduleDirectory, '../../drizzle');
  migrate(db, { migrationsFolder });

  return { db, sqlite, filename };
}
