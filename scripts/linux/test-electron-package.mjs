import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const release = path.join(root, 'release', 'linux');
const appImage = path.join(release, 'RestaurantPOS-Linux-x64.AppImage');
const deb = path.join(release, 'RestaurantPOS-Linux-amd64.deb');
const checksumFile = path.join(release, 'SHA256SUMS-Linux.txt');
const artifacts = [
  'RestaurantPOS-Linux-x64.AppImage',
  'RestaurantPOS-Linux-amd64.deb',
];

for (const artifact of artifacts) {
  const target = path.join(release, artifact);
  if (!fs.existsSync(target) || fs.statSync(target).size === 0)
    throw new Error(`Missing Linux release artifact: ${target}`);
}

const expected = new Map(
  fs
    .readFileSync(checksumFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^([a-f0-9]{64}) \*(.+)$/.exec(line);
      if (!match) throw new Error(`Invalid checksum line: ${line}`);
      return [match[2], match[1]];
    }),
);
for (const artifact of artifacts) {
  const actual = createHash('sha256')
    .update(fs.readFileSync(path.join(release, artifact)))
    .digest('hex');
  if (expected.get(artifact) !== actual)
    throw new Error(`SHA-256 mismatch for ${artifact}`);
}

const appImageMagic = fs.readFileSync(appImage, { start: 0, end: 3 });
if (!appImageMagic.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
  throw new Error('AppImage is not an ELF executable.');

const debInfo = spawnSync('dpkg-deb', ['--info', deb], { encoding: 'utf8' });
if (debInfo.status !== 0)
  throw new Error(`DEB metadata check failed: ${debInfo.stderr}`);
const debContents = spawnSync('dpkg-deb', ['--contents', deb], {
  encoding: 'utf8',
});
if (debContents.status !== 0)
  throw new Error(`DEB contents check failed: ${debContents.stderr}`);
for (const expectedPath of ['/opt/', '.desktop', 'icons/hicolor/']) {
  if (!debContents.stdout.includes(expectedPath))
    throw new Error(
      `DEB is missing expected packaged content: ${expectedPath}`,
    );
}

if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.log(
    'Linux package structure and checksums verified. Packaged GUI smoke test skipped because no desktop session is available.',
  );
  process.exit(0);
}

const data = fs.mkdtempSync(
  path.join(os.tmpdir(), 'restaurant-pos-appimage-data-'),
);
const config = fs.mkdtempSync(
  path.join(os.tmpdir(), 'restaurant-pos-appimage-config-'),
);
const port = 39_391;
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(appImage, [], {
  env: {
    ...environment,
    POS_ELECTRON_PORT: String(port),
    POS_DATA_DIR: data,
    XDG_CONFIG_HOME: config,
  },
  stdio: 'ignore',
});

async function waitForHealth() {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const healthy = await new Promise((resolve) => {
      const request = http.get(
        `http://127.0.0.1:${port}/api/health`,
        (response) => {
          response.resume();
          resolve(response.statusCode === 200);
        },
      );
      request.once('error', () => resolve(false));
      request.setTimeout(1_000, () => request.destroy());
    });
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Packaged AppImage did not start its local health endpoint.');
}

try {
  await waitForHealth();
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('AppImage did not close cleanly.')),
      15_000,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(config, { recursive: true, force: true });
}

console.log(
  'Linux package structure, checksums, AppImage health, and shutdown verified.',
);
