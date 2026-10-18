import fs from 'node:fs';
import path from 'node:path';
import { verifyBackup } from './backup.js';

export const rollbackName = 'restaurant-pos.restore-rollback.sqlite';
export const stagingName = 'restaurant-pos.restore-staging.sqlite';

export function recoverInterruptedRestore(dataDirectory: string) {
  const live = path.join(dataDirectory, 'restaurant-pos.sqlite');
  const rollback = path.join(dataDirectory, rollbackName);
  const staging = path.join(dataDirectory, stagingName);
  if (!fs.existsSync(rollback)) {
    fs.rmSync(staging, { force: true });
    return;
  }
  if (!fs.existsSync(live)) fs.renameSync(rollback, live);
  else {
    try {
      verifyBackup(live);
      fs.rmSync(rollback, { force: true });
    } catch {
      fs.rmSync(live, { force: true });
      fs.renameSync(rollback, live);
    }
  }
  fs.rmSync(staging, { force: true });
  removeSidecars(live);
}

export function removeSidecars(filename: string) {
  fs.rmSync(`${filename}-wal`, { force: true });
  fs.rmSync(`${filename}-shm`, { force: true });
}
