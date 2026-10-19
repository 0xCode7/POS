import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'client', 'public', 'favicon.png');
const build = path.join(root, 'desktop', 'build');
const runtime = path.join(root, 'desktop', 'dist', 'icons');

for (const directory of [build, path.join(build, 'icons'), runtime])
  fs.mkdirSync(directory, { recursive: true });

for (const directory of [path.join(build, 'icons'), runtime])
  fs.copyFileSync(source, path.join(directory, '512x512.png'));

const ico = await pngToIco(source);
for (const target of [
  path.join(build, 'icon.ico'),
  path.join(runtime, 'icon.ico'),
])
  fs.writeFileSync(target, ico);
