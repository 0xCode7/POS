import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, ApiError, errorMessage, type Page, type Receipt } from './api';
import { openReceiptPrintDialog } from './desktop';
import { configureReceiptPrintPage, ReceiptView } from './POSScreen';
import { Notice } from './Notice';

type Range = { start: string; end: string };
type Summary = {
  revenueMinor: number;
  paidOrders: number;
  averageTicketMinor: number;
  cashReceivedMinor: number;
  changeMinor: number;
};
type Daily = { date: string; revenueMinor: number; paidOrders: number };
type TopItem = { name: string; quantity: number; revenueMinor: number };
type Cashier = {
  userId: string;
  displayName: string;
  paidOrders: number;
  revenueMinor: number;
};
type Hour = { hour: number; revenueMinor: number; paidOrders: number };
type ReceiptRow = {
  id: string;
  receiptNumber: string;
  orderNumber: string;
  amountDueMinor: number;
  cashTenderedMinor: number;
  changeMinor: number;
  paidAt: number;
  cashierName: string;
};
const egp = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
});
const money = (minor: number) => egp.format(minor / 100);
const cairoToday = () => {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts();
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const shiftDate = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
const preset = (kind: 'today' | 'yesterday' | 'week' | 'month'): Range => {
  const today = cairoToday();
  const tomorrow = shiftDate(today, 1);
  if (kind === 'yesterday') return { start: shiftDate(today, -1), end: today };
  if (kind === 'week') return { start: shiftDate(today, -6), end: tomorrow };
  if (kind === 'month')
    return { start: `${today.slice(0, 7)}-01`, end: tomorrow };
  return { start: today, end: tomorrow };
};

export function ReportsDashboard({
  onSessionExpired,
}: {
  onSessionExpired: () => void;
}) {
  const [range, setRange] = useState<Range>(() => preset('today'));
  const [summary, setSummary] = useState<Summary>();
  const [days, setDays] = useState<Daily[]>([]);
  const [items, setItems] = useState<TopItem[]>([]);
  const [cashiers, setCashiers] = useState<Cashier[]>([]);
  const [hours, setHours] = useState<Hour[]>([]);
  const [receipts, setReceipts] = useState<Page<ReceiptRow>>();
  const [receipt, setReceipt] = useState<Receipt>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [printError, setPrintError] = useState('');

  const fail = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired();
      else setError(errorMessage(cause));
    },
    [onSessionExpired],
  );

  const load = useCallback(async () => {
    setError('');
    const common = new URLSearchParams({
      start: range.start,
      end: range.end,
      timezone: 'Africa/Cairo',
    });
    const receiptParams = new URLSearchParams(common);
    receiptParams.set('page', String(page));
    receiptParams.set('limit', '10');
    if (search.trim()) receiptParams.set('search', search.trim());
    try {
      const [
        summaryData,
        dailyData,
        itemData,
        cashierData,
        hourlyData,
        receiptData,
      ] = await Promise.all([
        api<Summary>(`/api/admin/reports/summary?${common}`),
        api<{ days: Daily[] }>(`/api/admin/reports/daily?${common}`),
        api<{ items: TopItem[] }>(`/api/admin/reports/top-items?${common}`),
        api<{ cashiers: Cashier[] }>(`/api/admin/reports/by-cashier?${common}`),
        api<{ hours: Hour[] }>(`/api/admin/reports/hourly?${common}`),
        api<Page<ReceiptRow>>(`/api/admin/reports/receipts?${receiptParams}`),
      ]);
      setSummary(summaryData);
      setDays(dailyData.days);
      setItems(itemData.items);
      setCashiers(cashierData.cashiers);
      setHours(hourlyData.hours);
      setReceipts(receiptData);
    } catch (cause) {
      fail(cause);
    } finally {
      setLoading(false);
    }
  }, [fail, page, range, search]);

  useEffect(() => {
    // Report state is synchronized with the local API after filters change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useEffect(() => {
    const reload = () => void load();
    window.addEventListener('pos:sale-completed', reload);
    return () => window.removeEventListener('pos:sale-completed', reload);
  }, [load]);
  useEffect(() => {
    if (!receipt) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setReceipt(undefined);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [receipt]);

  const choose = (kind: 'today' | 'yesterday' | 'week' | 'month') => {
    setPage(1);
    setRange(preset(kind));
  };
  const custom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPage(1);
    setRange({
      start: String(data.get('start')),
      end: String(data.get('end')),
    });
  };
  const openReceipt = async (id: string) => {
    try {
      setReceipt(
        (await api<{ receipt: Receipt }>(`/api/receipts/${id}`)).receipt,
      );
      setPrintError('');
    } catch (cause) {
      fail(cause);
    }
  };
  const print = async () => {
    if (!receipt) return;
    try {
      configureReceiptPrintPage();
      await openReceiptPrintDialog();
      await api(`/api/receipts/${receipt.id}/print-attempts`, {
        method: 'POST',
        body: JSON.stringify({ outcome: 'DIALOG_OPENED' }),
      });
      setPrintError('');
    } catch (cause) {
      const text = errorMessage(cause);
      setPrintError(text);
      try {
        await api(`/api/receipts/${receipt.id}/print-attempts`, {
          method: 'POST',
          body: JSON.stringify({ outcome: 'ERROR', errorMessage: text }),
        });
      } catch {
        // The visible error is retained even if logging the attempt also fails.
      }
    }
  };
  const maxDaily = Math.max(1, ...days.map((day) => day.revenueMinor));
  const activeHours = hours.filter((hour) => hour.paidOrders > 0);

  return (
    <section className="reports-screen">
      <div className="title-row">
        <div>
          <p className="eyebrow">لوحة الإدارة · توقيت القاهرة</p>
          <h1>تقارير المبيعات</h1>
          <p className="muted">
            الإيراد مبني على الدفعات النقدية المكتملة فقط.
          </p>
        </div>
      </div>
      <div className="report-presets">
        <button onClick={() => choose('today')}>اليوم</button>
        <button className="secondary" onClick={() => choose('yesterday')}>
          أمس
        </button>
        <button className="secondary" onClick={() => choose('week')}>
          آخر 7 أيام
        </button>
        <button className="secondary" onClick={() => choose('month')}>
          هذا الشهر
        </button>
      </div>
      <form
        className="report-filter"
        key={`${range.start}-${range.end}`}
        onSubmit={custom}
      >
        <label>
          من (شامل)
          <input name="start" type="date" defaultValue={range.start} required />
        </label>
        <label>
          إلى (غير شامل)
          <input name="end" type="date" defaultValue={range.end} required />
        </label>
        <button>تطبيق</button>
      </form>
      {error && (
        <Notice message={error} tone="error" onDismiss={() => setError('')} />
      )}
      {loading ? (
        <div className="empty-state">جارٍ تحميل التقارير…</div>
      ) : (
        summary && (
          <>
            <div className="kpi-grid">
              <Kpi
                label="إجمالي المبيعات"
                value={money(summary.revenueMinor)}
              />
              <Kpi
                label="الطلبات المدفوعة"
                value={String(summary.paidOrders)}
              />
              <Kpi
                label="متوسط الفاتورة"
                value={money(summary.averageTicketMinor)}
              />
              <Kpi
                label="النقد المستلم"
                value={money(summary.cashReceivedMinor)}
                note={`الباقي: ${money(summary.changeMinor)}`}
              />
            </div>
            <div className="report-grid">
              <section className="panel report-wide">
                <h2>المبيعات اليومية</h2>
                {days.every((day) => day.paidOrders === 0) ? (
                  <Empty />
                ) : (
                  <div className="bar-chart">
                    {days.map((day) => (
                      <div
                        key={day.date}
                        title={`${day.date}: ${money(day.revenueMinor)}`}
                      >
                        <span
                          style={{
                            height: `${Math.max(3, (day.revenueMinor / maxDaily) * 100)}%`,
                          }}
                        />
                        <small>{day.date.slice(5)}</small>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <ReportList
                title="الأصناف الأكثر مبيعاً"
                empty={items.length === 0}
                rows={items.map((item) => ({
                  key: item.name,
                  name: item.name,
                  detail: `${item.quantity} وحدة`,
                  value: money(item.revenueMinor),
                }))}
              />
              <ReportList
                title="المبيعات حسب الكاشير"
                empty={cashiers.length === 0}
                rows={cashiers.map((row) => ({
                  key: row.userId,
                  name: row.displayName,
                  detail: `${row.paidOrders} طلب`,
                  value: money(row.revenueMinor),
                }))}
              />
              <ReportList
                title="التوزيع حسب الساعة"
                empty={activeHours.length === 0}
                rows={activeHours.map((row) => ({
                  key: String(row.hour),
                  name: `${String(row.hour).padStart(2, '0')}:00`,
                  detail: `${row.paidOrders} طلب`,
                  value: money(row.revenueMinor),
                }))}
              />
            </div>
            <section className="panel receipt-history">
              <div className="panel-heading">
                <h2>سجل الإيصالات</h2>
                <span>{receipts?.pagination.total ?? 0} إيصال</span>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  setPage(1);
                  void load();
                }}
              >
                <input
                  aria-label="بحث الإيصالات"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="رقم الإيصال أو الطلب"
                />
              </form>
              {!receipts?.items.length ? (
                <Empty />
              ) : (
                receipts.items.map((row) => (
                  <article key={row.id}>
                    <div>
                      <b>{row.receiptNumber}</b>
                      <small>
                        {row.orderNumber} · {row.cashierName}
                      </small>
                    </div>
                    <div>
                      <b>{money(row.amountDueMinor)}</b>
                      <small>
                        {new Date(row.paidAt).toLocaleString('ar-EG', {
                          timeZone: 'Africa/Cairo',
                        })}
                      </small>
                    </div>
                    <button
                      className="secondary"
                      onClick={() => void openReceipt(row.id)}
                    >
                      عرض / إعادة طباعة
                    </button>
                  </article>
                ))
              )}
              {receipts && receipts.pagination.pages > 1 && (
                <div className="pagination">
                  <button
                    className="secondary"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    السابق
                  </button>
                  <span>
                    {page} / {receipts.pagination.pages}
                  </span>
                  <button
                    className="secondary"
                    disabled={page >= receipts.pagination.pages}
                    onClick={() => setPage(page + 1)}
                  >
                    التالي
                  </button>
                </div>
              )}
            </section>
            {receipt && (
              <div
                className="receipt-modal"
                role="dialog"
                aria-modal="true"
                aria-label="تفاصيل الإيصال"
              >
                <div className="receipt-80">
                  <ReceiptView receipt={receipt} />
                  <div className="receipt-actions no-print">
                    {printError && <p className="form-error">{printError}</p>}
                    <button onClick={() => void print()}>إعادة طباعة</button>
                    <button
                      className="secondary"
                      autoFocus
                      onClick={() => setReceipt(undefined)}
                    >
                      إغلاق
                    </button>
                    <small>فتح نافذة الطباعة لا يؤكد خروج ورقة فعلية.</small>
                  </div>
                </div>
              </div>
            )}
          </>
        )
      )}
    </section>
  );
}

function Kpi({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <article className="kpi">
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </article>
  );
}
function Empty() {
  return <p className="report-empty">لا توجد مبيعات في الفترة المحددة.</p>;
}
function ReportList({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: boolean;
  rows: Array<{ key: string; name: string; detail: string; value: string }>;
}) {
  return (
    <section className="panel report-list">
      <h2>{title}</h2>
      {empty ? (
        <Empty />
      ) : (
        rows.map((row) => (
          <article key={row.key}>
            <div>
              <b>{row.name}</b>
              <small>{row.detail}</small>
            </div>
            <strong>{row.value}</strong>
          </article>
        ))
      )}
    </section>
  );
}
