import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  errorMessage,
  type MenuCategory,
  type MenuItem,
  type Page,
  type User,
} from './api';
import { useSiteDialog } from './SiteDialog';
import { Notice } from './Notice';

const egp = new Intl.NumberFormat('ar-EG', {
  style: 'currency',
  currency: 'EGP',
});

export function MenuScreen({
  user,
  onSessionExpired,
}: {
  user: User;
  onSessionExpired: () => void;
}) {
  const admin = user.role === 'admin';
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [result, setResult] = useState<Page<MenuItem>>({
    items: [],
    pagination: { page: 1, limit: 24, total: 0, pages: 0 },
  });
  const [categoryId, setCategoryId] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [creationForm, setCreationForm] = useState<'category' | 'item' | null>(
    null,
  );
  const [categoryMenuId, setCategoryMenuId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const { ask, dialog } = useSiteDialog();
  const fail = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired();
      else setError(errorMessage(cause));
    },
    [onSessionExpired],
  );
  const loadCategories = useCallback(async () => {
    try {
      setCategories(
        (
          await api<{ categories: MenuCategory[] }>(
            `/api/menu/categories${admin ? '?includeInactive=true' : ''}`,
          )
        ).categories,
      );
    } catch (cause) {
      fail(cause);
    }
  }, [admin, fail]);
  const loadItems = useCallback(
    async (page = 1) => {
      const params = new URLSearchParams({ page: String(page), limit: '24' });
      if (categoryId) params.set('categoryId', categoryId);
      if (query) params.set('search', query);
      if (admin && showAll) {
        params.set('includeArchived', 'true');
        params.set('includeUnavailable', 'true');
      }
      try {
        setResult(await api<Page<MenuItem>>(`/api/menu/items?${params}`));
        setError('');
      } catch (cause) {
        fail(cause);
      } finally {
        setLoading(false);
      }
    },
    [admin, categoryId, fail, query, showAll],
  );
  useEffect(() => {
    // Fetching server-owned menu state is the synchronization performed by this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCategories();
  }, [loadCategories]);
  useEffect(() => {
    // Fetching server-owned menu state is the synchronization performed by this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadItems();
  }, [loadItems]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const refresh = async (text: string) => {
    await Promise.all([loadCategories(), loadItems()]);
    window.dispatchEvent(new Event('pos:menu-updated'));
    setNotice(text);
  };
  const createCategory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api('/api/admin/menu/categories', {
        method: 'POST',
        body: JSON.stringify({
          name: data.get('name'),
          sortOrder: Number(data.get('sortOrder')),
          isActive: true,
        }),
      });
      form.reset();
      setCreationForm(null);
      await refresh('تمت إضافة التصنيف بنجاح.');
    } catch (cause) {
      fail(cause);
    }
  };
  const createItem = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api('/api/admin/menu/items', {
        method: 'POST',
        body: JSON.stringify({
          categoryId: data.get('categoryId'),
          name: data.get('name'),
          description: data.get('description') || null,
          priceMinor: Math.round(Number(data.get('price')) * 100),
          sortOrder: Number(data.get('sortOrder')),
          isAvailable: true,
        }),
      });
      form.reset();
      setCreationForm(null);
      await refresh('تمت إضافة الصنف بنجاح.');
    } catch (cause) {
      fail(cause);
    }
  };
  const editCategory = async (row: MenuCategory) => {
    setCategoryMenuId(null);
    const result = await ask({
      title: 'تعديل التصنيف',
      confirmLabel: 'حفظ التعديل',
      fields: [
        { name: 'name', label: 'اسم التصنيف', value: row.name, required: true },
      ],
    });
    const name = result?.name.trim();
    if (!name) return;
    try {
      await api(`/api/admin/menu/categories/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      await refresh('تم تحديث التصنيف.');
    } catch (cause) {
      fail(cause);
    }
  };
  const toggleCategory = async (row: MenuCategory) => {
    setCategoryMenuId(null);
    const action = row.isActive ? 'إيقاف' : 'تفعيل';
    if (
      !(await ask({
        title: `${action} التصنيف`,
        message: `هل تريد ${action} تصنيف «${row.name}»؟`,
        confirmLabel: action,
        tone: row.isActive ? 'danger' : 'normal',
      }))
    )
      return;
    try {
      await api(`/api/admin/menu/categories/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !row.isActive }),
      });
      await refresh(`تم ${action} التصنيف.`);
    } catch (cause) {
      fail(cause);
    }
  };
  const editItem = async (row: MenuItem) => {
    const result = await ask({
      title: 'تعديل بيانات الصنف',
      message: 'حدّث الاسم والتصنيف والسعر ثم احفظ التغييرات.',
      confirmLabel: 'حفظ التعديلات',
      fields: [
        { name: 'name', label: 'اسم الصنف', value: row.name, required: true },
        {
          name: 'description',
          label: 'الوصف',
          value: row.description ?? '',
          type: 'textarea',
        },
        {
          name: 'categoryId',
          label: 'التصنيف',
          value: row.categoryId,
          type: 'select',
          required: true,
          options: categories
            .filter(
              (category) => category.isActive || category.id === row.categoryId,
            )
            .map((category) => ({ value: category.id, label: category.name })),
        },
        {
          name: 'price',
          label: 'السعر بالجنيه',
          value: String(row.priceMinor / 100),
          type: 'number',
          min: '0.01',
          max: '1000000',
          step: '0.01',
          required: true,
        },
      ],
    });
    if (!result) return;
    try {
      await api(`/api/admin/menu/items/${row.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: result.name,
          description: result.description || null,
          categoryId: result.categoryId,
          priceMinor: Math.round(Number(result.price) * 100),
        }),
      });
      await refresh('تم تحديث الصنف.');
    } catch (cause) {
      fail(cause);
    }
  };
  const changeState = async (
    row: MenuItem,
    action: 'availability' | 'archive',
    value: boolean,
  ) => {
    if (
      action === 'archive' &&
      value &&
      !(await ask({
        title: 'أرشفة الصنف',
        message: `هل تريد أرشفة «${row.name}»؟ سيظل محفوظًا في الطلبات السابقة.`,
        confirmLabel: 'أرشفة',
        tone: 'danger',
      }))
    )
      return;
    try {
      await api(`/api/admin/menu/items/${row.id}/${action}`, {
        method: 'PATCH',
        body: JSON.stringify(
          action === 'archive' ? { isArchived: value } : { isAvailable: value },
        ),
      });
      await refresh('تم تحديث حالة الصنف.');
    } catch (cause) {
      fail(cause);
    }
  };

  return (
    <section className="menu-screen">
      <div className="title-row">
        <div>
          <p className="eyebrow">قائمة المطعم</p>
          <h1>{admin ? 'إدارة المنيو' : 'المنيو'}</h1>
          <p className="muted">
            {admin
              ? 'نظّم التصنيفات والأسعار وحالة التوفر.'
              : 'الأصناف المتاحة للبيع الآن.'}
          </p>
        </div>
        <div className="menu-heading-actions">
          {admin && (
            <>
              <button
                className="secondary"
                onClick={() =>
                  setCreationForm((current) =>
                    current === 'category' ? null : 'category',
                  )
                }
              >
                + تصنيف جديد
              </button>
              <button
                onClick={() =>
                  setCreationForm((current) =>
                    current === 'item' ? null : 'item',
                  )
                }
              >
                + صنف جديد
              </button>
            </>
          )}
          <div className="menu-count">
            <b>{result.pagination.total}</b>
            <span>صنف</span>
          </div>
        </div>
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
      {admin && creationForm && (
        <div className="admin-forms">
          {creationForm === 'category' && (
            <form onSubmit={(event) => void createCategory(event)}>
              <h2>تصنيف جديد</h2>
              <div className="inline-fields">
                <label>
                  الاسم
                  <input name="name" required maxLength={100} autoFocus />
                </label>
                <label>
                  الترتيب
                  <input
                    name="sortOrder"
                    type="number"
                    min="0"
                    defaultValue="0"
                    required
                  />
                </label>
                <button>إضافة</button>
              </div>
            </form>
          )}
          {creationForm === 'item' && (
            <form onSubmit={(event) => void createItem(event)}>
              <h2>صنف جديد</h2>
              <div className="item-fields">
                <label>
                  التصنيف
                  <select name="categoryId" required autoFocus>
                    <option value="">اختر</option>
                    {categories
                      .filter((row) => row.isActive)
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  الاسم
                  <input name="name" required maxLength={100} />
                </label>
                <label>
                  الوصف
                  <input name="description" maxLength={500} />
                </label>
                <label>
                  السعر (ج.م)
                  <input
                    name="price"
                    type="number"
                    min="0.01"
                    max="1000000"
                    step="0.01"
                    required
                  />
                </label>
                <label>
                  الترتيب
                  <input
                    name="sortOrder"
                    type="number"
                    min="0"
                    defaultValue="0"
                    required
                  />
                </label>
                <button>إضافة الصنف</button>
              </div>
            </form>
          )}
        </div>
      )}
      <div className="category-strip">
        <button
          className={!categoryId ? 'selected' : ''}
          onClick={() => setCategoryId('')}
        >
          الكل
        </button>
        {categories.map((row) => (
          <div
            className={`category-control ${categoryId === row.id ? 'selected' : ''}`}
            key={row.id}
          >
            <button
              className="category-filter"
              onClick={() => setCategoryId(row.id)}
            >
              {row.name}
              {!row.isActive && ' · متوقف'}
            </button>
            {admin && (
              <div className="category-actions">
                <button
                  className="category-more"
                  onClick={() =>
                    setCategoryMenuId((current) =>
                      current === row.id ? null : row.id,
                    )
                  }
                  aria-label={`إدارة تصنيف ${row.name}`}
                  aria-expanded={categoryMenuId === row.id}
                >
                  ⋯
                </button>
                {categoryMenuId === row.id && (
                  <div className="category-popover">
                    <button onClick={() => void editCategory(row)}>
                      تعديل التصنيف
                    </button>
                    <button
                      className={row.isActive ? 'danger' : ''}
                      onClick={() => void toggleCategory(row)}
                    >
                      {row.isActive ? 'إيقاف التصنيف' : 'تفعيل التصنيف'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <form
        className="menu-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search.trim());
        }}
      >
        <label>
          <span>بحث</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="الاسم أو الوصف"
            maxLength={100}
          />
        </label>
        {admin && (
          <label className="check">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(event) => setShowAll(event.target.checked)}
            />{' '}
            عرض المؤرشف وغير المتاح
          </label>
        )}
      </form>
      {loading ? (
        <div className="empty-state">جارٍ تحميل المنيو…</div>
      ) : result.items.length === 0 ? (
        <div className="empty-state">
          <b>لا توجد أصناف</b>
          <span>غيّر البحث أو أضف صنفاً جديداً.</span>
        </div>
      ) : (
        <div className="menu-grid">
          {result.items.map((row) => (
            <article
              className={`menu-card ${row.isArchived ? 'archived' : ''}`}
              key={row.id}
            >
              <div className="dish-body">
                <div className="dish-heading">
                  <div>
                    <small>{row.categoryName}</small>
                    <h3>{row.name}</h3>
                  </div>
                  <strong>{egp.format(row.priceMinor / 100)}</strong>
                </div>
                {row.description && <p>{row.description}</p>}
                <div className="card-footer">
                  <span
                    className={`pill ${row.isAvailable && !row.isArchived ? 'active' : ''}`}
                  >
                    {row.isArchived
                      ? 'مؤرشف'
                      : row.isAvailable
                        ? 'متاح'
                        : 'غير متاح'}
                  </span>
                  {admin && (
                    <div className="row-actions">
                      <button
                        className="secondary"
                        onClick={() => void editItem(row)}
                      >
                        تعديل
                      </button>
                      {!row.isArchived && (
                        <button
                          className="secondary"
                          onClick={() =>
                            void changeState(
                              row,
                              'availability',
                              !row.isAvailable,
                            )
                          }
                        >
                          {row.isAvailable ? 'إيقاف' : 'إتاحة'}
                        </button>
                      )}
                      <button
                        className="secondary danger"
                        onClick={() =>
                          void changeState(row, 'archive', !row.isArchived)
                        }
                      >
                        {row.isArchived ? 'استعادة' : 'أرشفة'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {result.pagination.pages > 1 && (
        <div className="pagination">
          <button
            className="secondary"
            disabled={result.pagination.page <= 1}
            onClick={() => void loadItems(result.pagination.page - 1)}
          >
            السابق
          </button>
          <span>
            {result.pagination.page} / {result.pagination.pages}
          </span>
          <button
            className="secondary"
            disabled={result.pagination.page >= result.pagination.pages}
            onClick={() => void loadItems(result.pagination.page + 1)}
          >
            التالي
          </button>
        </div>
      )}
      {dialog}
    </section>
  );
}
