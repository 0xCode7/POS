import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppDatabase } from '../db/database.js';
import { verifyPassword } from '../auth/security.js';
import {
  migrationCompatibility,
  migrationSignatures,
} from './backup-validation.js';
import {
  backupDirectorySource,
  ensurePrivateDirectory,
  readBackupSettings,
  resolveBackupDirectory,
  safeBackupPath,
  samePhysicalDevice,
} from './paths.js';

export type BackupKind = 'daily' | 'manual' | 'pre-restore';
type BasicBackupRecord = {
  filename: string;
  kind: BackupKind;
  createdAt: string;
  sizeBytes: number;
};
export type BackupRecord = BasicBackupRecord & {
  friendlyName: string;
  hasCustomName: boolean;
  validation: 'valid' | 'corrupt' | 'incompatible' | 'missing' | 'unverified';
  integrity: 'valid' | 'corrupt' | 'missing' | 'unverified';
  compatibility: 'compatible' | 'incompatible' | 'unverified';
  compatibilityMessage: string;
  pendingMigrations: number;
  restoreEligible: boolean;
  validationMessage: string;
};
type BackupMetadata = {
  version: 1;
  filename: string;
  friendlyName?: string;
  kind: BackupKind;
  createdAt: string;
};

export class BackupService {
  private activeDirectory: string;
  readonly retentionDays: number;
  private running?: Promise<BackupRecord>;
  private timer?: NodeJS.Timeout;
  private lastError: { at: string; message: string } | null = null;

  constructor(private readonly database: AppDatabase) {
    this.activeDirectory = resolveBackupDirectory(database.filename);
    this.retentionDays = retentionDays(process.env.POS_BACKUP_RETENTION_DAYS);
    ensurePrivateDirectory(this.activeDirectory);
  }

  get directory() {
    return this.activeDirectory;
  }

  status() {
    const history = this.history();
    return {
      directory: this.directory,
      directorySource: backupDirectorySource(this.database.filename),
      previousDirectories:
        readBackupSettings(this.database.filename)?.previousDirectories ?? [],
      retentionDays: this.retentionDays,
      automaticEnabled: Boolean(this.timer),
      running: Boolean(this.running),
      lastSuccessfulAt:
        history.find((entry) => entry.validation === 'valid')?.createdAt ??
        null,
      lastError: this.lastError,
      history,
      sameDisk: samePhysicalDevice(this.directory, this.database.filename),
      sameDiskWarning:
        'النسخة الموجودة على نفس القرص لا تحمي من تعطل القرص. استخدم قرصًا آخر إن أمكن.',
      restoreMode: 'offline-cli' as const,
    };
  }

  history(limit = 50) {
    ensurePrivateDirectory(this.directory);
    return fs
      .readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => recordFromFile(this.directory, entry.name))
      .filter((entry): entry is BasicBackupRecord => entry !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((entry) => this.validateRecord(entry));
  }

  paginatedHistory(input: { page: number; limit: number; search?: string }) {
    const search = input.search?.trim().toLocaleLowerCase('en') ?? '';
    const records = this.history(1_000).filter((entry) =>
      search
        ? entry.filename.toLocaleLowerCase('en').includes(search) ||
          entry.friendlyName.toLocaleLowerCase('en').includes(search)
        : true,
    );
    return {
      items: records.slice(
        (input.page - 1) * input.limit,
        input.page * input.limit,
      ),
      pagination: {
        page: input.page,
        limit: input.limit,
        total: records.length,
        pages: Math.ceil(records.length / input.limit),
      },
    };
  }

  inspect(filename: string) {
    const candidate = safeBackupPath(this.directory, filename);
    if (!fs.existsSync(candidate))
      throw new Error('ملف النسخة الاحتياطية غير موجود في مجلد النسخ الحالي.');
    const basic = recordFromFile(this.directory, filename);
    if (!basic) throw new Error('اسم ملف النسخة الاحتياطية غير مسموح به.');
    return this.validateRecord(basic);
  }

