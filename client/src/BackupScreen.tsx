import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, errorMessage, type Page } from './api';
import { useSiteDialog } from './SiteDialog';
import { Notice } from './Notice';

type BackupRecord = {
  filename: string;
  friendlyName: string;
  hasCustomName: boolean;
  kind: 'daily' | 'manual' | 'pre-restore';
  createdAt: string;
  sizeBytes: number;
  validation: 'valid' | 'corrupt' | 'incompatible' | 'missing' | 'unverified';
  integrity: 'valid' | 'corrupt' | 'missing' | 'unverified';
  compatibility: 'compatible' | 'incompatible' | 'unverified';
  compatibilityMessage: string;
  pendingMigrations: number;
  validationMessage: string;
};
type BackupStatus = {
  directory: string;
  previousDirectories: string[];
  retentionDays: number;
  automaticEnabled: boolean;
  running: boolean;
  lastSuccessfulAt: string | null;
  lastError: { at: string; message: string } | null;
  sameDisk: boolean | null;
  sameDiskWarning: string;
};

const dateTime = new Intl.DateTimeFormat('ar-EG', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Africa/Cairo',
});
const kindText = {
  daily: 'تلقائية',
  manual: 'يدوية',
  'pre-restore': 'قبل الاستعادة',
};
const validationText: Record<BackupRecord['validation'], string> = {
  valid: 'سليمة ومتوافقة',
  corrupt: 'تالفة',
  incompatible: 'غير متوافقة',
  missing: 'مفقودة',
  unverified: 'غير متحقق منها',
};

