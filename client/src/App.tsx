import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api, ApiError, errorMessage as message, type User } from './api';
import { MenuScreen } from './MenuScreen';
import { POSScreen } from './POSScreen';
import { ReportsDashboard } from './ReportsDashboard';
import { useSiteDialog } from './SiteDialog';
import { Icon } from './Icon';
import { OrdersScreen } from './OrdersScreen';
import { BackupScreen } from './BackupScreen';
type Screen = 'loading' | 'setup' | 'login' | 'app' | 'offline';

function credentials(form: HTMLFormElement) {
  const data = new FormData(form);
  return {
    username: String(data.get('username')),
    password: String(data.get('password')),
  };
}

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [user, setUser] = useState<User>();
  const [error, setError] = useState('');

  const boot = useCallback(async () => {
    try {
      const setup = await api<{ needsSetup: boolean }>(
        '/api/auth/setup-status',
      );
      if (setup.needsSetup) {
        setScreen('setup');
        return;
      }
      try {
        const result = await api<{ user: User }>('/api/auth/me');
        setUser(result.user);
        setScreen('app');
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401)
          setScreen('login');
        else throw cause;
      }
    } catch (cause) {
      setError(message(cause));
      setScreen('offline');
    }
  }, []);

  useEffect(() => {
    // Initial authentication is an external-system synchronization; updates occur after fetches settle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void boot();
  }, [boot]);

  const submitAuth = async (
    event: FormEvent<HTMLFormElement>,
    setup: boolean,
  ) => {
    event.preventDefault();
    setError('');
    const form = event.currentTarget;
    const input = credentials(form);
    try {
      if (setup) {
        const data = new FormData(form);
        await api('/api/auth/setup', {
          method: 'POST',
          body: JSON.stringify({
            ...input,
            displayName: String(data.get('displayName')),
          }),
        });
        setScreen('login');
        form.reset();
      } else {
        const result = await api<{ user: User }>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify(input),
        });
        setUser(result.user);
        setScreen('app');
        form.reset();
      }
    } catch (cause) {
      setError(message(cause));
    }
  };

  if (screen === 'loading')
    return (
      <Centered
        title="جارٍ تشغيل نقطة البيع"
        detail="نتحقق من الخدمة المحلية…"
      />
    );
  if (screen === 'offline')
    return (
      <Centered
        title="الخدمة المحلية غير متاحة"
        detail={error}
        action={() => {
          setScreen('loading');
          setError('');
          void boot();
        }}
      />
    );
  if (screen === 'setup')
    return (
      <AuthCard
        title="إنشاء حساب المدير الأول"
        intro="إعداد أولي لمرة واحدة، متاح فقط عندما تكون قاعدة المستخدمين فارغة."
        error={error}
        onSubmit={(event) => void submitAuth(event, true)}
        setup
      />
    );
  if (screen === 'login')
    return (
      <AuthCard
        title="تسجيل الدخول"
        intro="أدخل بيانات حساب نقطة البيع المحلية."
        error={error}
        onSubmit={(event) => void submitAuth(event, false)}
      />
    );
  if (!user) return null;

  return (
    <AuthenticatedApp
      user={user}
      onSessionExpired={() => {
        setUser(undefined);
        setError('انتهت جلستك. سجّل الدخول مرة أخرى.');
        setScreen('login');
      }}
      onLogout={async () => {
        try {
          await api('/api/auth/logout', { method: 'POST' });
        } finally {
          setUser(undefined);
          setError('');
          setScreen('login');
        }
      }}
    />
  );
}

