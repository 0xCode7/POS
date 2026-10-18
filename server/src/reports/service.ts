import { DateTime } from 'luxon';
import { z } from 'zod';
import type { AppDatabase } from '../db/database.js';
import { OrderError } from '../orders/service.js';

export const DEFAULT_REPORT_TIMEZONE = 'Africa/Cairo';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const rangeSchema = z.object({
  start: z.string().regex(datePattern).optional(),
  end: z.string().regex(datePattern).optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
});

export type ReportRange = ReturnType<typeof parseReportRange>;

export function parseReportRange(query: unknown) {
  const parsed = rangeSchema.safeParse(query);
  if (!parsed.success) throw validation('Date filters must use YYYY-MM-DD.');
  const timezone = parsed.data.timezone ?? DEFAULT_REPORT_TIMEZONE;
  const now = DateTime.now().setZone(timezone);
  if (!now.isValid) throw validation('The selected timezone is invalid.');
  const defaultStart = now.startOf('day');
  const start = parsed.data.start
    ? DateTime.fromISO(parsed.data.start, { zone: timezone })
    : defaultStart;
  const end = parsed.data.end
    ? DateTime.fromISO(parsed.data.end, { zone: timezone })
    : defaultStart.plus({ days: 1 });
  if (!start.isValid || !end.isValid) throw validation('Invalid date range.');
  if (end <= start) throw validation('End date must be after start date.');
  if (end.diff(start, 'days').days > 366)
    throw validation('Date range cannot exceed 366 days.');
  return {
    startDate: start.toISODate()!,
    endDate: end.toISODate()!,
    timezone,
    startMs: start.toUTC().toMillis(),
    endMs: end.toUTC().toMillis(),
  };
}

type TotalRow = {
  revenueMinor: number | null;
  paidOrders: number;
  cashReceivedMinor: number | null;
  changeMinor: number | null;
};

export class ReportService {
  constructor(private readonly database: AppDatabase) {}

  summary(range: ReportRange) {
    const row = this.database.sqlite
      .prepare(
        `SELECT COALESCE(SUM(p.amount_due_minor), 0) AS revenueMinor,
                COUNT(*) AS paidOrders,
                COALESCE(SUM(p.cash_tendered_minor), 0) AS cashReceivedMinor,
                COALESCE(SUM(p.change_minor), 0) AS changeMinor
           FROM payments p
           JOIN orders o ON o.id = p.order_id AND o.status = 'PAID'
          WHERE p.created_at >= ? AND p.created_at < ?`,
      )
      .get(range.startMs, range.endMs) as TotalRow;
    const revenueMinor = Number(row.revenueMinor ?? 0);
    const paidOrders = Number(row.paidOrders);
    return {
      range: publicRange(range),
      revenueMinor,
      paidOrders,
      averageTicketMinor:
        paidOrders === 0 ? 0 : Math.round(revenueMinor / paidOrders),
      cashReceivedMinor: Number(row.cashReceivedMinor ?? 0),
      changeMinor: Number(row.changeMinor ?? 0),
    };
  }

  daily(range: ReportRange) {
    const payments = this.paymentRows(range);
    const grouped = new Map<
      string,
      { revenueMinor: number; paidOrders: number }
    >();
    let cursor = DateTime.fromISO(range.startDate, { zone: range.timezone });
    const end = DateTime.fromISO(range.endDate, { zone: range.timezone });
    while (cursor < end) {
      grouped.set(cursor.toISODate()!, { revenueMinor: 0, paidOrders: 0 });
      cursor = cursor.plus({ days: 1 });
    }
    for (const payment of payments) {
      const date = DateTime.fromMillis(payment.createdAt, { zone: 'utc' })
        .setZone(range.timezone)
        .toISODate()!;
      const value = grouped.get(date);
      if (value) {
        value.revenueMinor += payment.amountDueMinor;
        value.paidOrders += 1;
      }
    }
    return {
      range: publicRange(range),
      days: [...grouped].map(([date, value]) => ({
        date,
        ...value,
        averageTicketMinor:
          value.paidOrders === 0
            ? 0
            : Math.round(value.revenueMinor / value.paidOrders),
      })),
    };
  }

