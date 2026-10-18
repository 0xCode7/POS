import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  errorMessage,
  type Order,
  type Page,
  type Receipt,
} from './api';
import { configureReceiptPrintPage, ReceiptView } from './POSScreen';

type AdminOrder = Order & {
  createdAt: string;
  cancelledAt: string | null;
  createdByDisplayName: string;
  cancelledByDisplayName: string | null;
  receiptId: string | null;
  receiptNumber: string | null;
};

const egp = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
});
const dateTime = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Cairo',
});
const statusText = { OPEN: 'مفتوح', PAID: 'مكتمل', CANCELLED: 'ملغي' };

export function OrdersScreen({
  onSessionExpired,
}: {
  onSessionExpired: () => void;
}) {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<never>>();
  const [orders, setOrders] = useState<AdminOrder[]>([]);
  const [selected, setSelected] = useState<AdminOrder>();
  const [receipt, setReceipt] = useState<Receipt>();
  const [printError, setPrintError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (status) params.set('status', status);
    if (search.trim()) params.set('search', search.trim());
    try {
      const data = await api<{
        orders: AdminOrder[];
        pagination: Page<never>['pagination'];
      }>(`/api/admin/orders?${params}`);
      setOrders(data.orders);
      setResult({ items: [], pagination: data.pagination });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired();
      else setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [onSessionExpired, page, search, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setReceipt(undefined);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);

  const inspect = async (id: string) => {
    setError('');
    try {
      const response = await api<{ order: AdminOrder }>(
        `/api/admin/orders/${id}`,
      );
      setSelected(response.order);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired();
      else setError(errorMessage(cause));
    }
  };

  const openReceipt = async (id: string) => {
    try {
      setReceipt(
        (await api<{ receipt: Receipt }>(`/api/receipts/${id}`)).receipt,
      );
      setPrintError('');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired();
      else setError(errorMessage(cause));
    }
  };

  const print = async () => {
    if (!receipt) return;
    try {
      configureReceiptPrintPage();
      window.print();
      await api(`/api/receipts/${receipt.id}/print-attempts`, {
        method: 'POST',
        body: JSON.stringify({ outcome: 'DIALOG_OPENED' }),
      });
      setPrintError('');
    } catch (cause) {
      const detail = errorMessage(cause);
      setPrintError(`تعذرت الطباعة: ${detail}`);
      try {
        await api(`/api/receipts/${receipt.id}/print-attempts`, {
          method: 'POST',
          body: JSON.stringify({ outcome: 'ERROR', errorMessage: detail }),
        });
      } catch {
        // The payment remains final even when attempt logging fails.
      }
    }
  };

  return (
    <section className="orders-screen">
      <div className="title-row">
        <div>
          <p className="eyebrow">إدارة التشغيل</p>
          <h1>سجل الطلبات</h1>
          <p>راجع الطلبات وحالاتها وتفاصيل الإلغاء في مكان مستقل.</p>
        </div>
      </div>

      <div className="order-history-filters panel">
        <label>
          بحث برقم الطلب
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="ORD-000001"
          />
        </label>
        <label>
          حالة الطلب
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">كل الحالات</option>
            <option value="OPEN">مفتوح</option>
            <option value="PAID">مكتمل</option>
            <option value="CANCELLED">ملغي</option>
          </select>
        </label>
        <button className="secondary" onClick={() => void load()}>
          تحديث
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}
      <div className="order-history-layout">
        <section className="panel order-history-list">
          <div className="panel-heading">
            <h2>الطلبات</h2>
            <span>{result?.pagination.total ?? 0} طلب</span>
          </div>
          {loading ? (
            <div className="empty-state">جارٍ تحميل الطلبات…</div>
          ) : orders.length === 0 ? (
            <div className="empty-state">لا توجد طلبات مطابقة.</div>
          ) : (
            <div className="order-history-rows">
              {orders.map((order) => (
                <button
                  key={order.id}
                  className={selected?.id === order.id ? 'selected' : ''}
                  onClick={() => void inspect(order.id)}
                >
                  <span>
                    <b dir="ltr">{order.orderNumber}</b>
                    <small>{dateTime.format(new Date(order.createdAt))}</small>
                  </span>
                  <span>
                    <strong>{egp.format(order.totalMinor / 100)}</strong>
                    <i className={`order-status ${order.status.toLowerCase()}`}>
                      {statusText[order.status]}
                    </i>
                  </span>
                </button>
              ))}
            </div>
          )}
          {(result?.pagination.pages ?? 0) > 1 && (
            <div className="pagination">
              <button
                className="secondary"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                السابق
              </button>
              <span>
                صفحة {page} من {result?.pagination.pages}
              </span>
              <button
                className="secondary"
                disabled={page >= (result?.pagination.pages ?? 1)}
                onClick={() => setPage((value) => value + 1)}
              >
                التالي
              </button>
            </div>
          )}
        </section>

        <aside className="panel order-history-detail">
          {!selected ? (
            <div className="empty-state">
              <b>تفاصيل الطلب</b>
              <span>اختر طلبًا من القائمة لعرض التفاصيل.</span>
            </div>
          ) : (
            <>
              <div className="panel-heading">
                <div>
                  <small>رقم الطلب</small>
                  <h2 dir="ltr">{selected.orderNumber}</h2>
                </div>
                <i className={`order-status ${selected.status.toLowerCase()}`}>
                  {statusText[selected.status]}
                </i>
              </div>
              <dl className="order-meta">
                <div>
                  <dt>أنشأه</dt>
                  <dd>{selected.createdByDisplayName}</dd>
                </div>
                <div>
                  <dt>وقت الإنشاء</dt>
                  <dd>{dateTime.format(new Date(selected.createdAt))}</dd>
                </div>
              </dl>
              {selected.status === 'CANCELLED' && (
                <div className="cancellation-detail">
                  <strong>تفاصيل الإلغاء</strong>
                  <p>{selected.cancellationReason}</p>
                  <small>
                    ألغاه {selected.cancelledByDisplayName}
                    {selected.cancelledAt
                      ? ` · ${dateTime.format(new Date(selected.cancelledAt))}`
                      : ''}
                  </small>
                </div>
              )}
              <div className="history-items">
                <h3>الأصناف</h3>
                {selected.items.length === 0 ? (
                  <p className="muted">لا توجد أصناف.</p>
                ) : (
                  selected.items.map((item) => (
                    <div key={item.id}>
                      <span>
                        <b>{item.itemNameSnapshot}</b>
                        <small>
                          {item.quantity} ×{' '}
                          {egp.format(item.unitPriceMinor / 100)}
                        </small>
                      </span>
                      <strong>{egp.format(item.lineTotalMinor / 100)}</strong>
                    </div>
                  ))
                )}
              </div>
              <div className="history-total">
                <span>الإجمالي</span>
                <strong>{egp.format(selected.totalMinor / 100)}</strong>
              </div>
              {selected.status === 'PAID' && selected.receiptId && (
                <button
                  className="history-receipt-button"
                  onClick={() => void openReceipt(selected.receiptId!)}
                >
                  عرض وطباعة الإيصال
                </button>
              )}
            </>
          )}
        </aside>
      </div>
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
              <button onClick={() => void print()}>طباعة الإيصال</button>
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
    </section>
  );
}
