import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restaurant-pos-e2e-'));
const data = path.join(root, 'data');
const backups = path.join(root, 'backups');
const child = spawn('npm', ['start'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: '4327',
    POS_DATA_DIR: data,
    POS_BACKUP_DIR: backups,
  },
  stdio: 'inherit',
});

const stop = (signal) => {
  child.kill(signal);
  child.once('exit', () => {
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(0);
  });
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
child.on('exit', (code) => {
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(code ?? 1);
});