function AuthenticatedApp({
  user,
  onLogout,
  onSessionExpired,
}: {
  user: User;
  onLogout: () => Promise<void>;
  onSessionExpired: () => void;
}) {
  const [view, setView] = useState<
    'pos' | 'orders' | 'reports' | 'backups' | 'menu' | 'users'
  >('pos');
  return (
    <div className="app-shell" dir="rtl" lang="ar">
      <header>
        <div className="brand">
          <span className="brand-mark">
            <img src="/icon.jpeg" alt="مطعم أفندينا" />
          </span>
          <span>
            <strong>مطعم أفندينا</strong>
            <small>نقطة البيع المحلية</small>
          </span>
        </div>
        <div className="account">
          <span>
            <b>{user.displayName}</b>
            <small>{user.role === 'admin' ? 'مدير' : 'كاشير'}</small>
          </span>
          <button
            className="secondary logout-button"
            onClick={() => void onLogout()}
          >
            <Icon name="logout" />
            تسجيل الخروج
          </button>
        </div>
      </header>
      <main className="workspace">
        <aside className="sidebar">
          <p className="nav-label">مساحة العمل</p>
          <button
            className={view === 'pos' ? 'nav-active' : ''}
            onClick={() => setView('pos')}
          >
            <span className="nav-icon">
              <Icon name="pos" />
            </span>
            <span>نقطة البيع</span>
          </button>
          <button
            className={view === 'menu' ? 'nav-active' : ''}
            onClick={() => setView('menu')}
          >
            <span className="nav-icon">
              <Icon name="menu" />
            </span>
            <span>المنيو</span>
          </button>
          {user.role === 'admin' && (
            <button
              className={view === 'orders' ? 'nav-active' : ''}
              onClick={() => setView('orders')}
            >
              <span className="nav-icon">
                <Icon name="orders" />
              </span>
              <span>الطلبات</span>
            </button>
          )}
          {user.role === 'admin' && (
            <button
              className={view === 'reports' ? 'nav-active' : ''}
              onClick={() => setView('reports')}
            >
              <span className="nav-icon">
                <Icon name="reports" />
              </span>
              <span>التقارير</span>
            </button>
          )}
          {user.role === 'admin' && (
            <button
              className={view === 'backups' ? 'nav-active' : ''}
              onClick={() => setView('backups')}
            >
              <span className="nav-icon">
                <Icon name="backups" />
              </span>
              <span>النسخ الاحتياطية</span>
            </button>
          )}
          {user.role === 'admin' && (
            <button
              className={view === 'users' ? 'nav-active' : ''}
              onClick={() => setView('users')}
            >
              <span className="nav-icon">
                <Icon name="users" />
              </span>
              <span>المستخدمون</span>
            </button>
          )}
        </aside>
        <section className="content">
          <div className="view-panel" hidden={view !== 'pos'}>
            <POSScreen user={user} onSessionExpired={onSessionExpired} />
          </div>
          <div className="view-panel" hidden={view !== 'menu'}>
            <MenuScreen user={user} onSessionExpired={onSessionExpired} />
          </div>
          {user.role === 'admin' && (
            <>
              <div className="view-panel" hidden={view !== 'reports'}>
                <ReportsDashboard onSessionExpired={onSessionExpired} />
              </div>
              <div className="view-panel" hidden={view !== 'orders'}>
                <OrdersScreen onSessionExpired={onSessionExpired} />
              </div>
              <div className="view-panel" hidden={view !== 'backups'}>
                <BackupScreen onSessionExpired={onSessionExpired} />
              </div>
              <div className="view-panel" hidden={view !== 'users'}>
                <UsersPanel
                  currentUser={user}
                  onSessionExpired={onSessionExpired}
                />
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function UsersPanel({
  currentUser,
  onSessionExpired,
}: {
  currentUser: User;
  onSessionExpired: () => void;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { ask, dialog } = useSiteDialog();
  const load = useCallback(async () => {
    try {
      setUsers((await api<{ users: User[] }>('/api/admin/users')).users);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired();
      else setError(message(cause));
    }
  }, [onSessionExpired]);
  useEffect(() => {
    let active = true;
    void api<{ users: User[] }>('/api/admin/users')
      .then((result) => {
        if (active) setUsers(result.users);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 401)
          onSessionExpired();
        else setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [onSessionExpired]);
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: data.get('username'),
          displayName: data.get('displayName'),
          password: data.get('password'),
          role: data.get('role'),
        }),
      });
      form.reset();
      await load();
    } catch (cause) {
      setError(message(cause));
    }
  };
  const toggle = async (target: User) => {
    try {
      await api(`/api/admin/users/${target.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !target.active }),
      });
      await load();
    } catch (cause) {
      setError(message(cause));
    }
  };
  const reset = async (target: User) => {
    const result = await ask({
      title: 'تغيير كلمة المرور',
      message: `عيّن كلمة مرور جديدة لـ ${target.displayName}. سيتم إنهاء جلساته السابقة.`,
      confirmLabel: 'تغيير كلمة المرور',
      fields: [
        {
          name: 'password',
          label: 'كلمة المرور الجديدة (5 أحرف على الأقل)',
          type: 'password',
          required: true,
          minLength: 5,
          maxLength: 128,
        },
      ],
    });
    if (!result?.password) return;
    try {
      await api(`/api/admin/users/${target.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ password: result.password }),
      });
      setError('');
      setNotice('تم تغيير كلمة المرور وإنهاء الجلسات السابقة.');
    } catch (cause) {
      setError(message(cause));
    }
  };
  return (
    <section className="panel users">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">إدارة النظام</p>
          <h2>حسابات المستخدمين</h2>
        </div>
        <span>{users.length} مستخدم</span>
      </div>
      {error && (
        <p className="form-error page-toast" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="success-message page-toast">{notice}</p>}
      <form className="create-user" onSubmit={(event) => void create(event)}>
        <label>
          اسم المستخدم
          <input
            name="username"
            required
            minLength={3}
            maxLength={40}
            autoComplete="off"
          />
        </label>
        <label>
          الاسم الظاهر
          <input name="displayName" required maxLength={80} />
        </label>
        <label>
          كلمة المرور المؤقتة
          <input
            name="password"
            type="password"
            required
            minLength={5}
            maxLength={128}
            autoComplete="new-password"
          />
        </label>
        <label>
          الصلاحية
          <select name="role">
            <option value="cashier">كاشير</option>
            <option value="admin">مدير</option>
          </select>
        </label>
        <button type="submit">إضافة مستخدم</button>
      </form>
      <div className="user-list">
        {users.map((item) => (
          <article key={item.id}>
            <div className="avatar">
              {item.displayName.slice(0, 1).toUpperCase()}
            </div>
            <div className="user-name">
              <strong>{item.displayName}</strong>
              <small>
                @{item.username} · {item.role === 'admin' ? 'مدير' : 'كاشير'}
              </small>
            </div>
            <span className={`pill ${item.active ? 'active' : ''}`}>
              {item.active ? 'نشط' : 'موقوف'}
            </span>
            <div className="row-actions">
              <button className="secondary" onClick={() => void reset(item)}>
                تغيير كلمة المرور
              </button>
              <button
                className="secondary"
                disabled={item.id === currentUser.id && item.active}
                onClick={() => void toggle(item)}
              >
                {item.active ? 'إيقاف' : 'تفعيل'}
              </button>
            </div>
          </article>
        ))}
      </div>
      {dialog}
    </section>
  );
}

