import fs from 'node:fs';
import path from 'node:path';

export type BackupSettings = {
  directory: string;
  previousDirectories: string[];
  updatedAt: string;
};

export function resolveBackupDirectory(
  databaseFilename: string,
  configured = process.env.POS_BACKUP_DIR,
) {
  const saved = configured ? undefined : readBackupSettings(databaseFilename);
  const value =
    configured ??
    saved?.directory ??
    path.join(path.dirname(databaseFilename), 'backups');
  if (!path.isAbsolute(value))
    throw new Error('يجب أن يكون POS_BACKUP_DIR مسارًا مطلقًا.');
  const resolved = path.resolve(value);
  if (resolved === path.dirname(databaseFilename))
    throw new Error(
      'لا يجوز أن يكون POS_BACKUP_DIR هو مجلد قاعدة البيانات الحالية.',
    );
  return resolved;
}

export function backupDirectorySource(databaseFilename: string) {
  if (process.env.POS_BACKUP_DIR) return 'environment' as const;
  return readBackupSettings(databaseFilename)
    ? ('saved' as const)
    : ('default' as const);
}

export function readBackupSettings(databaseFilename: string) {
  const filename = settingsFilename(databaseFilename);
  if (!fs.existsSync(filename)) return undefined;
  try {
    const value = JSON.parse(
      fs.readFileSync(filename, 'utf8'),
    ) as BackupSettings;
    if (
      !path.isAbsolute(value.directory) ||
      !Array.isArray(value.previousDirectories) ||
      value.previousDirectories.some((entry) => !path.isAbsolute(entry))
    )
      throw new Error('تحتوي إعدادات النسخ الاحتياطي على مسارات غير صالحة.');
    return value;
  } catch (error) {
    throw new Error(
      `تعذرت قراءة إعدادات النسخ الاحتياطي: ${error instanceof Error ? error.message : 'ملف غير صالح'}`,
      { cause: error },
    );
  }
}

export function persistBackupDirectory(
  databaseFilename: string,
  directory: string,
  currentDirectory?: string,
) {
  if (process.env.POS_BACKUP_DIR)
    throw new Error(
      'يتحكم POS_BACKUP_DIR في موقع النسخ، ولا يمكن تغييره من الواجهة.',
    );
  const current = readBackupSettings(databaseFilename);
  const previousDirectories = [
    ...(currentDirectory && currentDirectory !== directory
      ? [currentDirectory]
      : []),
    ...(current?.directory && current.directory !== directory
      ? [current.directory]
      : []),
    ...(current?.previousDirectories ?? []),
  ]
    .filter((entry, index, values) => values.indexOf(entry) === index)
    .slice(0, 10);
  const settings: BackupSettings = {
    directory,
    previousDirectories,
    updatedAt: new Date().toISOString(),
  };
  const filename = settingsFilename(databaseFilename);
  const temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporary, filename);
  return settings;
}

export function validateWritableBackupDirectory(
  candidate: string,
  databaseFilename: string,
  installationDirectory = process.cwd(),
) {
  if (!path.isAbsolute(candidate))
    throw new Error('يجب إدخال مسار مطلق لمجلد النسخ الاحتياطي.');
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root)
    throw new Error('لا يمكن استخدام جذر نظام الملفات كمجلد للنسخ الاحتياطي.');
  const databaseDirectory = fs.realpathSync(path.dirname(databaseFilename));
  const installation = fs.realpathSync(installationDirectory);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(resolved) && !fs.existsSync(parent))
    throw new Error('المجلد الأب لمسار النسخ غير موجود.');
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const real = fs.realpathSync(resolved);
  if (real === databaseDirectory)
    throw new Error('لا يمكن حفظ النسخ داخل مجلد قاعدة البيانات الحالية.');
  if (real === installation || isInside(real, installation))
    throw new Error('لا يمكن حفظ النسخ داخل مجلد تثبيت التطبيق.');
  const mode = fs.statSync(real).mode;
  if ((mode & 0o222) === 0)
    throw new Error('مجلد النسخ المحدد للقراءة فقط ولا يمكن الكتابة إليه.');
  const probe = path.join(real, `.restaurant-pos-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, 'write-test', { flag: 'wx', mode: 0o600 });
  } finally {
    fs.rmSync(probe, { force: true });
  }
  return real;
}

export function samePhysicalDevice(
  directory: string,
  databaseFilename: string,
) {
  try {
    return fs.statSync(directory).dev === fs.statSync(databaseFilename).dev;
  } catch {
    return null;
  }
}

function settingsFilename(databaseFilename: string) {
  return path.join(path.dirname(databaseFilename), 'backup-settings.json');
}

function isInside(candidate: string, parent: string) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

export function ensurePrivateDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

export function safeBackupPath(directory: string, filename: string) {
  if (
    path.basename(filename) !== filename ||
    !/^restaurant-pos-\d{8}T\d{6}Z-(?:daily|manual|pre-restore)-[a-f0-9]{8}\.sqlite$/.test(
      filename,
    )
  )
    throw new Error('اسم ملف النسخة الاحتياطية غير مسموح به.');
  const resolved = path.resolve(directory, filename);
  if (path.dirname(resolved) !== path.resolve(directory))
    throw new Error('مسار النسخة يخرج عن مجلد النسخ المحدد.');
  return resolved;
}
