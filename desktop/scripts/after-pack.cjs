const fs = require('node:fs');
const path = require('node:path');

function removeIfPresent(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function retainOnly(directory, keep) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory)) {
    if (!keep(entry)) removeIfPresent(path.join(directory, entry));
  }
}

exports.default = async function removeForeignNativePrebuilds(context) {
  const platform = context.electronPlatformName;
  const architecture = context.arch === 1 ? 'x64' : undefined;
  if (!architecture)
    throw new Error(
      `Unsupported Electron packaging architecture: ${context.arch}`,
    );

  const modules = path.join(
    context.appOutDir,
    'resources',
    'app',
    'node_modules',
  );
  const argonPrebuilds = path.join(modules, 'argon2', 'prebuilds');
  const sqlitePrebuilds = path.join(modules, 'better-sqlite3', 'prebuilds');
  const targetPrefix = platform === 'win32' ? 'win32-' : `${platform}-`;

  retainOnly(
    argonPrebuilds,
    (entry) => entry === `${targetPrefix}${architecture}`,
  );
  retainOnly(
    sqlitePrebuilds,
    (entry) => entry === `${targetPrefix}${architecture}.node`,
  );
};
