import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';
import { readPNG, resize } from 'png-to-ico/lib/png.js';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// This is the high-resolution, transparent restaurant mark used as the web
// favicon. Keep every desktop icon derived from this single brand asset.
const source = path.join(root, 'client', 'public', 'favicon.png');
const build = path.join(root, 'desktop', 'build');
const runtime = path.join(root, 'desktop', 'dist', 'icons');
const iconSizes = [16, 24, 32, 48, 64, 128, 256, 512];

for (const directory of [build, path.join(build, 'icons'), runtime])
  fs.mkdirSync(directory, { recursive: true });

const sourceImage = await readPNG(source);
const iconFiles = [];

for (const size of iconSizes) {
  const image =
    sourceImage.width === size && sourceImage.height === size
      ? sourceImage
      : resize(sourceImage, size, size, 'bicubicInterpolation');
  const filename = `${size}x${size}.png`;
  const output = PNG.sync.write(image);
  const buildTarget = path.join(build, 'icons', filename);
  fs.writeFileSync(buildTarget, output);
  fs.writeFileSync(path.join(runtime, filename), output);
  if (size <= 256) iconFiles.push(buildTarget);
}

const ico = await pngToIco(iconFiles);
for (const target of [
  path.join(build, 'icon.ico'),
  path.join(runtime, 'icon.ico'),
])
  fs.writeFileSync(target, ico);
