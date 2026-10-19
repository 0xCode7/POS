import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
const dataRoot = await mkdtemp(
  path.join(os.tmpdir(), 'restaurant-pos-electron-'),
);
const port = 45_431;
const password = 'electron-acceptance-pass';
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
Object.assign(environment, {
  XDG_CONFIG_HOME: path.join(dataRoot, 'config'),
  POS_ELECTRON_PORT: String(port),
  POS_ELECTRON_USER_DATA_DIR: path.join(dataRoot, 'user-data'),
});

let desktop;
let page;
const consoleErrors = [];
const failedLocalRequests = [];

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    execFile(command, arguments_, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function verifyNativeFolderDialog() {
  if (process.env.RUN_NATIVE_FOLDER_DIALOG !== '1') return;
  await page.getByRole('button', { name: 'اختيار مجلد' }).click();
  const title = 'اختيار مجلد النسخ الاحتياطية';
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const windows = await run('wmctrl', ['-l']);
    if (windows.includes(title)) {
      await run('wmctrl', ['-c', '-r', title]);
      await page
        .getByText('لم يتم اختيار مجلد جديد. لم تتغير إعدادات النسخ.')
        .waitFor();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    'The native folder chooser did not become visible to the desktop session.',
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
    if (new URL(request.url()).hostname === '127.0.0.1')
      failedLocalRequests.push(`${request.method()} ${request.url()}`);
  });
  await waitForHealth();
}

async function close() {
  if (!desktop) return;
  await desktop.close();
  desktop = undefined;
  await waitForStoppedHealth();
}

try {
  await launch();
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
  await page.locator('.pos-product').filter({ hasText: 'شاي إلكترون' }).click();
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
    await page.getByRole('button', { name: 'اختيار مجلد' }).isDisabled(),
    false,
    'The Electron native folder chooser bridge is not available.',
  );
  await verifyNativeFolderDialog();
  await page.getByRole('button', { name: 'إنشاء نسخة الآن' }).click();
  await page.getByLabel('اسم النسخة (اختياري)').fill('نسخة إلكترون عربية');
  await page.getByRole('button', { name: 'إنشاء النسخة' }).click();
  await page.locator('.backup-table').getByText('نسخة إلكترون عربية').waitFor();

  const filename = await page
    .locator('.backup-table tbody tr')
    .first()
    .locator('code')
    .textContent();
  assert.ok(filename, 'The backup filename is missing from backup history.');
  await page
    .locator('.backup-table tbody tr')
    .first()
    .getByRole('button', { name: 'استعادة' })
    .click();
  await page.getByLabel('كلمة مرور المدير الحالية').fill(password);
  await page.getByLabel('عبارة التأكيد العربية').fill(`استعادة ${filename}`);
  await page.getByRole('button', { name: 'بدء الاستعادة الآمنة' }).click();

  await page
    .getByRole('heading', { name: 'تسجيل الدخول' })
    .waitFor({ timeout: 70_000 });

  await close();
  await launch();
  await page.getByRole('heading', { name: 'تسجيل الدخول' }).waitFor();
  await close();

  const expectedSessionExpiry = consoleErrors.filter(
    (entry) =>
      entry.includes('/api/auth/me') && entry.includes('401 (Unauthorized)'),
  );
  const unexpectedConsoleErrors = consoleErrors.filter(
    (entry) => !expectedSessionExpiry.includes(entry),
  );
  assert.ok(
    expectedSessionExpiry.length > 0,
    'Restore did not invalidate the previous Electron session.',
  );
  assert.deepEqual(
    unexpectedConsoleErrors,
    [],
    `Unexpected renderer console errors: ${unexpectedConsoleErrors.join('\n')}`,
  );
  assert.deepEqual(
    failedLocalRequests,
    [],
    `Failed local requests: ${failedLocalRequests.join('\n')}`,
  );
  console.log(
    `Electron Linux acceptance passed with isolated data at ${dataRoot}.`,
  );
} finally {
  await close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true });
}
