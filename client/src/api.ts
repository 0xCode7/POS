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
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (init.method && init.method !== 'GET')
    headers.set('X-CSRF-Protection', '1');
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
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
  return error instanceof Error ? error.message : 'حدث خطأ غير متوقع.';
}
