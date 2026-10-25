import { expect, test, type Page } from '@playwright/test';

const password = 'correct horse battery staple';

test.beforeEach(async ({ page }) => {
  const consoleErrors: string[] = [];
  const failedLocalRequests: string[] = [];
  const nativeDialogs: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).hostname === '127.0.0.1')
      failedLocalRequests.push(`${request.method()} ${request.url()}`);
  });
  page.on('dialog', async (dialog) => {
    nativeDialogs.push(dialog.type());
    await dialog.dismiss();
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') await route.abort('blockedbyclient');
    else await route.continue();
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'print', {
      value: () => {
        (window as typeof window & { __printCalls?: number }).__printCalls =
          ((window as typeof window & { __printCalls?: number }).__printCalls ??
            0) + 1;
      },
    });
  });
  (page as Page & { assertClean?: () => void }).assertClean = () => {
    expect(consoleErrors, 'browser console errors').toEqual([]);
    expect(failedLocalRequests, 'failed local requests').toEqual([]);
    expect(nativeDialogs, 'native browser dialogs').toEqual([]);
  };
});

test('complete admin and cashier POS workflow in real Chromium', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'إنشاء حساب المدير الأول' }),
  ).toBeVisible();
  await page.getByLabel('الاسم الظاهر').fill('المدير');
  await page.getByLabel('اسم المستخدم').fill('owner');
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'إنشاء حساب المدير' }).click();

  await expect(
    page.getByRole('heading', { name: 'تسجيل الدخول' }),
  ).toBeVisible();
  await page.getByLabel('اسم المستخدم').fill('owner');
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page.getByRole('heading', { name: 'نقطة البيع' })).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveAttribute('dir', 'rtl');

  await page.getByRole('button', { name: 'المستخدمون' }).click();
  await page.getByLabel('اسم المستخدم').fill('cashier');
  await page.getByLabel('الاسم الظاهر').fill('الكاشير');
  await page.getByLabel('كلمة المرور المؤقتة').fill(password);
  await page.getByRole('button', { name: 'إضافة مستخدم' }).click();
  await expect(page.getByText('@cashier · كاشير')).toBeVisible();

  await page.getByRole('button', { name: 'المنيو' }).click();
  await page.getByRole('button', { name: '+ تصنيف جديد' }).click();
  const categoryForm = page.locator('form').filter({ hasText: 'تصنيف جديد' });
  await categoryForm.getByLabel('الاسم').fill('مشروبات');
  await categoryForm
    .getByRole('button', { name: 'إضافة', exact: true })
    .click();
  await page.getByRole('button', { name: '+ صنف جديد' }).click();
  const itemForm = page.locator('form').filter({ hasText: 'صنف جديد' });
  await itemForm.getByLabel('التصنيف').selectOption({ label: 'مشروبات' });
  await itemForm.getByLabel('الاسم').fill('شاي');
  await itemForm.getByLabel('السعر (ج.م)').fill('25');
  await itemForm.getByRole('button', { name: 'إضافة الصنف' }).click();
  await expect(page.getByText('شاي', { exact: true }).last()).toBeVisible();

  await page.getByRole('button', { name: 'نقطة البيع' }).click();
  await page.keyboard.press('F2');
  await expect(page.locator('.order-heading h2')).toHaveText(/^ORD-/);
  await page.keyboard.press('/');
  await expect(page.getByLabel('بحث في المنيو')).toBeFocused();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'تجاهل الطلب الفارغ' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'تجاهل الطلب' })
    .click();
  await expect(page.locator('.order-heading h2')).toHaveText('لا يوجد طلب');
  await page.getByRole('button', { name: '+ طلب جديد' }).click();
  await expect(page.locator('.order-heading h2')).toHaveText(/^ORD-/);
  const orderNumber = await page.locator('.order-heading h2').textContent();
  expect(orderNumber).toMatch(/^ORD-/);
  await page.getByRole('button', { name: 'المستخدمون' }).click();
  await page.getByRole('button', { name: 'نقطة البيع' }).click();
  await expect(page.locator('.order-heading h2')).toHaveText(orderNumber!);
  await page.locator('.pos-product').filter({ hasText: 'شاي' }).click();
  const noteButton = page.getByRole('button', { name: 'ملاحظة' });
  await noteButton.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(noteButton).toBeFocused();
  await page.getByRole('button', { name: 'زيادة كمية شاي' }).click();
  await expect(page.getByLabel('الكمية')).toHaveText('2');
  await page.getByRole('button', { name: 'تقليل كمية شاي' }).click();
  await expect(page.getByLabel('الكمية')).toHaveText('1');
  await page.getByLabel('النقد المستلم (ج.م)').fill('30');
  await page.getByRole('button', { name: 'تحصيل نقدي وإصدار إيصال' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'تحصيل وإصدار الإيصال' })
    .click();
  await expect(page.getByText('إيصال مطعم أفندينا')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __printCalls?: number }).__printCalls ??
          0,
      ),
    )
    .toBe(1);
  await page.getByRole('button', { name: 'طباعة / إعادة طباعة' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __printCalls?: number }).__printCalls ??
          0,
      ),
    )
    .toBe(2);

  await page.getByRole('button', { name: 'الطلبات' }).click();
  await expect(
    page.getByRole('heading', { name: 'سجل الطلبات' }),
  ).toBeVisible();
  await page.getByLabel('بحث برقم الطلب').fill(orderNumber!);
  const paidOrder = page.locator('.order-history-rows button').first();
  await expect(paidOrder).toContainText('مكتمل');
  await paidOrder.click();
  await expect(page.locator('.order-history-detail')).toContainText('شاي');
  await page.getByRole('button', { name: 'عرض وطباعة الإيصال' }).click();
  await expect(
    page.getByRole('dialog', { name: 'تفاصيل الإيصال' }),
  ).toBeVisible();
  await page
    .getByRole('dialog', { name: 'تفاصيل الإيصال' })
    .getByRole('button', { name: 'طباعة الإيصال', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __printCalls?: number }).__printCalls ??
          0,
      ),
    )
    .toBe(3);
  await page.getByRole('button', { name: 'إغلاق' }).click();

  await page.getByRole('button', { name: 'التقارير' }).click();
  await expect(
    page.getByRole('heading', { name: 'تقارير المبيعات' }),
  ).toBeVisible();
  await expect(
    page
      .locator('.kpi')
      .filter({ hasText: 'الطلبات المدفوعة' })
      .locator('strong'),
  ).toHaveText('1');

  await page.getByRole('button', { name: 'المشتريات' }).click();
  await expect(
    page.getByRole('heading', { name: 'المشتريات', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'إضافة مشتريات' }).click();
  const purchaseDialog = page.getByRole('dialog', { name: 'إضافة مشتريات' });
  await purchaseDialog.getByLabel('اسم المشتريات').fill('أرز بسمتي');
  await purchaseDialog.getByLabel('الكمية').fill('1.5');
  await purchaseDialog.getByLabel('الوحدة (اختياري)').fill('كيلو');
  await purchaseDialog.getByLabel('سعر الوحدة (ج.م)').fill('32.5');
  await purchaseDialog.getByLabel('التاريخ').fill('2026-10-25');
  await expect(purchaseDialog.getByText('الإجمالي المتوقع')).toBeVisible();
  await purchaseDialog.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.locator('.purchases-table')).toContainText('أرز بسمتي');
  await expect(page.locator('.purchases-table')).toContainText('٤٨٫٧٥');
  await page.getByRole('button', { name: 'تعديل' }).click();
  const editPurchaseDialog = page.getByRole('dialog', {
    name: 'تعديل المشتريات',
  });
  await editPurchaseDialog.getByLabel('اسم المشتريات').fill('أرز فاخر');
  await editPurchaseDialog.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.locator('.purchases-table')).toContainText('أرز فاخر');
  await page.getByLabel('بحث عن مشتريات').fill('فاخر');
  await expect(page.locator('.purchases-table')).toContainText('أرز فاخر');
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1366, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.screenshot({
    path: 'test-results/purchases-management-1366x768.png',
    fullPage: false,
  });

  await page.getByRole('button', { name: 'النسخ الاحتياطية' }).click();
  await expect(
    page.getByRole('heading', { name: 'النسخ الاحتياطية' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'اختيار مجلد' })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'إدخال مسار يدوي' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'فتح المجلد' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'إنشاء نسخة الآن' }),
  ).toHaveCount(0);
  await expect(page.getByText(/هذا المسار للعرض فقط/)).toBeVisible();
  await expect(page.getByText('تُنشأ نسخ آمنة تلقائيًا')).toBeVisible();
  await expect(
    page.getByText('الاستعادة من الواجهة متوقفة مؤقتًا'),
  ).toBeVisible();
  await expect(
    page.getByText('الاستعادة تعتمد على مشرف تشغيل موثوق'),
  ).toBeVisible();
  (page as Page & { assertClean: () => void }).assertClean();

  const cookies = await page.context().cookies();
  const cookie = cookies
    .map((value) => `${value.name}=${value.value}`)
    .join('; ');
  const denied = await request.get('/api/admin/reports/summary', {
    headers: { Cookie: cookie.replace(/[^;]*pos_session[^;]*/i, '') },
  });
  expect([401, 403]).toContain(denied.status());

  await page.getByRole('button', { name: 'تسجيل الخروج' }).click();
  await expect(
    page.getByRole('heading', { name: 'تسجيل الدخول' }),
  ).toBeVisible();
  await page.getByLabel('اسم المستخدم').fill('cashier');
  await page.getByLabel('كلمة المرور').fill(password);
  await page.getByRole('button', { name: 'تسجيل الدخول' }).click();
  await expect(page.getByRole('button', { name: 'التقارير' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'المشتريات' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'الطلبات' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'النسخ الاحتياطية' }),
  ).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(async () =>
        fetch('/api/admin/reports/summary').then((response) => response.status),
      ),
    )
    .toBe(403);
  await expect
    .poll(async () =>
      page.evaluate(async () =>
        fetch('/api/admin/backups').then((response) => response.status),
      ),
    )
    .toBe(403);
  await expect
    .poll(async () =>
      page.evaluate(async () =>
        fetch('/api/admin/purchases').then((response) => response.status),
      ),
    )
    .toBe(403);

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.locator('.app-shell')).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }
});
