import fs from 'node:fs';
import path from 'node:path';

export function acquireRuntimeLock(
  dataDirectory: string,
  purpose: 'server' | 'restore' | 'supervisor',
  lockName = '.restaurant-pos.lock',
) {
  const filename = path.join(dataDirectory, lockName);
  try {
    const handle = fs.openSync(filename, 'wx', 0o600);
    fs.writeFileSync(
      handle,
      JSON.stringify({
        pid: process.pid,
        purpose,
        startedAt: new Date().toISOString(),
      }),
    );
    fs.closeSync(handle);
  } catch (error) {
    if (!isExists(error)) throw error;
    const existing = readLock(filename);
    if (existing && processExists(existing.pid))
      throw new Error(
        `Restaurant POS is already running (${existing.purpose}, PID ${existing.pid}).`,
        { cause: error },
      );
    fs.rmSync(filename, { force: true });
    return acquireRuntimeLock(dataDirectory, purpose, lockName);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = readLock(filename);
    if (current?.pid === process.pid) fs.rmSync(filename, { force: true });
  };
}

function readLock(filename: string) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8')) as {
      pid: number;
      purpose: string;
    };
  } catch {
    return undefined;
  }
}
function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function isExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
