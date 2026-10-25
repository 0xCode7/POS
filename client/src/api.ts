export type Role = 'admin' | 'cashier';
export type User = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  active: boolean;
  createdAt: string;
};
export type MenuCategory = {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
};
export type MenuItem = {
  id: string;
  categoryId: string;
  categoryName: string;
  name: string;
  description: string | null;
  priceMinor: number;
  isAvailable: boolean;
  isArchived: boolean;
  sortOrder: number;
};
export type Page<T> = {
  items: T[];
  pagination: { page: number; limit: number; total: number; pages: number };
};
export type Purchase = {
  id: string;
  name: string;
  quantityMilli: number;
  unit: string | null;
  unitPriceMinor: number;
  totalMinor: number;
  purchaseDate: string;
  createdAt: number;
  updatedAt: number;
};
export type OrderItem = {
  id: string;
  menuItemId: string;
  itemNameSnapshot: string;
  unitPriceMinor: number;
  quantity: number;
  lineTotalMinor: number;
  notes: string | null;
};
export type Order = {
  id: string;
  orderNumber: string;
  status: 'OPEN' | 'CANCELLED' | 'PAID';
  subtotalMinor: number;
  totalMinor: number;
  version: number;
  cancellationReason: string | null;
  createdAt: string;
  cancelledAt: string | null;
  createdByUserId: string;
  cancelledByUserId: string | null;
  items: OrderItem[];
  updatedAt: string;
};
export type ReceiptSnapshot = {
  receiptNumber: string;
  orderNumber: string;
  paidAt: string;
  items: Array<{
    name: string;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
    notes: string | null;
  }>;
  subtotalMinor: number;
  totalMinor: number;
  cashTenderedMinor: number;
  changeMinor: number;
  paymentMethod: 'CASH';
};
export type Receipt = {
  id: string;
  receiptNumber: string;
  orderId: string;
  createdAt: string;
  snapshot: ReceiptSnapshot;
  printAttempts: Array<{
    id: string;
    outcome: 'DIALOG_OPENED' | 'ERROR';
    createdAt: string;
  }>;
};
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class ApiConnectionError extends Error {
  constructor() {
    super(
      'تعذر الاتصال بالخدمة المحلية. تحقق من تشغيل التطبيق ثم أعد تحميل الصفحة أو أعد تشغيله.',
    );
  }
}

function apiUrl(path: string) {
  const url = new URL(path, window.location.origin);
  if (
    url.origin !== window.location.origin ||
    !url.pathname.startsWith('/api/')
  )
    throw new Error('مسار API محلي غير صالح.');
  return url;
}

function reportApiDiagnostic(input: {
  path: string;
  kind: 'request' | 'response' | 'network-error';
  status?: number;
}) {
  window.restaurantDesktop?.reportApiDiagnostic(input);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = apiUrl(path);
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (init.method && init.method !== 'GET')
    headers.set('X-CSRF-Protection', '1');
  reportApiDiagnostic({ path: url.pathname, kind: 'request' });
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers,
      credentials: 'same-origin',
    });
  } catch {
    reportApiDiagnostic({ path: url.pathname, kind: 'network-error' });
    throw new ApiConnectionError();
  }
  reportApiDiagnostic({
    path: url.pathname,
    kind: 'response',
    status: response.status,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string | { message?: string };
    };
    throw new ApiError(
      response.status,
      (typeof body.error === 'string' ? body.error : body.error?.message) ??
        `Request failed (${response.status}).`,
    );
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}
export function errorMessage(error: unknown) {
  if (error instanceof ApiConnectionError) return error.message;
  return error instanceof Error ? error.message : 'حدث خطأ غير متوقع.';
}