export function BackupScreen({
  onSessionExpired,
}: {
  onSessionExpired: () => void;
}) {
  const [status, setStatus] = useState<BackupStatus>();
  const [history, setHistory] = useState<Page<BackupRecord>>();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { ask, dialog } = useSiteDialog();

  const fail = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired();
      else setError(errorMessage(cause));
    },
    [onSessionExpired],
  );

  const load = useCallback(async () => {
    setError('');
    const query = new URLSearchParams({
      page: String(page),
      limit: '12',
    });
    if (search.trim()) query.set('search', search.trim());
    try {
      const [statusData, historyData] = await Promise.all([
        api<{ backups: BackupStatus }>('/api/admin/backups'),
        api<Page<BackupRecord>>(`/api/admin/backups/history?${query}`),
      ]);
      setStatus(statusData.backups);
      setHistory(historyData);
    } catch (cause) {
      fail(cause);
    } finally {
      setLoading(false);
    }
  }, [fail, page, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  const createBackup = async () => {
    if (busy || !status) return;
    const result = await ask({
      title: 'إنشاء نسخة احتياطية يدوية',
      message: `سيتم إنشاء نسخة متسقة والتحقق منها قبل إظهار النجاح. موقع الحفظ الحالي: ${status.directory}`,
      confirmLabel: 'إنشاء النسخة',
      cancelLabel: 'إلغاء',
      fields: [
        {
          name: 'friendlyName',
          label: 'اسم النسخة (اختياري)',
          type: 'text',
          maxLength: 80,
        },
      ],
    });
    if (!result) return;
    setBusy(true);
    setError('');
    try {
      await api('/api/admin/backups', {
        method: 'POST',
        body: JSON.stringify({ friendlyName: result.friendlyName }),
      });
      setNotice('تم إنشاء النسخة والتحقق من سلامتها بنجاح.');
      setPage(1);
      await load();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  if (loading && !status)
    return <div className="empty-state">جارٍ تحميل حالة النسخ…</div>;

  return (
    <section className="backups-screen">
      <div className="title-row">
        <div>
          <p className="eyebrow">حماية بيانات المطعم</p>
          <h1>النسخ الاحتياطية</h1>
          <p>أنشئ نسخًا آمنة وراجع سلامتها وموقع حفظها.</p>
        </div>
        <button
          disabled={busy || status?.running}
          onClick={() => void createBackup()}
        >
          {busy || status?.running ? 'جارٍ تنفيذ العملية…' : 'إنشاء نسخة الآن'}
        </button>
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

      {status && (
        <>
          <div className="backup-kpis">
            <StatusCard
              label="آخر نسخة ناجحة"
              value={
                status.lastSuccessfulAt
                  ? dateTime.format(new Date(status.lastSuccessfulAt))
                  : 'لا توجد بعد'
              }
            />
            <StatusCard
              label="النسخ التلقائي"
              value={status.automaticEnabled ? 'يعمل يوميًا' : 'غير مشغّل الآن'}
              tone={status.automaticEnabled ? 'success' : 'warning'}
            />
            <StatusCard
              label="سياسة الاحتفاظ"
              value={`${status.retentionDays} يومًا`}
            />
          </div>

          <section className="panel backup-location-card">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">موقع الحفظ الحالي</p>
                <h2>مجلد النسخ</h2>
              </div>
            </div>
            <code className="backup-path" dir="ltr">
              {status.directory}
            </code>
            <p className="muted">هذا المسار للعرض فقط ويُدار محليًا بأمان.</p>
            {status.sameDisk !== false && (
              <p className="backup-warning">
                {status.sameDisk === true
                  ? status.sameDiskWarning
                  : 'تعذر التأكد هل المجلد على قرص مختلف؛ تحقق يدويًا للحماية من تعطل القرص.'}
              </p>
            )}
            {status.previousDirectories.length > 0 && (
              <details>
                <summary>مواقع مستخدمة سابقًا</summary>
                {status.previousDirectories.map((directory) => (
                  <code
                    className="backup-path previous"
                    dir="ltr"
                    key={directory}
                  >
                    {directory}
                  </code>
                ))}
              </details>
            )}
          </section>

          {status.lastError && (
            <p className="form-error">
              آخر خطأ في النسخ: {status.lastError.message}
            </p>
          )}
          <section className="backup-info-message">
            <strong>الاستعادة: </strong>
            الاستعادة من الواجهة متوقفة مؤقتًا للحفاظ على استقرار التشغيل.
            استخدم أداة الصيانة المحلية الموثقة عند الحاجة.
          </section>

          <section className="panel backup-history-panel">
            <div className="panel-heading">
              <div>
                <h2>سجل النسخ</h2>
                <span>{history?.pagination.total ?? 0} نسخة</span>
              </div>
              <input
                aria-label="بحث النسخ الاحتياطية"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
                placeholder="ابحث باسم النسخة أو الملف"
              />
            </div>
            {!history?.items.length ? (
              <div className="empty-state">لا توجد نسخ مطابقة.</div>
            ) : (
              <div className="backup-table-wrap">
                <table className="backup-table">
                  <thead>
                    <tr>
                      <th>النسخة</th>
                      <th>النوع</th>
                      <th>التاريخ</th>
                      <th>الحجم</th>
                      <th>الحالة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.items.map((backup) => (
                      <tr key={backup.filename}>
                        <td>
                          <strong>{backup.friendlyName}</strong>
                          <small className="backup-friendly-meta">
                            {backup.hasCustomName
                              ? 'اسم مخصص'
                              : `${kindText[backup.kind]} · اسم افتراضي`}
                          </small>
                          <details className="backup-file-details">
                            <summary>اسم الملف والتفاصيل</summary>
                            <code dir="ltr">{backup.filename}</code>
                            <p>{backup.validationMessage}</p>
                          </details>
                        </td>
                        <td>{kindText[backup.kind]}</td>
                        <td>{dateTime.format(new Date(backup.createdAt))}</td>
                        <td dir="ltr">{formatBytes(backup.sizeBytes)}</td>
                        <td>
                          <span
                            className={`backup-validity ${backup.validation}`}
                            title={backup.validationMessage}
                          >
                            {validationText[backup.validation]}
                          </span>
                          <small className="backup-status-detail">
                            السلامة:{' '}
                            {backup.integrity === 'valid'
                              ? 'سليمة'
                              : backup.integrity === 'corrupt'
                                ? 'فشل الفحص'
                                : backup.integrity === 'missing'
                                  ? 'الملف مفقود'
                                  : 'لم تُفحص'}
                            {' · '}التوافق:{' '}
                            {backup.compatibility === 'compatible'
                              ? 'متوافقة'
                              : backup.compatibility === 'incompatible'
                                ? 'غير متوافقة'
                                : 'لم يُفحص'}
                          </small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(history?.pagination.pages ?? 0) > 1 && (
              <div className="pagination">
                <button
                  className="secondary"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => value - 1)}
                >
                  السابق
                </button>
                <span>
                  صفحة {page} من {history?.pagination.pages}
                </span>
                <button
                  className="secondary"
                  disabled={page >= (history?.pagination.pages ?? 1)}
                  onClick={() => setPage((value) => value + 1)}
                >
                  التالي
                </button>
              </div>
            )}
          </section>

          <section className="restore-safety-note">
            <strong>الاستعادة تعتمد على مشرف تشغيل موثوق</strong>
            <p>
              لا تصبح الاستعادة قابلة للتنفيذ إلا عند تشغيل التطبيق عبر مشرف
              محلي مستقل. المشرف يوقف الخدمة، ينفذ الاستعادة المرحلية، يعيد
              التشغيل ويتحقق من الصحة. عند عدم توفره، استخدم CLI الصيانة فقط.
            </p>
          </section>
        </>
      )}
      {dialog}
    </section>
  );
}

function StatusCard({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'warning';
}) {
  return (
    <article className={`backup-kpi ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function formatBytes(value: number) {
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