  async prepareRestore(input: {
    filename: string;
    actorId: string;
    password: string;
    confirmation: string;
  }) {
    const record = this.inspect(input.filename);
    if (!record.restoreEligible)
      throw new Error('النسخة المحددة غير مؤهلة للاستعادة الآمنة.');
    if (input.confirmation !== `RESTORE ${input.filename}`)
      throw new Error('عبارة تأكيد الاستعادة لا تطابق النسخة المحددة.');
    const actor = this.database.sqlite
      .prepare(
        'SELECT role, active, password_hash AS passwordHash FROM users WHERE id = ?',
      )
      .get(input.actorId) as
      { role: string; active: number; passwordHash: string } | undefined;
    if (
      !actor ||
      actor.role !== 'admin' ||
      !actor.active ||
      !(await verifyPassword(actor.passwordHash, input.password))
    )
      throw new Error('فشلت إعادة مصادقة المدير بكلمة المرور الحالية.');
    return {
      backup: record,
      restoreAvailable: false as const,
      mode: 'offline-cli' as const,
      message:
        'النسخة سليمة ومتوافقة، ونجحت المصادقة. لم تتم الاستعادة؛ أوقف الخدمة واستخدم أداة الصيانة. الاستعادة من الواجهة تحتاج إلى مشرف تشغيل موثوق.',
    };
  }

  async authorizeSupervisorRestore(input: {
    filename: string;
    actorId: string;
    password: string;
    confirmation: string;
  }) {
    const record = this.inspect(input.filename);
    if (!record.restoreEligible)
      throw new Error('النسخة المحددة غير مؤهلة للاستعادة الآمنة.');
    if (input.confirmation !== `استعادة ${input.filename}`)
      throw new Error('عبارة التأكيد العربية لا تطابق النسخة المحددة.');
    const actor = this.database.sqlite
      .prepare(
        'SELECT role, active, password_hash AS passwordHash FROM users WHERE id = ?',
      )
      .get(input.actorId) as
      { role: string; active: number; passwordHash: string } | undefined;
    if (
      !actor ||
      actor.role !== 'admin' ||
      !actor.active ||
      !(await verifyPassword(actor.passwordHash, input.password))
    )
      throw new Error('فشلت إعادة مصادقة المدير بكلمة المرور الحالية.');
    return record;
  }

  async create(
    kind: BackupKind = 'manual',
    input: { friendlyName?: string } = {},
  ) {
    if (this.running) return this.running;
    const friendlyName = normalizeFriendlyName(input.friendlyName);
    this.running = this.perform(kind, { friendlyName }).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async runDailyIfDue(now = new Date()) {
    const latestDaily = this.history().find(
      (backup) => backup.kind === 'daily',
    );
    if (
      latestDaily &&
      now.getTime() - new Date(latestDaily.createdAt).getTime() <
        24 * 60 * 60 * 1000
    )
      return undefined;
    try {
      return await this.create('daily');
    } catch (error) {
      this.lastError = {
        at: new Date().toISOString(),
        message: safeMessage(error),
      };
      console.error('Automatic database backup failed:', safeMessage(error));
      return undefined;
    }
  }

  startAutomatic() {
    void this.runDailyIfDue();
    this.timer = setInterval(() => void this.runDailyIfDue(), 60 * 60 * 1000);
    this.timer.unref();
  }

  stopAutomatic() {
    if (this.timer) clearInterval(this.timer);
  }

  private async perform(kind: BackupKind, input: { friendlyName?: string }) {
    ensurePrivateDirectory(this.directory);
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
    const filename = `restaurant-pos-${timestamp}-${kind}-${randomBytes(4).toString('hex')}.sqlite`;
    const createdAt = timestampToIso(timestamp);
    const destination = path.join(this.directory, filename);
    const temporary = `${destination}.partial`;
    const metadata = backupMetadata({
      filename,
      kind,
      createdAt,
      friendlyName: input.friendlyName,
    });
    try {
      await this.database.sqlite.backup(temporary);
      verifyBackup(temporary);
      removeTemporarySidecars(temporary);
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, destination);
      writeBackupMetadata(this.directory, metadata);
      this.lastError = null;
      this.applyRetention();
      return this.validateRecord(recordFromFile(this.directory, filename)!);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      removeTemporarySidecars(temporary);
      fs.rmSync(destination, { force: true });
      fs.rmSync(metadataFilename(this.directory, filename), { force: true });
      this.lastError = {
        at: new Date().toISOString(),
        message: safeMessage(error),
      };
      throw error;
    }
  }

