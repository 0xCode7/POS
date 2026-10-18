import { createApp } from './app.js';
import { AuthService } from './auth/service.js';
import fs from 'node:fs';
import { openDatabase, resolveDataDirectory } from './db/database.js';
import { BackupService } from './maintenance/backup.js';
import { acquireRuntimeLock } from './maintenance/runtime-lock.js';
import { LocalLogger } from './maintenance/logger.js';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const requestedPort = Number(process.env.PORT ?? DEFAULT_PORT);
const port =
  Number.isInteger(requestedPort) &&
  requestedPort > 0 &&
  requestedPort <= 65_535
    ? requestedPort
    : DEFAULT_PORT;

const dataDirectory = resolveDataDirectory();
fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
const releaseRuntimeLock = acquireRuntimeLock(dataDirectory, 'server');
const database = openDatabase({ dataDirectory });
const backups = new BackupService(database);
const logger = new LocalLogger(database.filename);
backups.startAutomatic();
logger.info('server_starting', `Listening on ${LOOPBACK_HOST}:${port}`);
const expiredSessions = new AuthService(database).cleanupExpiredSessions();
if (expiredSessions > 0)
  console.log(`Removed ${expiredSessions} expired session(s).`);
const sessionCleanup = setInterval(
  () => new AuthService(database).cleanupExpiredSessions(),
  60 * 60 * 1000,
);
sessionCleanup.unref();

const server = createApp({ database, backupService: backups, logger }).listen(
  port,
  LOOPBACK_HOST,
  () => {
    console.log(
      `Restaurant POS is available at http://${LOOPBACK_HOST}:${port}`,
    );
  },
);

server.on('error', (error) => {
  console.error('Restaurant POS server failed to start:', error);
  logger.error('server_start_failed', error);
  process.exitCode = 1;
});

function shutDown(signal: string) {
  console.log(`Received ${signal}; closing the local server.`);
  logger.info('server_stopping', signal);
  server.close((error) => {
    if (error) {
      console.error('The server did not close cleanly:', error);
      process.exitCode = 1;
    }
    backups.stopAutomatic();
    clearInterval(sessionCleanup);
    database.sqlite.close();
    releaseRuntimeLock();
  });
}

process.on('SIGINT', () => shutDown('SIGINT'));
process.on('SIGTERM', () => shutDown('SIGTERM'));
