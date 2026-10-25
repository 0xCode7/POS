import fs from 'node:fs';

const [base, stateFile] = process.argv.slice(2);
if (!base || !stateFile) {
  throw new Error(
    'Usage: node seed-legacy-upgrade-fixture.mjs <base-url> <state-file>',
  );
}

const username = process.env.POS_UPGRADE_TEST_USERNAME;
const password = process.env.POS_UPGRADE_TEST_PASSWORD;
if (!username || !password) {
  throw new Error(
    'POS_UPGRADE_TEST_USERNAME and POS_UPGRADE_TEST_PASSWORD are required.',
  );
}

let cookie = '';
function headers(extra = {}) {
  return {
    accept: 'application/json',
    origin: base,
    cookie,
    'x-csrf-protection': '1',
    ...extra,
  };
}

async function request(path, options = {}, accepted = [200, 201, 202, 204]) {
  const response = await fetch(base + path, {
    ...options,
    headers: headers(options.headers),
  });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies[0]) cookie = setCookies[0].split(';', 1)[0];
  const body = response.status === 204 ? undefined : await response.json();
  if (!accepted.includes(response.status)) {
    throw new Error(
      `${options.method ?? 'GET'} ${path}: ${response.status} ${JSON.stringify(body)}`,
    );
  }
  return body;
}

await request(
  '/api/auth/setup',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      displayName: 'مدير اختبار الترقية',
      password,
    }),
  },
  [201],
);
await request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password }),
});
const category = await request('/api/admin/menu/categories', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'مشروبات الاختبار',
    sortOrder: 1,
    isActive: true,
  }),
});
const item = await request('/api/admin/menu/items', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    categoryId: category.category.id,
    name: 'شاي إلكترون',
    description: null,
    priceMinor: 2500,
    sortOrder: 1,
    isAvailable: true,
  }),
});
const order = await request('/api/orders', {
  method: 'POST',
  headers: { 'idempotency-key': 'legacy-upgrade-order-001' },
});
const changedOrder = await request(`/api/orders/${order.order.id}/items`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'idempotency-key': 'legacy-upgrade-item-001',
  },
  body: JSON.stringify({
    menuItemId: item.item.id,
    quantity: 1,
    expectedVersion: order.order.version,
  }),
});
const receipt = await request(`/api/orders/${order.order.id}/checkout`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'idempotency-key': 'legacy-upgrade-checkout-001',
  },
  body: JSON.stringify({
    cashTenderedMinor: 3000,
    expectedVersion: changedOrder.order.version,
  }),
});
const verifiedReceipt = await request(`/api/receipts/${receipt.receipt.id}`);
if (verifiedReceipt.receipt.payment?.amountDueMinor !== 2500) {
  throw new Error('Legacy paid receipt did not retain the expected amount.');
}

fs.writeFileSync(
  stateFile,
  JSON.stringify({
    username,
    orderId: order.order.id,
    receiptId: receipt.receipt.id,
    amountDueMinor: 2500,
  }),
  null,
  2,
);
console.log('Legacy admin, menu item, paid order, and receipt created.');
