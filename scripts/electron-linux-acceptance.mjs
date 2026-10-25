import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const desktopDirectory = path.join(rootDirectory, 'desktop');
const packagedElectron = process.env.POS_PACKAGED_ELECTRON_EXECUTABLE;
if (packagedElectron && !path.isAbsolute(packagedElectron))
  throw new Error('POS_PACKAGED_ELECTRON_EXECUTABLE must be an absolute path.');
if (packagedElectron && !fs.existsSync(packagedElectron))
  throw new Error(
    `Packaged Electron executable was not found: ${packagedElectron}`,
  );
const configuredDataRoot = process.env.POS_ELECTRON_ACCEPTANCE_DATA_ROOT;
if (configuredDataRoot && !path.isAbsolute(configuredDataRoot))
  throw new Error(
    'POS_ELECTRON_ACCEPTANCE_DATA_ROOT must be an absolute path.',
  );
const dataRoot = configuredDataRoot
  ? path.normalize(configuredDataRoot)
  : await mkdtemp(path.join(os.tmpdir(), 'restaurant-pos-electron-'));
fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
const keepData = process.env.POS_ELECTRON_ACCEPTANCE_KEEP_DATA === '1';
const verifyExistingOnly =
  process.env.POS_ELECTRON_ACCEPTANCE_VERIFY_EXISTING === '1';
const windowsPackagedRun = Boolean(
  packagedElectron && process.platform === 'win32',
);
const localAppData = path.join(dataRoot, 'local-app-data');
const userDataDirectory = windowsPackagedRun
  ? path.join(localAppData, 'RestaurantPOS', 'desktop')
  : path.join(dataRoot, 'user-data');
const port = 45_431;
const password = 'electron-acceptance-pass';
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
Object.assign(environment, {
  XDG_CONFIG_HOME: path.join(dataRoot, 'config'),
  POS_ELECTRON_PORT: String(port),
  ...(windowsPackagedRun
    ? { LOCALAPPDATA: localAppData }
    : { POS_ELECTRON_USER_DATA_DIR: userDataDirectory }),
});

let desktop;
let page;
const consoleErrors = [];
const failedLocalRequests = [];
const apiTraffic = [];
let pendingLocalRequests = 0;

function isLocalApiRequest(request) {
  const url = new URL(request.url());
  return url.hostname === '127.0.0.1' && url.pathname.startsWith('/api/');
}

async function waitForRendererIdle() {
  const deadline = Date.now() + 5_000;
  let idleSince = 0;
  while (Date.now() < deadline) {
    if (pendingLocalRequests === 0) {
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince >= 250) return;
    } else {
      idleSince = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Renderer still had ${pendingLocalRequests} local API request(s) before shutdown.`,
  );
}

function requestHealth() {
  return new Promise((resolve, reject) => {
    const request = http.get(
      `http://127.0.0.1:${port}/api/health`,
      (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else reject(new Error(`Health returned ${response.statusCode}`));
      },
    );
    request.once('error', reject);
    request.setTimeout(3_000, () =>
      request.destroy(new Error('Health request timed out')),
    );
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await requestHealth();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw (
    lastError ?? new Error('Timed out waiting for Electron health endpoint.')
  );
}

async function waitForStoppedHealth() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await requestHealth();
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    'The managed backend still answered health checks after Electron closed.',
  );
}

