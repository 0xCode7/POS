import type Database from 'better-sqlite3';

export type MigrationSignature = { hash: string; createdAt: number };

export function migrationSignatures(
  database: Database.Database,
): MigrationSignature[] {
  return database
    .prepare(
      'SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at, hash',
    )
    .all() as MigrationSignature[];
}

export function migrationCompatibility(
  candidate: MigrationSignature[],
  current: MigrationSignature[],
) {
  if (candidate.length > current.length)
    return {
      compatible: false as const,
      pendingMigrations: 0,
      message:
        'النسخة أُنشئت بإصدار أحدث من التطبيق الحالي، لذلك لا يمكن استعادتها بأمان.',
    };

  const diverged = candidate.some(
    (migration, index) =>
      migration.hash !== current[index]?.hash ||
      migration.createdAt !== current[index]?.createdAt,
  );
  if (diverged)
    return {
      compatible: false as const,
      pendingMigrations: 0,
      message:
        'سجل ترحيلات قاعدة البيانات مختلف عن هذا الإصدار من التطبيق. لم تُعتبر النسخة قابلة للاستعادة.',
    };

  const pendingMigrations = current.length - candidate.length;
  return {
    compatible: true as const,
    pendingMigrations,
    message:
      pendingMigrations === 0
        ? 'متوافقة مع إصدار التطبيق الحالي.'
        : `متوافقة مع التطبيق، وتحتاج إلى تطبيق ${pendingMigrations} ترحيل أثناء الاستعادة الآمنة.`,
  };
}