  private applyRetention(now = Date.now()) {
    const daily = this.history(10_000).filter(
      (entry) => entry.kind === 'daily',
    );
    const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
    for (const backup of daily.slice(7)) {
      if (new Date(backup.createdAt).getTime() < cutoff)
        fs.rmSync(path.join(this.directory, backup.filename), { force: true });
      fs.rmSync(metadataFilename(this.directory, backup.filename), {
        force: true,
      });
    }
  }

  private validateRecord(basic: BasicBackupRecord): BackupRecord {
    const metadata = readBackupMetadata(this.directory, basic);
    try {
      const candidateFilename = path.join(this.directory, basic.filename);
      verifyBackup(candidateFilename);
      const candidate = new Database(candidateFilename, {
        readonly: true,
        fileMustExist: true,
      });
      let candidateMigrations: Array<{ hash: string; createdAt: number }>;
      try {
        candidateMigrations = migrationSignatures(candidate);
      } finally {
        candidate.close();
      }
      const currentMigrations = migrationSignatures(this.database.sqlite);
      const compatibility = migrationCompatibility(
        candidateMigrations,
        currentMigrations,
      );
      if (!compatibility.compatible)
        return {
          ...basic,
          ...metadata,
          validation: 'incompatible' as const,
          integrity: 'valid' as const,
          compatibility: 'incompatible' as const,
          compatibilityMessage: compatibility.message,
          pendingMigrations: 0,
          restoreEligible: false,
          validationMessage: compatibility.message,
        };
      return {
        ...basic,
        ...metadata,
        validation: 'valid' as const,
        integrity: 'valid' as const,
        compatibility: 'compatible' as const,
        compatibilityMessage: compatibility.message,
        pendingMigrations: compatibility.pendingMigrations,
        restoreEligible: true,
        validationMessage: `اجتازت النسخة فحوص سلامة SQLite. ${compatibility.message}`,
      };
    } catch (error) {
      return {
        ...basic,
        ...metadata,
        validation: 'corrupt' as const,
        integrity: 'corrupt' as const,
        compatibility: 'unverified' as const,
        compatibilityMessage:
          'تعذر فحص التوافق لأن النسخة لم تجتز فحص السلامة.',
        pendingMigrations: 0,
        restoreEligible: false,
        validationMessage: arabicValidationMessage(error),
      };
    }
  }
}

function removeTemporarySidecars(filename: string) {
  fs.rmSync(`${filename}-wal`, { force: true });
  fs.rmSync(`${filename}-shm`, { force: true });
}