async function launch() {
  const args = packagedElectron
    ? process.env.POS_ELECTRON_ACCEPTANCE_HEADLESS === '1'
      ? ['--headless=new', '--disable-gpu']
      : []
    : process.platform === 'linux'
      ? ['--no-sandbox', '.']
      : ['.'];
  desktop = await electron.launch({
    // GitHub-hosted Linux runners do not provide Chromium's setuid sandbox.
    // This is limited to the isolated CI acceptance process; packaged apps
    // retain Electron's normal sandbox configuration for real users.
    args,
    cwd: desktopDirectory,
    env: environment,
    ...(packagedElectron ? { executablePath: packagedElectron } : {}),
  });
  page = await desktop.firstWindow();
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const location = message.location();
      consoleErrors.push(
        `${message.text()} (${location.url || 'renderer'}:${location.lineNumber})`,
      );
    }
  });
  page.on('requestfailed', (request) => {
    if (isLocalApiRequest(request)) {
      pendingLocalRequests = Math.max(0, pendingLocalRequests - 1);
      failedLocalRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  page.on('request', (request) => {
    if (isLocalApiRequest(request)) pendingLocalRequests += 1;
  });
  page.on('requestfinished', (request) => {
    if (isLocalApiRequest(request))
      pendingLocalRequests = Math.max(0, pendingLocalRequests - 1);
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname === '127.0.0.1' && url.pathname.startsWith('/api/'))
      apiTraffic.push(
        `${response.request().method()} ${url.pathname} status=${response.status()}`,
      );
  });
  await waitForHealth();
}

async function close() {
  if (!desktop) return;
  if (page && !page.isClosed()) await waitForRendererIdle();
  await desktop.close();
  desktop = undefined;
  page = undefined;
  await waitForStoppedHealth();
}

async function signInIfNeeded() {
  if (!(await page.getByRole('heading', { name: 'تسجيل الدخول' }).isVisible()))
    return;
  await page.getByLabel('اسم المستخدم').fill('electron-owner');
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
}

async function assertPersistedSale() {
  await signInIfNeeded();
  await page.getByRole('heading', { name: 'نقطة البيع' }).waitFor();
  await page.getByRole('button', { name: 'المنيو' }).click();
  await page.locator('.menu-card').filter({ hasText: 'شاي إلكترون' }).waitFor();
  await page.getByRole('button', { name: 'التقارير' }).click();
  await page.getByRole('heading', { name: 'تقارير المبيعات' }).waitFor();
  assert.equal(
    await page
      .locator('.kpi')
      .filter({ hasText: 'الطلبات المدفوعة' })
      .locator('strong')
      .textContent(),
    '1',
    'The paid order was not preserved after Electron restart.',
  );
}

async function createOrAssertPersistedPurchase() {
  await page.getByRole('button', { name: 'المشتريات' }).click();
  await page.getByRole('heading', { name: 'المشتريات', exact: true }).waitFor();

  const purchaseName = 'توريد ترقية إلكترون';
  const existing = page
    .locator('.purchases-table')
    .filter({ hasText: purchaseName });
  if ((await existing.count()) === 0) {
    await page.getByRole('button', { name: 'إضافة مشتريات' }).click();
    const editor = page.getByRole('dialog', { name: 'إضافة مشتريات' });
    await editor.getByLabel('اسم المشتريات').fill(purchaseName);
    await editor.getByLabel('الكمية').fill('2');
    await editor.getByLabel('الوحدة (اختياري)').fill('كيس');
    await editor.getByLabel('سعر الوحدة (ج.م)').fill('12.5');
    await editor.getByRole('button', { name: 'حفظ' }).click();
  }
  await page
    .locator('.purchases-table')
    .filter({ hasText: purchaseName })
    .waitFor();
}

try {
  await launch();
  if (verifyExistingOnly) {
    await assertPersistedSale();
    await createOrAssertPersistedPurchase();
    await close();
    await launch();
    await assertPersistedSale();
    await createOrAssertPersistedPurchase();
  } else {
    await page
      .getByRole('heading', { name: 'إنشاء حساب المدير الأول' })
      .waitFor();

    await page.getByLabel('الاسم الظاهر').fill('مدير الاختبار');
    await page.getByLabel('اسم المستخدم').fill('electron-owner');
    await page.getByLabel('كلمة المرور').fill(password);
    await page.getByRole('button', { name: 'إنشاء حساب المدير' }).click();
    await page.getByRole('heading', { name: 'تسجيل الدخول' }).waitFor();
    await page.getByLabel('اسم المستخدم').fill('electron-owner');
    await page.getByLabel('كلمة المرور').fill(password);
    await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
    await page.getByRole('heading', { name: 'نقطة البيع' }).waitFor();

    await page.getByRole('button', { name: 'المنيو' }).click();
    await page.getByRole('button', { name: '+ تصنيف جديد' }).click();
    const categoryForm = page.locator('form').filter({ hasText: 'تصنيف جديد' });
    await categoryForm.getByLabel('الاسم').fill('مشروبات الاختبار');
    await categoryForm
      .getByRole('button', { name: 'إضافة', exact: true })
      .click();
    await page.getByRole('button', { name: '+ صنف جديد' }).click();
    const itemForm = page.locator('form').filter({ hasText: 'صنف جديد' });
    await itemForm
      .getByLabel('التصنيف')
      .selectOption({ label: 'مشروبات الاختبار' });
    await itemForm.getByLabel('الاسم').fill('شاي إلكترون');
    await itemForm.getByLabel('السعر (ج.م)').fill('25');
    await itemForm.getByRole('button', { name: 'إضافة الصنف' }).click();
    await page.getByText('شاي إلكترون', { exact: true }).last().waitFor();

    await page.getByRole('button', { name: 'نقطة البيع' }).click();
    await page.getByRole('button', { name: '+ طلب جديد' }).click();
    await page
      .locator('.pos-product')
      .filter({ hasText: 'شاي إلكترون' })
      .click();
    await page.getByLabel('النقد المستلم (ج.م)').fill('30');
    await page.getByRole('button', { name: 'تحصيل نقدي وإصدار إيصال' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'تحصيل وإصدار الإيصال' })
      .click();
    await page.getByText('إيصال مطعم أفندينا').waitFor();

    await page.getByRole('button', { name: 'التقارير' }).click();
    await page.getByRole('heading', { name: 'تقارير المبيعات' }).waitFor();
    await page
      .locator('.kpi')
      .filter({ hasText: 'الطلبات المدفوعة' })
      .locator('strong')
      .waitFor();
    assert.equal(
      await page
        .locator('.kpi')
        .filter({ hasText: 'الطلبات المدفوعة' })
        .locator('strong')
        .textContent(),
      '1',
      'The Electron report did not include the completed payment.',
    );

    await page.getByRole('button', { name: 'النسخ الاحتياطية' }).click();
    await page.getByRole('heading', { name: 'النسخ الاحتياطية' }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'اختيار مجلد' }).count(),
      0,
      'Unreliable backup-folder controls must not be shown.',
    );
    assert.equal(
      await page.getByRole('button', { name: 'إدخال مسار يدوي' }).count(),
      0,
      'Manual backup path input must not be shown.',
    );
    assert.equal(
      await page.getByRole('button', { name: 'فتح المجلد' }).count(),
      0,
      'Unsupported backup folder opening must not be shown.',
    );
    assert.equal(
      await page.getByRole('button', { name: 'إنشاء نسخة الآن' }).count(),
      0,
      'Manual backup creation must not be shown.',
    );
    await page.getByText('تُنشأ نسخ آمنة تلقائيًا').waitFor();
    await page.locator('.backup-table tbody tr').first().waitFor();
    assert.match(
      await page.locator('.backup-table tbody tr').first().textContent(),
      /تلقائية/,
      'A verified automatic backup must appear after application startup.',
    );
    assert.ok(
      (await page.locator('.page-toast:visible').count()) <= 3,
      'More than three notices are visible.',
    );

    for (let restart = 0; restart < 3; restart += 1) {
      await close();
      await launch();
      await assertPersistedSale();
    }
  }
  const desktopLog = fs.readFileSync(
    path.join(userDataDirectory, 'logs', 'desktop.log'),
    'utf8',
  );
  assert.doesNotMatch(
    desktopLog,
    /EADDRINUSE/i,
    'A restart encountered a local address or named-pipe conflict.',
  );

  assert.deepEqual(
    consoleErrors,
    [],
    `Unexpected renderer console errors: ${consoleErrors.join('\n')}`,
  );
  assert.deepEqual(
    failedLocalRequests,
    [],
    `Failed local requests: ${failedLocalRequests.join('\n')}`,
  );
  console.log(
    `Packaged Electron acceptance passed with isolated data at ${dataRoot}.`,
  );
} catch (error) {
  const logDirectory = path.join(userDataDirectory, 'logs');
  const diagnostics = [
    'desktop.log',
    'application.log',
    'backend.stdout.log',
    'backend.stderr.log',
  ]
    .map((name) => {
      try {
        return `${name}:\n${fs.readFileSync(path.join(logDirectory, name), 'utf8')}`;
      } catch {
        return `${name}: unavailable`;
      }
    })
    .join('\n');
  throw new Error(
    `${error instanceof Error ? error.message : String(error)}\n` +
      `API traffic:\n${apiTraffic.join('\n') || 'none'}\n` +
      `Failed local requests:\n${failedLocalRequests.join('\n') || 'none'}\n` +
      `Renderer errors:\n${consoleErrors.join('\n') || 'none'}\n` +
      `Diagnostics:\n${diagnostics}`,
    { cause: error },
  );
} finally {
  await close().catch(() => undefined);
  if (!keepData) await rm(dataRoot, { recursive: true, force: true });
}
