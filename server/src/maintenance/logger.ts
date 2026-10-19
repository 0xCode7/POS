import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirectory } from './paths.js';

export class LocalLogger {
  private readonly filename: string;

  constructor(databaseFilename: string, directory?: string) {
    const target =
      directory ?? path.join(path.dirname(databaseFilename), 'logs');
    if (!path.isAbsolute(target))
      throw new Error('POS_LOG_DIR must be an absolute path.');
    const resolved = path.normalize(target);
    ensurePrivateDirectory(resolved);
    this.filename = path.join(resolved, 'application.log');
  }

  info(event: string, message: string) {
    this.tryWrite('INFO', event, message);
  }

  error(event: string, error: unknown) {
    this.tryWrite(
      'ERROR',
      event,
      error instanceof Error ? error.message : 'Unknown error',
    );
  }

  private tryWrite(level: 'INFO' | 'ERROR', event: string, message: string) {
    try {
      this.write(level, event, message);
    } catch (error) {
      console.error(
        'Local operational logging failed:',
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  }

  private write(level: 'INFO' | 'ERROR', event: string, message: string) {
    this.rotateIfNeeded();
    const record = JSON.stringify({
      at: new Date().toISOString(),
      level,
      event: clean(event),
      message: clean(message),
    });
    fs.appendFileSync(this.filename, `${record}\n`, { mode: 0o600 });
  }

  private rotateIfNeeded() {
    try {
      if (fs.statSync(this.filename).size < 2 * 1024 * 1024) return;
      fs.rmSync(`${this.filename}.1`, { force: true });
      fs.renameSync(this.filename, `${this.filename}.1`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function clean(value: string) {
  return value.replace(/[\r\n\t]/g, ' ').slice(0, 500);
}
function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