  hourly(range: ReportRange) {
    const hours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      revenueMinor: 0,
      paidOrders: 0,
    }));
    for (const payment of this.paymentRows(range)) {
      const hour = DateTime.fromMillis(payment.createdAt, {
        zone: 'utc',
      }).setZone(range.timezone).hour;
      hours[hour]!.revenueMinor += payment.amountDueMinor;
      hours[hour]!.paidOrders += 1;
    }
    return { range: publicRange(range), hours };
  }

  topItems(range: ReportRange, limit: number) {
    const items = this.database.sqlite
      .prepare(
        `SELECT oi.item_name_snapshot AS name,
                SUM(oi.quantity) AS quantity,
                SUM(oi.unit_price_minor * oi.quantity) AS revenueMinor
           FROM payments p
           JOIN orders o ON o.id = p.order_id AND o.status = 'PAID'
           JOIN order_items oi ON oi.order_id = o.id
          WHERE p.created_at >= ? AND p.created_at < ?
          GROUP BY oi.item_name_snapshot
          ORDER BY quantity DESC, revenueMinor DESC, name ASC
          LIMIT ?`,
      )
      .all(range.startMs, range.endMs, limit);
    return { range: publicRange(range), items };
  }

  byCashier(range: ReportRange) {
    const cashiers = this.database.sqlite
      .prepare(
        `SELECT u.id AS userId, u.display_name AS displayName,
                COUNT(*) AS paidOrders,
                SUM(p.amount_due_minor) AS revenueMinor
           FROM payments p
           JOIN orders o ON o.id = p.order_id AND o.status = 'PAID'
           JOIN users u ON u.id = p.processed_by_user_id
          WHERE p.created_at >= ? AND p.created_at < ?
          GROUP BY u.id, u.display_name
          ORDER BY revenueMinor DESC, displayName ASC`,
      )
      .all(range.startMs, range.endMs);
    return { range: publicRange(range), cashiers };
  }

  receipts(
    range: ReportRange,
    input: { page: number; limit: number; search: string },
  ) {
    const search = `%${escapeLike(input.search)}%`;
    const filter = `p.created_at >= ? AND p.created_at < ?
      AND (? = '%%' OR r.receipt_number LIKE ? ESCAPE '\\'
        OR o.order_number LIKE ? ESCAPE '\\')`;
    const params = [range.startMs, range.endMs, search, search, search];
    const total = Number(
      (
        this.database.sqlite
          .prepare(
            `SELECT COUNT(*) AS total FROM receipts r
             JOIN payments p ON p.id = r.payment_id
             JOIN orders o ON o.id = p.order_id AND o.status = 'PAID'
             WHERE ${filter}`,
          )
          .get(...params) as { total: number }
      ).total,
    );
    const items = this.database.sqlite
      .prepare(
        `SELECT r.id, r.receipt_number AS receiptNumber,
                o.id AS orderId, o.order_number AS orderNumber,
                p.amount_due_minor AS amountDueMinor,
                p.cash_tendered_minor AS cashTenderedMinor,
                p.change_minor AS changeMinor,
                p.created_at AS paidAt,
                u.id AS cashierId, u.display_name AS cashierName
           FROM receipts r
           JOIN payments p ON p.id = r.payment_id
           JOIN orders o ON o.id = p.order_id AND o.status = 'PAID'
           JOIN users u ON u.id = p.processed_by_user_id
          WHERE ${filter}
          ORDER BY p.created_at DESC, r.id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(...params, input.limit, (input.page - 1) * input.limit);
    return {
      range: publicRange(range),
      items,
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        pages: Math.ceil(total / input.limit),
      },
    };
  }

  private paymentRows(range: ReportRange) {
    return this.database.sqlite
      .prepare(
        `SELECT p.amount_due_minor AS amountDueMinor, p.created_at AS createdAt
           FROM payments p
           JOIN orders o ON o.id = p.order_id AND o.status = 'PAID'
          WHERE p.created_at >= ? AND p.created_at < ?
          ORDER BY p.created_at ASC`,
      )
      .all(range.startMs, range.endMs) as Array<{
      amountDueMinor: number;
      createdAt: number;
    }>;
  }
}

function publicRange(range: ReportRange) {
  return {
    start: range.startDate,
    end: range.endDate,
    timezone: range.timezone,
  };
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function validation(message: string) {
  return new OrderError(400, 'VALIDATION_ERROR', message);
}