function AuthCard({
  title,
  intro,
  error,
  onSubmit,
  setup = false,
}: {
  title: string;
  intro: string;
  error: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  setup?: boolean;
}) {
  return (
    <main className="auth-shell" dir="rtl" lang="ar">
      <section className="auth-card">
        <span className="brand-mark large">
          <img src="/icon.jpeg" alt="" />
        </span>
        <p className="eyebrow">مطعم أفندينا · تشغيل محلي</p>
        <h1>{title}</h1>
        <p className="muted">{intro}</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <form onSubmit={onSubmit}>
          {setup && (
            <label>
              الاسم الظاهر
              <input name="displayName" required maxLength={80} autoFocus />
            </label>
          )}
          <label>
            اسم المستخدم
            <input
              name="username"
              required
              minLength={3}
              maxLength={40}
              autoComplete="username"
              autoFocus={!setup}
            />
          </label>
          <label>
            كلمة المرور
            <input
              name="password"
              type="password"
              required
              minLength={5}
              maxLength={128}
              autoComplete={setup ? 'new-password' : 'current-password'}
            />
          </label>
          <button type="submit">
            {setup ? 'إنشاء حساب المدير' : 'تسجيل الدخول'}
          </button>
        </form>
        <small className="local-note">
          بيانات الدخول محفوظة على هذا الجهاز فقط.
        </small>
      </section>
    </main>
  );
}

function Centered({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: () => void;
}) {
  return (
    <main className="auth-shell" dir="rtl" lang="ar">
      <section className="auth-card">
        <span className="brand-mark large">
          <Icon name="brand" />
        </span>
        <h1>{title}</h1>
        <p className="muted">{detail}</p>
        {action && <button onClick={action}>إعادة المحاولة</button>}
      </section>
    </main>
  );
}
