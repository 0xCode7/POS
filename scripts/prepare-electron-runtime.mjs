import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktop = path.join(root, 'desktop');
const destination = path.join(desktop, 'dist');

fs.copyFileSync(
  path.join(desktop, 'src', 'preload.cjs'),
  path.join(destination, 'preload.cjs'),
);

for (const name of ['server', 'client', 'drizzle'])
  fs.rmSync(path.join(destination, name), { recursive: true, force: true });

fs.cpSync(path.join(root, 'server', 'dist'), path.join(destination, 'server'), {
  recursive: true,
});
fs.cpSync(path.join(root, 'client', 'dist'), path.join(destination, 'client'), {
  recursive: true,
});
fs.cpSync(
  path.join(root, 'server', 'dist', 'drizzle'),
  path.join(destination, 'drizzle'),
  { recursive: true },
);
