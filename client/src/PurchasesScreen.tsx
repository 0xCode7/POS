import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { api, ApiError, errorMessage, type Page, type Purchase } from './api';
import { Notice } from './Notice';
import { useSiteDialog } from './SiteDialog';

type Filters = { search: string; day: string; month: string };
type Summary = {
  todayMinor: number;
  monthMinor: number;
  selectedPeriodMinor: number;
};
type PurchaseDraft = {
  name: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  purchaseDate: string;
};

const egp = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
});
const number = new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 3 });
const money = (minor: number) => egp.format(minor / 100);

export function PurchasesScreen({
  onSessionExpired,
}: {
  onSessionExpired: () => void;
}) {
  const [filters, setFilters] = useState<Filters>(() => ({
    search: '',
    day: '',
    month: cairoMonth(),
  }));
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<Purchase>>({
    items: [],
    pagination: { page: 1, limit: 20, total: 0, pages: 0 },
  });
  const [summary, setSummary] = useState<Summary>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<Purchase | 'new' | null>(null);
  const { ask, dialog } = useSiteDialog();

  const fail = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired();
      else setError(errorMessage(cause));
    },
    [onSessionExpired],
  );

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedSearch(filters.search.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [filters.search]);

  const load = useCallback(async () => {
    const parameters = new URLSearchParams({
      page: String(page),
      limit: '20',
    });
    if (debouncedSearch) parameters.set('search', debouncedSearch);
    if (filters.day) parameters.set('day', filters.day);
    if (filters.month) parameters.set('month', filters.month);
    try {
      setError('');
      const [history, totals] = await Promise.all([
        api<Page<Purchase>>(`/api/admin/purchases?${parameters}`),
        api<Summary>(`/api/admin/purchases/summary?${parameters}`),
      ]);
      setResult(history);
      setSummary(totals);
    } catch (cause) {
      fail(cause);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, fail, filters.day, filters.month, page]);

  useEffect(() => {
    // Purchases are server-owned administrative records; reload on filter changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const remove = async (purchase: Purchase) => {
    const confirmed = await ask({
      title: 'حذف المشتريات',
      message: `هل تريد حذف «${purchase.name}» من سجل المشتريات؟ لن تظهر في الإجماليات بعد الحذف.`,
      confirmLabel: 'حذف',
      cancelLabel: 'إلغاء',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await api(`/api/admin/purchases/${purchase.id}`, { method: 'DELETE' });
      await load();
      setNotice('تم حذف المشتريات بنجاح.');
    } catch (cause) {
      fail(cause);
    }
  };

  const clearFilters = () => {
    setPage(1);
    setFilters({ search: '', day: '', month: '' });
  };
  const hasFilters = Boolean(filters.search || filters.day || filters.month);

  return (
    <section className="purchases-screen">
      <div className="title-row">
        <div>
          <p className="eyebrow">لوحة الإدارة · توقيت القاهرة</p>
          <h1>المشتريات</h1>
          <p className="muted">متابعة مشتريات المطعم وتكاليفها</p>
        </div>
        <button onClick={() => setEditor('new')}>إضافة مشتريات</button>
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

      <div className="kpi-grid purchases-kpis">
        <Kpi
          label="إجمالي مشتريات اليوم"
          value={money(summary?.todayMinor ?? 0)}
        />
        <Kpi
          label="إجمالي مشتريات الشهر"
          value={money(summary?.monthMinor ?? 0)}
        />
        <Kpi
          label="إجمالي الفترة المحددة"
          value={money(summary?.selectedPeriodMinor ?? 0)}
        />
      </div>

      <section className="panel purchases-history">
        <div className="panel-heading">
          <div>
            <h2>سجل المشتريات</h2>
            <span>{result.pagination.total} سجل</span>
          </div>
        </div>
        <div className="purchases-filters">
          <label>
            بحث
            <input
              value={filters.search}
              onChange={(event) => {
                setPage(1);
                setFilters((current) => ({
                  ...current,
                  search: event.target.value,
                }));
              }}
              placeholder="بحث عن مشتريات..."
              aria-label="بحث عن مشتريات"
            />
          </label>
          <label>
            اليوم
            <input
              type="date"
              value={filters.day}
              onChange={(event) => {
                setPage(1);
                setFilters((current) => ({
                  ...current,
                  day: event.target.value,
                  month: event.target.value ? '' : current.month,
                }));
              }}
            />
          </label>
          <label>
            الشهر
            <input
              type="month"
              value={filters.month}
              onChange={(event) => {
                setPage(1);
                setFilters((current) => ({
                  ...current,
                  month: event.target.value,
                  day: event.target.value ? '' : current.day,
                }));
              }}
            />
          </label>
          <button
            className="secondary"
            disabled={!hasFilters}
            onClick={clearFilters}
          >
            مسح الفلاتر
          </button>
        </div>

        {loading ? (
          <div className="empty-state">جارٍ تحميل المشتريات…</div>
        ) : result.items.length === 0 ? (
          <div className="empty-state">
            <b>
              {hasFilters
                ? 'لا توجد مشتريات مطابقة.'
                : 'لا توجد مشتريات مسجلة بعد.'}
            </b>
            <span>
              {hasFilters
                ? 'غيّر معايير البحث أو الفترة ثم حاول مرة أخرى.'
                : 'أضف أول عملية شراء لمتابعة تكاليف المطعم.'}
            </span>
          </div>
        ) : (
          <div className="purchases-table-wrap">
            <table className="purchases-table">
              <thead>
                <tr>
                  <th>اسم المشتريات</th>
                  <th>الكمية</th>
                  <th>الوحدة</th>
                  <th>سعر الوحدة</th>
                  <th>الإجمالي</th>
                  <th>التاريخ</th>
                  <th>الإجراءات</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((purchase) => (
                  <tr key={purchase.id}>
                    <td>
                      <strong>{purchase.name}</strong>
                    </td>
                    <td>{number.format(purchase.quantityMilli / 1_000)}</td>
                    <td>{purchase.unit || '—'}</td>
                    <td>{money(purchase.unitPriceMinor)}</td>
                    <td>
                      <strong>{money(purchase.totalMinor)}</strong>
                    </td>
                    <td dir="ltr">{purchase.purchaseDate}</td>
                    <td>
                      <div className="purchase-actions">
                        <button
                          className="secondary"
                          onClick={() => setEditor(purchase)}
                        >
                          تعديل
                        </button>
                        <button
                          className="secondary danger"
                          onClick={() => void remove(purchase)}
                        >
                          حذف
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.pagination.pages > 1 && (
          <div className="pagination">
            <button
              className="secondary"
              disabled={page <= 1}
              onClick={() => setPage((value) => value - 1)}
            >
              السابق
            </button>
            <span>
              صفحة {page} من {result.pagination.pages}
            </span>
            <button
              className="secondary"
              disabled={page >= result.pagination.pages}
              onClick={() => setPage((value) => value + 1)}
            >
              التالي
            </button>
          </div>
        )}
      </section>
      {editor && (
        <PurchaseEditor
          purchase={editor === 'new' ? undefined : editor}
          onClose={() => setEditor(null)}
          onSaved={async (kind) => {
            setEditor(null);
            await load();
            setNotice(
              kind === 'new'
                ? 'تمت إضافة المشتريات بنجاح.'
                : 'تم تعديل المشتريات بنجاح.',
            );
          }}
          onFailure={fail}
        />
      )}
      {dialog}
    </section>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <article className="kpi">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function PurchaseEditor({
  purchase,
  onClose,
  onSaved,
  onFailure,
}: {
  purchase?: Purchase;
  onClose: () => void;
  onSaved: (kind: 'new' | 'edit') => Promise<void>;
  onFailure: (cause: unknown) => void;
}) {
  const [draft, setDraft] = useState<PurchaseDraft>(() =>
    purchaseToDraft(purchase),
  );
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const preview = useMemo(
    () => previewTotal(draft.quantity, draft.unitPrice),
    [draft.quantity, draft.unitPrice],
  );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const unitPriceMinor = egpToMinor(draft.unitPrice);
    if (!validQuantity(draft.quantity) || unitPriceMinor === undefined) {
      setFormError('أدخل كمية موجبة وسعر وحدة صحيحًا بالجنيه المصري.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      await api(
        purchase
          ? `/api/admin/purchases/${purchase.id}`
          : '/api/admin/purchases',
        {
          method: purchase ? 'PATCH' : 'POST',
          body: JSON.stringify({
            name: draft.name,
            quantity: draft.quantity,
            unit: draft.unit.trim() || null,
            unitPriceMinor,
            purchaseDate: draft.purchaseDate,
          }),
        },
      );
      await onSaved(purchase ? 'edit' : 'new');
    } catch (cause) {
      const text = errorMessage(cause);
      setFormError(text);
      onFailure(cause);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="site-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="site-dialog purchase-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="purchase-editor-title"
      >
        <div className="site-dialog-heading">
          <span className="site-dialog-icon">{purchase ? '✎' : '+'}</span>
          <div>
            <h2 id="purchase-editor-title">
              {purchase ? 'تعديل المشتريات' : 'إضافة مشتريات'}
            </h2>
            <p>سجّل تكلفة تشغيلية مستقلة عن المبيعات والمخزون.</p>
          </div>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <div className="purchase-form-fields">
            <label className="purchase-name-field">
              اسم المشتريات
              <input
                required
                maxLength={160}
                autoFocus
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              الكمية
              <input
                required
                inputMode="decimal"
                pattern="\d+(\.\d{1,3})?"
                placeholder="مثال: 1.5"
                value={draft.quantity}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    quantity: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              الوحدة (اختياري)
              <input
                maxLength={30}
                placeholder="كيلو، لتر، قطعة"
                value={draft.unit}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    unit: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              سعر الوحدة (ج.م)
              <input
                required
                inputMode="decimal"
                pattern="\d+(\.\d{1,2})?"
                placeholder="0.00"
                value={draft.unitPrice}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    unitPrice: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              التاريخ
              <input
                required
                type="date"
                value={draft.purchaseDate}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    purchaseDate: event.target.value,
                  }))
                }
              />
            </label>
          </div>
          <output className="purchase-total-preview" aria-live="polite">
            <span>الإجمالي المتوقع</span>
            <strong>{preview === undefined ? '—' : money(preview)}</strong>
            <small>يُعاد حساب الإجمالي والتحقق منه في الخادم عند الحفظ.</small>
          </output>
          {formError && (
            <p className="form-error purchase-form-error" role="alert">
              {formError}
            </p>
          )}
          <div className="site-dialog-actions">
            <button
              type="button"
              className="secondary"
              disabled={saving}
              onClick={onClose}
            >
              إلغاء
            </button>
            <button type="submit" disabled={saving}>
              {saving ? 'جارٍ الحفظ…' : 'حفظ'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function purchaseToDraft(purchase?: Purchase): PurchaseDraft {
  if (!purchase)
    return {
      name: '',
      quantity: '1',
      unit: '',
      unitPrice: '',
      purchaseDate: cairoToday(),
    };
  return {
    name: purchase.name,
    quantity: quantityText(purchase.quantityMilli),
    unit: purchase.unit ?? '',
    unitPrice: quantityText(purchase.unitPriceMinor, 100),
    purchaseDate: purchase.purchaseDate,
  };
}

function quantityText(value: number, scale = 1_000) {
  const raw = (value / scale).toFixed(scale === 100 ? 2 : 3);
  return raw.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function validQuantity(value: string) {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return false;
  const scaled =
    Number(match[1]) * 1_000 + Number((match[2] ?? '').padEnd(3, '0'));
  return Number.isSafeInteger(scaled) && scaled >= 1 && scaled <= 10_000_000;
}

function egpToMinor(value: string) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return undefined;
  const minor =
    Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor >= 0 && minor <= 100_000_000
    ? minor
    : undefined;
}

function previewTotal(quantity: string, unitPrice: string) {
  if (!validQuantity(quantity)) return undefined;
  const price = egpToMinor(unitPrice);
  if (price === undefined) return undefined;
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(quantity.trim())!;
  const milli =
    Number(match[1]) * 1_000 + Number((match[2] ?? '').padEnd(3, '0'));
  return Math.round((milli * price) / 1_000);
}

function cairoToday() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts();
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function cairoMonth() {
  return cairoToday().slice(0, 7);
}
