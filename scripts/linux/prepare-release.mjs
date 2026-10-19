import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const source = path.join(root, 'release', 'electron');
const output = path.join(root, 'release', 'linux');
const artifacts = [
  'RestaurantPOS-Linux-x64.AppImage',
  'RestaurantPOS-Linux-amd64.deb',
];

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const artifact of artifacts) {
  const input = path.join(source, artifact);
  if (!fs.existsSync(input) || fs.statSync(input).size === 0)
    throw new Error(`Linux package is missing or empty: ${input}`);
  fs.copyFileSync(input, path.join(output, artifact));
}

const checksums = artifacts
  .map((artifact) => {
    const contents = fs.readFileSync(path.join(output, artifact));
    const hash = createHash('sha256').update(contents).digest('hex');
    return `${hash} *${artifact}`;
  })
  .join('\n');
fs.writeFileSync(path.join(output, 'SHA256SUMS-Linux.txt'), `${checksums}\n`);

for (const artifact of [...artifacts, 'SHA256SUMS-Linux.txt']) {
  const target = path.join(output, artifact);
  console.log(`${artifact} ${fs.statSync(target).size} bytes`);
}
