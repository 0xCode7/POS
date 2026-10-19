import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  errorMessage,
  type MenuCategory,
  type MenuItem,
  type Order,
  type Receipt,
  type User,
} from './api';
import { openReceiptPrintDialog } from './desktop';
import { Notice } from './Notice';
import { useSiteDialog } from './SiteDialog';

const egp = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
});
const operationKey = () => crypto.randomUUID();

export function configureReceiptPrintPage() {
  const receipts = [
    ...document.querySelectorAll<HTMLElement>('.thermal-receipt'),
  ];
  const visibleReceipt = receipts.find(
    (element) => !element.closest<HTMLElement>('.view-panel')?.hidden,
  );
  if (!visibleReceipt) return;
  const width = visibleReceipt.closest('.receipt-58') ? 58 : 80;
  const height = Math.max(
    50,
    Math.ceil((visibleReceipt.scrollHeight * 25.4) / 96 + 8),
  );
  let style = document.querySelector<HTMLStyleElement>('#receipt-page-size');
  if (!style) {
    style = document.createElement('style');
    style.id = 'receipt-page-size';
    document.head.append(style);
  }
  style.textContent = `@media print { @page { size: ${width}mm ${height}mm; margin: 0; } }`;
}

export function POSScreen({
  user,
  onSessionExpired,
}: {
  user: User;
  onSessionExpired: () => void;
}) {
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [search, setSearch] = useState('');
  const [order, setOrder] = useState<Order>();
  const [receipt, setReceipt] = useState<Receipt>();
  const [cash, setCash] = useState('');
  const [paperWidth, setPaperWidth] = useState<'80' | '58'>('80');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const automaticPrintReceiptId = useRef('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { ask, dialog } = useSiteDialog();
  const fail = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired();
      else if (cause instanceof ApiError && cause.status === 409)
        setError(`${cause.message} حدّث الطلب وحاول مرة أخرى.`);
      else setError(errorMessage(cause));
    },
    [onSessionExpired],
  );
  const loadMenu = useCallback(async () => {
    const params = new URLSearchParams({ limit: '100' });
    if (categoryId) params.set('categoryId', categoryId);
    if (search.trim()) params.set('search', search.trim());
    try {
      const [categoryResult, itemResult] = await Promise.all([
        api<{ categories: MenuCategory[] }>('/api/menu/categories'),
        api<{ items: MenuItem[] }>(`/api/menu/items?${params}`),
      ]);
      setCategories(categoryResult.categories);
      setItems(itemResult.items);
    } catch (cause) {
      fail(cause);
    } finally {
      setLoading(false);
    }
  }, [categoryId, fail, search]);
  const loadOrders = useCallback(async () => {
    try {
      setOrders(
        (await api<{ orders: Order[] }>('/api/orders?status=OPEN&limit=50'))
          .orders,
      );
    } catch (cause) {
      fail(cause);
    }
  }, [fail]);
  useEffect(() => {
    // Fetching server-owned menu state is the synchronization performed here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadMenu();
  }, [loadMenu]);
  useEffect(() => {
    // Fetching server-owned order state is the synchronization performed here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadOrders();
  }, [loadOrders]);
  useEffect(() => {
    const reload = () => void loadMenu();
    window.addEventListener('pos:menu-updated', reload);
    return () => window.removeEventListener('pos:menu-updated', reload);
  }, [loadMenu]);
  const refreshOrder = async (id: string) => {
    const value = (await api<{ order: Order }>(`/api/orders/${id}`)).order;
    setOrder(value);
    await loadOrders();
    return value;
  };
  const createOrder = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const value = (
        await api<{ order: Order }>('/api/orders', {
          method: 'POST',
          headers: { 'Idempotency-Key': operationKey() },
        })
      ).order;
      setOrder(value);
      setReceipt(undefined);
      setCash('');
      setNotice(`تم إنشاء الطلب ${value.orderNumber}.`);
      await loadOrders();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }, [busy, fail, loadOrders]);
  const add = async (item: MenuItem) => {
    if (!order) {
      setError('أنشئ طلباً جديداً أولاً.');
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const value = (
        await api<{ order: Order }>(`/api/orders/${order.id}/items`, {
          method: 'POST',
          headers: { 'Idempotency-Key': operationKey() },
          body: JSON.stringify({
            menuItemId: item.id,
            quantity: 1,
            expectedVersion: order.version,
          }),
        })
      ).order;
      setOrder(value);
      setNotice(`تمت إضافة ${item.name}.`);
      await loadOrders();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const changeQuantity = async (itemId: string, quantity: number) => {
    if (!order || busy) return;
    if (quantity < 1) {
      await remove(itemId);
      return;
    }
    setBusy(true);
    try {
      setOrder(
        (
          await api<{ order: Order }>(
            `/api/orders/${order.id}/items/${itemId}`,
            {
              method: 'PATCH',
              body: JSON.stringify({
                quantity,
                expectedVersion: order.version,
              }),
            },
          )
        ).order,
      );
      await loadOrders();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const editNotes = async (
    itemId: string,
    quantity: number,
    current: string | null,
  ) => {
    if (!order || busy) return;
    const result = await ask({
      title: 'ملاحظات الصنف',
      message: 'أضف تعليمات التحضير الخاصة بهذا الصنف.',
      confirmLabel: 'حفظ الملاحظة',
      fields: [
        {
          name: 'notes',
          label: 'الملاحظات',
          value: current ?? '',
          type: 'textarea',
        },
      ],
    });
    if (!result) return;
    setBusy(true);
    try {
      setOrder(
        (
          await api<{ order: Order }>(
            `/api/orders/${order.id}/items/${itemId}`,
            {
              method: 'PATCH',
              body: JSON.stringify({
                quantity,
                notes: result.notes,
                expectedVersion: order.version,
              }),
            },
          )
        ).order,
      );
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (itemId: string) => {
    if (!order || busy) return;
    if (
      !(await ask({
        title: 'إزالة الصنف',
        message: 'هل تريد إزالة هذا الصنف من الطلب الحالي؟',
        confirmLabel: 'إزالة',
        tone: 'danger',
      }))
    )
      return;
    setBusy(true);
    try {
      setOrder(
        (
          await api<{ order: Order }>(
            `/api/orders/${order.id}/items/${itemId}?expectedVersion=${order.version}`,
            { method: 'DELETE' },
          )
        ).order,
      );
      await loadOrders();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!order || busy) return;
    if (order.items.length === 0) {
      if (
        !(await ask({
          title: `تجاهل الطلب ${order.orderNumber}`,
          message: 'الطلب فارغ وسيتم حذفه من قائمة الطلبات.',
          confirmLabel: 'تجاهل الطلب',
          tone: 'danger',
        }))
      )
        return;
      setBusy(true);
      try {
        await api(`/api/orders/${order.id}?expectedVersion=${order.version}`, {
          method: 'DELETE',
        });
        setOrder(undefined);
        setNotice('تم تجاهل الطلب الفارغ.');
        await loadOrders();
      } catch (cause) {
        fail(cause);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (user.role !== 'admin') return;
    const result = await ask({
      title: `إلغاء الطلب ${order.orderNumber}`,
      message: 'سيتم حفظ سبب الإلغاء في سجل التدقيق ولا يمكن التراجع.',
      confirmLabel: 'تأكيد الإلغاء',
      tone: 'danger',
      fields: [
        {
          name: 'reason',
          label: 'سبب الإلغاء',
          type: 'textarea',
          required: true,
        },
      ],
    });
    const reason = result?.reason.trim();
    if (!reason) return;
    setBusy(true);
    try {
      await api(`/api/orders/${order.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason, expectedVersion: order.version }),
      });
      setOrder(undefined);
      setNotice('تم إلغاء الطلب مع حفظ سجل التدقيق.');
      await loadOrders();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const checkout = async () => {
    if (!order || busy) return;
    const cashTenderedMinor = Math.round(Number(cash) * 100);
    if (!Number.isSafeInteger(cashTenderedMinor) || cashTenderedMinor <= 0) {
      setError('أدخل المبلغ النقدي المستلم بشكل صحيح.');
      return;
    }
    if (
      !(await ask({
        title: 'تأكيد التحصيل النقدي',
        message: `المبلغ المستلم ${egp.format(cashTenderedMinor / 100)}. سيُغلق الطلب ويصدر الإيصال.`,
        confirmLabel: 'تحصيل وإصدار الإيصال',
      }))
    )
      return;
    setBusy(true);
    setError('');
    try {
      const paid = (
        await api<{ receipt: Receipt }>(`/api/orders/${order.id}/checkout`, {
          method: 'POST',
          headers: { 'Idempotency-Key': operationKey() },
          body: JSON.stringify({
            cashTenderedMinor,
            expectedVersion: order.version,
          }),
        })
      ).receipt;
      automaticPrintReceiptId.current = paid.id;
      setReceipt(paid);
      setOrder({ ...order, status: 'PAID', version: order.version + 1 });
      setNotice(
        `تم الدفع. الباقي ${egp.format(paid.snapshot.changeMinor / 100)}.`,
      );
      window.dispatchEvent(new Event('pos:sale-completed'));
      await loadOrders();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };
  const printReceipt = useCallback(async (target: Receipt) => {
    try {
      configureReceiptPrintPage();
      await openReceiptPrintDialog();
      await api(`/api/receipts/${target.id}/print-attempts`, {
        method: 'POST',
        body: JSON.stringify({ outcome: 'DIALOG_OPENED' }),
      });
      setNotice('تم فتح نافذة الطباعة؛ لا يؤكد ذلك خروج إيصال فعلي.');
    } catch (cause) {
      const detail = errorMessage(cause);
      setError(`تعذر فتح الطباعة: ${detail}`);
      try {
        await api(`/api/receipts/${target.id}/print-attempts`, {
          method: 'POST',
          body: JSON.stringify({ outcome: 'ERROR', errorMessage: detail }),
        });
      } catch {
        /* payment remains final even if logging fails */
      }
    }
  }, []);
  useEffect(() => {
    if (!receipt || automaticPrintReceiptId.current !== receipt.id) return;
    automaticPrintReceiptId.current = '';
    const frame = requestAnimationFrame(() => void printReceipt(receipt));
    return () => cancelAnimationFrame(frame);
  }, [printReceipt, receipt]);
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing =
        target?.matches('input, textarea, select, [contenteditable="true"]') ??
        false;
      if (event.key === '/' && !editing) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if (event.key === 'F2' && !editing && !order && !busy) {
        event.preventDefault();
        void createOrder();
      }
    };
    window.addEventListener('keydown', shortcuts);
    return () => window.removeEventListener('keydown', shortcuts);
  }, [busy, createOrder, order]);

  return (
    <section className="pos-screen">
      <div className="title-row">
        <div>
          <p className="eyebrow">نقطة البيع · طلبات تيك أواي</p>
          <h1>نقطة البيع</h1>
          <p className="muted">اختر الأصناف واحفظ الطلب المفتوح.</p>
        </div>
        {order && (
          <button disabled={busy} onClick={() => void createOrder()}>
            + طلب جديد
          </button>
        )}
      </div>
      {error && (
        <Notice message={error} tone="error" onDismiss={() => setError('')} />
      )}
      {notice && (
        <Notice
          message={notice}
          tone="success"
          onDismiss={() => setNotice('')}
        />
      )}
      <div className="pos-layout">
        <div className="catalog">
          <div className="category-strip">
            <button
              className={!categoryId ? 'selected' : ''}
              onClick={() => setCategoryId('')}
            >
              الكل
            </button>
            {categories.map((row) => (
              <button
                key={row.id}
                className={categoryId === row.id ? 'selected' : ''}
                onClick={() => setCategoryId(row.id)}
              >
                {row.name}
              </button>
            ))}
          </div>
          <label className="pos-search">
            بحث في المنيو
            <input
              ref={searchInputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="اسم الصنف"
            />
          </label>
          {loading ? (
            <div className="empty-state">جارٍ التحميل…</div>
          ) : (
            <div className="pos-menu-grid">
              {items.map((item) => (
                <button
                  className="pos-product"
                  disabled={busy}
                  aria-disabled={!order}
                  key={item.id}
                  onClick={() => order && void add(item)}
                >
                  <div>
                    <b>{item.name}</b>
                    <small>{item.categoryName}</small>
                    <strong>{egp.format(item.priceMinor / 100)}</strong>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
        <aside className="order-panel">
          <div className="order-heading">
            <div>
              <small>الطلب الحالي</small>
              <h2>{order?.orderNumber ?? 'لا يوجد طلب'}</h2>
            </div>
            {order && <span className="pill active">مفتوح</span>}
          </div>
          {!order ? (
            <div className="empty-state pos-empty-order">
              <b>ابدأ طلباً جديداً</b>
              <span>ثم أضف الأصناف من المنيو.</span>
              <button onClick={() => void createOrder()}>+ طلب جديد</button>
              <small>اختصار لوحة المفاتيح F2</small>
            </div>
          ) : receipt ? (
            <div className={`receipt-wrap receipt-${paperWidth}`}>
              <ReceiptView receipt={receipt} />
              <div className="no-print receipt-actions">
                <label>
                  عرض الورق
                  <select
                    value={paperWidth}
                    onChange={(event) =>
                      setPaperWidth(event.target.value as '80' | '58')
                    }
                  >
                    <option value="80">80 مم</option>
                    <option value="58">58 مم</option>
                  </select>
                </label>
                <button onClick={() => void printReceipt(receipt)}>
                  طباعة / إعادة طباعة
                </button>
                <small>
                  ستفتح نافذة طباعة المتصفح. الطباعة الفعلية غير مؤكدة.
                </small>
              </div>
            </div>
          ) : (
            <>
              <div className="cart-lines">
                {order.items.length === 0 && (
                  <p className="muted">الطلب فارغ.</p>
                )}
                {order.items.map((line) => (
                  <article key={line.id}>
                    <div>
                      <b>{line.itemNameSnapshot}</b>
                      {line.notes && <small>{line.notes}</small>}
                      <strong>{egp.format(line.lineTotalMinor / 100)}</strong>
                    </div>
                    <div className="quantity">
                      <div className="quantity-stepper" dir="ltr">
                        <button
                          className="step-button"
                          aria-label={`تقليل كمية ${line.itemNameSnapshot}`}
                          disabled={busy}
                          onClick={() =>
                            void changeQuantity(line.id, line.quantity - 1)
                          }
                        >
                          −
                        </button>
                        <output aria-label="الكمية">{line.quantity}</output>
                        <button
                          className="step-button"
                          aria-label={`زيادة كمية ${line.itemNameSnapshot}`}
                          disabled={busy}
                          onClick={() =>
                            void changeQuantity(line.id, line.quantity + 1)
                          }
                        >
                          +
                        </button>
                      </div>
                      <div className="line-actions">
                        <button
                          className="secondary"
                          onClick={() =>
                            void editNotes(line.id, line.quantity, line.notes)
                          }
                        >
                          ملاحظة
                        </button>
                        <button
                          className="secondary danger"
                          onClick={() => void remove(line.id)}
                        >
                          حذف
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
              <div className="order-total">
                <span>الإجمالي</span>
                <strong>{egp.format(order.totalMinor / 100)}</strong>
              </div>
              <div className="checkout-box">
                <label>
                  النقد المستلم (ج.م)
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={cash}
                    onChange={(event) => setCash(event.target.value)}
                  />
                </label>
                <div>
                  <span>الباقي المتوقع</span>
                  <b>
                    {egp.format(
                      Math.max(0, Number(cash || 0) * 100 - order.totalMinor) /
                        100,
                    )}
                  </b>
                </div>
                <button
                  disabled={busy || order.items.length === 0}
                  onClick={() => void checkout()}
                >
                  تحصيل نقدي وإصدار إيصال
                </button>
              </div>
              {(order.items.length === 0 || user.role === 'admin') && (
                <button
                  className="cancel-order"
                  disabled={busy}
                  onClick={() => void cancel()}
                >
                  {order.items.length === 0
                    ? 'تجاهل الطلب الفارغ'
                    : 'إلغاء الطلب'}
                </button>
              )}
            </>
          )}
        </aside>
      </div>
      <section className="open-orders">
        <div className="panel-heading">
          <h2>الطلبات المفتوحة</h2>
          <button className="secondary" onClick={() => void loadOrders()}>
            تحديث
          </button>
        </div>
        {orders.length === 0 ? (
          <p className="muted">لا توجد طلبات مفتوحة.</p>
        ) : (
          <div>
            {orders.map((row) => (
              <button
                key={row.id}
                className={order?.id === row.id ? 'current' : ''}
                onClick={() => void refreshOrder(row.id)}
              >
                <b>{row.orderNumber}</b>
                <span>{egp.format(row.totalMinor / 100)}</span>
                <small>نسخة {row.version}</small>
              </button>
            ))}
          </div>
        )}
      </section>
      {dialog}
    </section>
  );
}

export function ReceiptView({ receipt }: { receipt: Receipt }) {
  const data = receipt.snapshot;
  return (
    <article className="thermal-receipt" dir="rtl">
      <h2>إيصال مطعم أفندينا</h2>
      <p>تيك أواي · دفع نقدي</p>
      <hr />
      <dl>
        <div>
          <dt>رقم الإيصال</dt>
          <dd>{data.receiptNumber}</dd>
        </div>
        <div>
          <dt>رقم الطلب</dt>
          <dd>{data.orderNumber}</dd>
        </div>
        <div>
          <dt>التاريخ</dt>
          <dd>{new Date(data.paidAt).toLocaleString('ar-EG')}</dd>
        </div>
      </dl>
      <hr />
      {data.items.map((item, index) => (
        <div className="receipt-line" key={`${item.name}-${index}`}>
          <span>
            {item.name} × {item.quantity}
          </span>
          <b>{egp.format(item.lineTotalMinor / 100)}</b>
          {item.notes && <small>{item.notes}</small>}
        </div>
      ))}
      <hr />
      <div className="receipt-total">
        <span>الإجمالي</span>
        <b>{egp.format(data.totalMinor / 100)}</b>
      </div>
      <div className="receipt-total">
        <span>المستلم</span>
        <b>{egp.format(data.cashTenderedMinor / 100)}</b>
      </div>
      <div className="receipt-total">
        <span>الباقي</span>
        <b>{egp.format(data.changeMinor / 100)}</b>
      </div>
      <hr />
      <p>شكراً لزيارتكم</p>
    </article>
  );
}
