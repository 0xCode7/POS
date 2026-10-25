import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { AppDatabase } from '../db/database.js';
import { DEFAULT_REPORT_TIMEZONE } from '../reports/service.js';

export type PurchaseInput = {
  name: string;
  quantityMilli: number;
  unit?: string | null;
  unitPriceMinor: number;
  purchaseDate: string;
};

export type PurchaseFilters = {
  search: string;
  day?: string;
  month?: string;
  page: number;
  limit: number;
};

type PurchaseRow = {
  id: string;
  name: string;
  quantityMilli: number;
  unit: string | null;
  unitPriceMinor: number;
  totalMinor: number;
  purchaseDate: string;
  createdAt: number;
  updatedAt: number;
};

export class PurchaseService {
  constructor(private readonly database: AppDatabase) {}

  list(filters: PurchaseFilters) {
    const { where, params } = activeWhere(filters);
    const total = Number(
      (
        this.database.sqlite
          .prepare(`SELECT COUNT(*) AS total FROM purchases ${where}`)
          .get(...params) as { total: number }
      ).total,
    );
    const items = this.database.sqlite
      .prepare(
        `SELECT id, name, quantity_milli AS quantityMilli, unit,
                unit_price_minor AS unitPriceMinor, total_minor AS totalMinor,
                purchase_date AS purchaseDate, created_at AS createdAt,
                updated_at AS updatedAt
           FROM purchases ${where}
          ORDER BY purchase_date DESC, created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(
        ...params,
        filters.limit,
        (filters.page - 1) * filters.limit,
      ) as PurchaseRow[];
    return {
      items,
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        pages: Math.ceil(total / filters.limit),
      },
    };
  }

  summary(filters: Omit<PurchaseFilters, 'page' | 'limit'>) {
    const now = DateTime.now().setZone(DEFAULT_REPORT_TIMEZONE);
    const today = now.toISODate()!;
    const month = now.toFormat('yyyy-LL');
    return {
      todayMinor: this.totalFor({ search: '', day: today }),
      monthMinor: this.totalFor({ search: '', month }),
      selectedPeriodMinor: this.totalFor(filters),
    };
  }

  create(input: PurchaseInput, actorUserId: string) {
    const now = Date.now();
    const purchase = {
      id: randomUUID(),
      name: normalizeName(input.name),
      quantityMilli: input.quantityMilli,
      unit: normalizeUnit(input.unit),
      unitPriceMinor: input.unitPriceMinor,
      totalMinor: calculateTotal(input.quantityMilli, input.unitPriceMinor),
      purchaseDate: input.purchaseDate,
      createdAt: now,
      updatedAt: now,
    };
    this.database.sqlite.transaction(() => {
      this.database.sqlite
        .prepare(
          `INSERT INTO purchases
              (id, name, quantity_milli, unit, unit_price_minor, total_minor,
               purchase_date, created_by_user_id, updated_by_user_id,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          purchase.id,
          purchase.name,
          purchase.quantityMilli,
          purchase.unit,
          purchase.unitPriceMinor,
          purchase.totalMinor,
          purchase.purchaseDate,
          actorUserId,
          actorUserId,
          purchase.createdAt,
          purchase.updatedAt,
        );
    })();
    return purchase;
  }

  update(id: string, input: PurchaseInput, actorUserId: string) {
    this.requireActive(id);
    const now = Date.now();
    const updated = {
      id,
      name: normalizeName(input.name),
      quantityMilli: input.quantityMilli,
      unit: normalizeUnit(input.unit),
      unitPriceMinor: input.unitPriceMinor,
      totalMinor: calculateTotal(input.quantityMilli, input.unitPriceMinor),
      purchaseDate: input.purchaseDate,
      updatedAt: now,
    };
    this.database.sqlite.transaction(() => {
      const result = this.database.sqlite
        .prepare(
          `UPDATE purchases
                SET name = ?, quantity_milli = ?, unit = ?, unit_price_minor = ?,
                    total_minor = ?, purchase_date = ?, updated_by_user_id = ?,
                    updated_at = ?
              WHERE id = ? AND deleted_at IS NULL`,
        )
        .run(
          updated.name,
          updated.quantityMilli,
          updated.unit,
          updated.unitPriceMinor,
          updated.totalMinor,
          updated.purchaseDate,
          actorUserId,
          updated.updatedAt,
          id,
        );
      if (result.changes !== 1) this.notFound();
    })();
    return updated;
  }

  remove(id: string, actorUserId: string) {
    const now = Date.now();
    const result = this.database.sqlite
      .prepare(
        `UPDATE purchases
            SET deleted_at = ?, deleted_by_user_id = ?, updated_by_user_id = ?,
                updated_at = ?
          WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(now, actorUserId, actorUserId, now, id);
    if (result.changes !== 1) this.notFound();
  }

  private totalFor(filters: { search: string; day?: string; month?: string }) {
    const { where, params } = activeWhere(filters);
    return Number(
      (
        this.database.sqlite
          .prepare(
            `SELECT COALESCE(SUM(total_minor), 0) AS totalMinor FROM purchases ${where}`,
          )
          .get(...params) as { totalMinor: number }
      ).totalMinor,
    );
  }

  private requireActive(id: string) {
    const row = this.database.sqlite
      .prepare('SELECT id FROM purchases WHERE id = ? AND deleted_at IS NULL')
      .get(id);
    if (!row) this.notFound();
  }

  private notFound(): never {
    throw new PurchaseError(
      404,
      'PURCHASE_NOT_FOUND',
      'سجل المشتريات غير موجود أو تم حذفه.',
    );
  }
}

function activeWhere(filters: {
  search: string;
  day?: string;
  month?: string;
}) {
  const clauses = ['deleted_at IS NULL'];
  const params: string[] = [];
  if (filters.search) {
    clauses.push("name LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(filters.search)}%`);
  }
  if (filters.day) {
    clauses.push('purchase_date = ?');
    params.push(filters.day);
  } else if (filters.month) {
    clauses.push('purchase_date >= ? AND purchase_date < ?');
    params.push(`${filters.month}-01`, nextMonth(filters.month));
  }
  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

function nextMonth(month: string) {
  return (
    DateTime.fromFormat(month, 'yyyy-LL', {
      zone: DEFAULT_REPORT_TIMEZONE,
    })
      .plus({ months: 1 })
      .toFormat('yyyy-LL') + '-01'
  );
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function normalizeName(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeUnit(value: string | null | undefined) {
  const normalized = value?.trim().replace(/\s+/g, ' ');
  return normalized || null;
}

export function calculateTotal(quantityMilli: number, unitPriceMinor: number) {
  // The persisted amount is always a whole piaster; round once, server-side.
  return Math.round((quantityMilli * unitPriceMinor) / 1_000);
}

export class PurchaseError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
