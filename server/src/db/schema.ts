import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin', 'cashier'] }).notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('users_username_unique').on(table.username),
    index('users_role_active_idx').on(table.role, table.active),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
    index('sessions_user_id_idx').on(table.userId),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

export const menuCategories = sqliteTable(
  'menu_categories',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('menu_categories_name_unique').on(table.name),
    index('menu_categories_active_sort_idx').on(
      table.isActive,
      table.sortOrder,
    ),
  ],
);

export const menuItems = sqliteTable(
  'menu_items',
  {
    id: text('id').primaryKey(),
    categoryId: text('category_id')
      .notNull()
      .references(() => menuCategories.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    priceMinor: integer('price_minor').notNull(),
    isAvailable: integer('is_available', { mode: 'boolean' })
      .notNull()
      .default(true),
    isArchived: integer('is_archived', { mode: 'boolean' })
      .notNull()
      .default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('menu_items_category_name_unique').on(
      table.categoryId,
      table.name,
    ),
    index('menu_items_category_state_sort_idx').on(
      table.categoryId,
      table.isArchived,
      table.isAvailable,
      table.sortOrder,
    ),
    index('menu_items_name_idx').on(table.name),
  ],
);

export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey(),
    orderNumber: text('order_number').notNull(),
    status: text('status', { enum: ['OPEN', 'CANCELLED', 'PAID'] })
      .notNull()
      .default('OPEN'),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    subtotalMinor: integer('subtotal_minor').notNull().default(0),
    totalMinor: integer('total_minor').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    cancelledAt: integer('cancelled_at', { mode: 'timestamp_ms' }),
    cancelledByUserId: text('cancelled_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    cancellationReason: text('cancellation_reason'),
  },
  (table) => [
    uniqueIndex('orders_order_number_unique').on(table.orderNumber),
    index('orders_status_updated_idx').on(table.status, table.updatedAt),
  ],
);

export const orderItems = sqliteTable(
  'order_items',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    menuItemId: text('menu_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'restrict' }),
    itemNameSnapshot: text('item_name_snapshot').notNull(),
    unitPriceMinor: integer('unit_price_minor').notNull(),
    quantity: integer('quantity').notNull(),
    lineTotalMinor: integer('line_total_minor').notNull(),
    notes: text('notes'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [index('order_items_order_id_idx').on(table.orderId)],
);

export const orderEvents = sqliteTable(
  'order_events',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    metadataJson: text('metadata_json').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('order_events_order_created_idx').on(table.orderId, table.createdAt),
  ],
);

export const idempotencyRecords = sqliteTable(
  'idempotency_records',
  {
    id: text('id').primaryKey(),
    operationType: text('operation_type').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    requestFingerprint: text('request_fingerprint'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('idempotency_operation_key_unique').on(
      table.operationType,
      table.idempotencyKey,
    ),
    index('idempotency_created_at_idx').on(table.createdAt),
  ],
);

export const payments = sqliteTable(
  'payments',
  {
    id: text('id').primaryKey(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    method: text('method', { enum: ['CASH'] }).notNull(),
    amountDueMinor: integer('amount_due_minor').notNull(),
    cashTenderedMinor: integer('cash_tendered_minor').notNull(),
    changeMinor: integer('change_minor').notNull(),
    processedByUserId: text('processed_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('payments_order_unique').on(table.orderId),
    index('payments_created_at_idx').on(table.createdAt),
    index('payments_actor_created_idx').on(
      table.processedByUserId,
      table.createdAt,
    ),
  ],
);

export const receipts = sqliteTable(
  'receipts',
  {
    id: text('id').primaryKey(),
    receiptNumber: text('receipt_number').notNull(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    paymentId: text('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    snapshotJson: text('snapshot_json').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    uniqueIndex('receipts_receipt_number_unique').on(table.receiptNumber),
    uniqueIndex('receipts_order_unique').on(table.orderId),
    uniqueIndex('receipts_payment_unique').on(table.paymentId),
  ],
);

export const printAttempts = sqliteTable(
  'print_attempts',
  {
    id: text('id').primaryKey(),
    receiptId: text('receipt_id')
      .notNull()
      .references(() => receipts.id, { onDelete: 'restrict' }),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    outcome: text('outcome', { enum: ['DIALOG_OPENED', 'ERROR'] }).notNull(),
    errorMessage: text('error_message'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    index('print_attempts_receipt_created_idx').on(
      table.receiptId,
      table.createdAt,
    ),
  ],
);

/**
 * Administrative operating costs. These records intentionally have no
 * relationship to menu items, inventory, orders, payments, or sales reports.
 */
export const purchases = sqliteTable(
  'purchases',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    // Quantity is stored in thousandths so fractional units remain exact.
    quantityMilli: integer('quantity_milli').notNull(),
    unit: text('unit'),
    unitPriceMinor: integer('unit_price_minor').notNull(),
    totalMinor: integer('total_minor').notNull(),
    // A Cairo-local calendar date chosen by the administrator (YYYY-MM-DD).
    purchaseDate: text('purchase_date').notNull(),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    updatedByUserId: text('updated_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    deletedByUserId: text('deleted_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
  },
  (table) => [
    index('purchases_active_date_idx').on(table.deletedAt, table.purchaseDate),
    index('purchases_name_idx').on(table.name),
  ],
);

export type UserRole = 'admin' | 'cashier';
export type User = typeof users.$inferSelect;
export type MenuCategory = typeof menuCategories.$inferSelect;
export type MenuItem = typeof menuItems.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Purchase = typeof purchases.$inferSelect;