export function verifyBackup(filename: string) {
  const candidate = new Database(filename, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const integrity = candidate.pragma('integrity_check') as Array<{
      integrity_check: string;
    }>;
    const foreignKeys = candidate.pragma('foreign_key_check') as unknown[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok')
      throw new Error('فشل فحص سلامة SQLite ‏(integrity_check).');
    if (foreignKeys.length !== 0)
      throw new Error(
        'تحتوي النسخة على مخالفات في العلاقات (foreign_key_check).',
      );
    const migrations = candidate
      .prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations')
      .get() as { count: number } | undefined;
    if (!migrations || migrations.count < 1)
      throw new Error('لا تحتوي النسخة على بيانات ترحيلات قاعدة البيانات.');
    const required = ['users', 'orders', 'order_items', 'payments', 'receipts'];
    const tables = new Set(
      (
        candidate
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((table) => table.name),
    );
    if (required.some((table) => !tables.has(table)))
      throw new Error('تفتقد النسخة جداول أساسية مطلوبة لتشغيل التطبيق.');
    return migrations.count;
  } finally {
    candidate.close();
  }
}

function recordFromFile(directory: string, filename: string) {
  const match =
    /^restaurant-pos-(\d{8}T\d{6}Z)-(daily|manual|pre-restore)-[a-f0-9]{8}\.sqlite$/.exec(
      filename,
    );
  if (!match) return undefined;
  const stamp = match[1]!;
  const createdAt = timestampToIso(stamp);
  return {
    filename,
    kind: match[2] as BackupKind,
    createdAt,
    sizeBytes: fs.statSync(path.join(directory, filename)).size,
  };
}

function timestampToIso(stamp: string) {
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
}

function backupMetadata(
  input: Omit<BackupMetadata, 'version'>,
): BackupMetadata {
  const friendlyName = normalizeFriendlyName(input.friendlyName);
  return {
    ...input,
    ...(friendlyName ? { friendlyName } : {}),
    version: 1,
  };
}

export function normalizeFriendlyName(value: string | undefined) {
  if (!value) return undefined;
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name) return undefined;
  if (Array.from(name).length > 80)
    throw new Error('اسم النسخة الاحتياطية يجب ألا يتجاوز 80 حرفًا.');
  if (
    Array.from(name).some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  )
    throw new Error('اسم النسخة يحتوي على محارف تحكم غير مسموح بها.');
  if (/[\\/:*?"<>|]/u.test(name) || name === '.' || name === '..')
    throw new Error(
      'اسم النسخة لا يمكن أن يحتوي على مسار أو رموز غير مسموح بها.',
    );
  if (/\.$/u.test(name)) throw new Error('اسم النسخة لا يمكن أن ينتهي بنقطة.');
  const base = name.split('.')[0]!.toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base))
    throw new Error('اسم النسخة محجوز في Windows. اختر اسمًا آخر.');
  return name;
}

function metadataFilename(directory: string, filename: string) {
  return path.join(directory, `${filename}.metadata.json`);
}

function writeBackupMetadata(directory: string, metadata: BackupMetadata) {
  const filename = metadataFilename(directory, metadata.filename);
  const temporary = `${filename}.partial`;
  fs.writeFileSync(temporary, `${JSON.stringify(metadata)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  fs.renameSync(temporary, filename);
}

function readBackupMetadata(directory: string, basic: BasicBackupRecord) {
  const fallback = {
    friendlyName: defaultFriendlyName(basic.kind),
    hasCustomName: false,
  };
  const filename = metadataFilename(directory, basic.filename);
  if (!fs.existsSync(filename)) return fallback;
  try {
    const metadata = JSON.parse(
      fs.readFileSync(filename, 'utf8'),
    ) as BackupMetadata;
    if (
      metadata.version !== 1 ||
      metadata.filename !== basic.filename ||
      metadata.kind !== basic.kind ||
      metadata.createdAt !== basic.createdAt
    )
      return fallback;
    const friendlyName = normalizeFriendlyName(metadata.friendlyName);
    return friendlyName ? { friendlyName, hasCustomName: true } : fallback;
  } catch {
    return fallback;
  }
}

function defaultFriendlyName(kind: BackupKind) {
  if (kind === 'daily') return 'نسخة تلقائية';
  if (kind === 'pre-restore') return 'نسخة قبل الاستعادة';
  return 'نسخة يدوية';
}

function retentionDays(value: string | undefined) {
  const parsed = Number(value ?? 30);
  return Number.isInteger(parsed) && parsed >= 7 && parsed <= 365 ? parsed : 30;
}

function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  // Never surface platform paths, native SQLite diagnostics, or permissions
  // details in the operational screen. Keep deliberate Arabic validation
  // messages intact and turn expected operational failures into clear Arabic.
  if (/[؀-ۿ]/u.test(message)) return message;
  if (/ENOSPC|no space|disk full/i.test(message))
    return 'نفدت مساحة التخزين أثناء النسخ التلقائي. حرر مساحة ثم راجع سجل النسخ.';
  if (/EACCES|EPERM|permission denied/i.test(message))
    return 'لا يملك التطبيق صلاحية الكتابة في مجلد النسخ الاحتياطي.';
  if (/SQLITE_BUSY|database is locked|busy/i.test(message))
    return 'قاعدة البيانات مشغولة الآن؛ سيعاد فحص النسخ التلقائي لاحقًا.';
  return 'تعذر إنشاء النسخة الاحتياطية التلقائية. راجع سجل التطبيق المحلي.';
}

function arabicValidationMessage(error: unknown) {
  const message = safeMessage(error);
  if (/not a database|file is not a database/i.test(message))
    return 'الملف تالف أو ليس قاعدة بيانات SQLite صالحة.';
  if (/no such table.*__drizzle_migrations/i.test(message))
    return 'الملف لا يحتوي على سجل ترحيلات التطبيق، لذلك لا يمكن التحقق من توافقه.';
  if (/cannot open|not found|does not exist/i.test(message))
    return 'ملف النسخة غير موجود أو لا يمكن قراءته.';
  return message;
}
