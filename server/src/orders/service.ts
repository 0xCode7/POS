import { and, asc, count, desc, eq, like, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import {
  idempotencyRecords,
  menuCategories,
  menuItems,
  orderEvents,
  orderItems,
  orders,
  receipts,
} from '../db/schema.js';

export class OrderService {
  constructor(private readonly database: AppDatabase) {}
  list(page: number, limit: number, status?: 'OPEN' | 'CANCELLED' | 'PAID') {
    const where = status ? eq(orders.status, status) : undefined;
    const rows = this.database.db
      .select()
      .from(orders)
      .where(where)
      .orderBy(desc(orders.updatedAt))
      .limit(limit)
      .offset((page - 1) * limit)
      .all();
    const total = this.database.db
      .select({ value: count() })
      .from(orders)
      .where(where)
      .get()!.value;
    return {
      orders: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }
  adminList(
    page: number,
    limit: number,
    status?: 'OPEN' | 'CANCELLED' | 'PAID',
    search?: string,
  ) {
    const filters = [
      sql`exists (select 1 from ${orderItems} where ${orderItems.orderId} = ${orders.id})`,
      status ? eq(orders.status, status) : undefined,
      search ? like(orders.orderNumber, `%${search}%`) : undefined,
    ].filter((filter) => filter !== undefined);
    const where = filters.length === 0 ? undefined : and(...filters);
    const rows = this.database.db
      .select()
      .from(orders)
      .where(where)
      .orderBy(desc(orders.updatedAt))
      .limit(limit)
      .offset((page - 1) * limit)
      .all();
    const total = this.database.db
      .select({ value: count() })
      .from(orders)
      .where(where)
      .get()!.value;
    return {
      orders: rows.map((order) => this.withActorNames(order)),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }
  adminGet(id: string) {
    return this.withActorNames(this.get(id));
  }
  get(id: string) {
    const order = this.database.db
      .select()
      .from(orders)
      .where(eq(orders.id, id))
      .get();
    if (!order)
      throw new OrderError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    const items = this.database.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, id))
      .orderBy(asc(orderItems.createdAt))
      .all();
    const events = this.database.db
      .select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, id))
      .orderBy(asc(orderEvents.createdAt))
      .all()
      .map((event) => ({
        ...event,
        metadata: JSON.parse(event.metadataJson) as unknown,
        metadataJson: undefined,
      }));
    return { ...order, items, events };
  }
  create(actorId: string, key: string) {
    return this.database.sqlite
      .transaction(() => {
        const prior = this.idempotent('CREATE_ORDER', key);
        if (prior) return this.get(prior);
        const sequence = this.database.sqlite
          .prepare(
            'SELECT next_value AS value FROM order_number_sequence WHERE singleton = 1',
          )
          .get() as { value: number };
        this.database.sqlite
          .prepare(
            'UPDATE order_number_sequence SET next_value = next_value + 1 WHERE singleton = 1',
          )
          .run();
        const now = new Date();
        const id = randomUUID();
        const orderNumber = `ORD-${String(sequence.value).padStart(6, '0')}`;
        this.database.db
          .insert(orders)
          .values({
            id,
            orderNumber,
            status: 'OPEN',
            createdByUserId: actorId,
            subtotalMinor: 0,
            totalMinor: 0,
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        this.event(id, actorId, 'ORDER_CREATED', { orderNumber });
        this.remember('CREATE_ORDER', key, id);
        return this.get(id);
      })
      .immediate();
  }
  addItem(
    orderId: string,
    actorId: string,
    key: string,
    input: {
      menuItemId: string;
      quantity: number;
      notes?: string | null;
      expectedVersion: number;
    },
  ) {
    return this.database.sqlite
      .transaction(() => {
        const prior = this.idempotent('ADD_ITEM', key);
        if (prior) return this.get(prior);
        const order = this.mutableOrder(orderId, input.expectedVersion);
        const menu = this.database.db
          .select({ item: menuItems, categoryActive: menuCategories.isActive })
          .from(menuItems)
          .innerJoin(
            menuCategories,
            eq(menuItems.categoryId, menuCategories.id),
          )
          .where(eq(menuItems.id, input.menuItemId))
          .get();
        if (!menu)
          throw new OrderError(
            404,
            'MENU_ITEM_NOT_FOUND',
            'Menu item not found.',
          );
        if (
          !menu.item.isAvailable ||
          menu.item.isArchived ||
          !menu.categoryActive
        )
          throw new OrderError(
            409,
            'ITEM_UNAVAILABLE',
            'This menu item is not currently available.',
          );
        const now = new Date();
        const id = randomUUID();
        this.database.db
          .insert(orderItems)
          .values({
            id,
            orderId,
            menuItemId: menu.item.id,
            itemNameSnapshot: menu.item.name,
            unitPriceMinor: menu.item.priceMinor,
            quantity: input.quantity,
            lineTotalMinor: menu.item.priceMinor * input.quantity,
            notes: normalizeNotes(input.notes),
            createdAt: now,
            updatedAt: now,
          })
          .run();
        this.recalculate(orderId, order.version, now);
        this.event(orderId, actorId, 'ITEM_ADDED', {
          orderItemId: id,
          menuItemId: menu.item.id,
          quantity: input.quantity,
        });
        this.remember('ADD_ITEM', key, orderId);
        return this.get(orderId);
      })
      .immediate();
  }
  updateItem(
    orderId: string,
    itemId: string,
    actorId: string,
    input: { quantity: number; notes?: string | null; expectedVersion: number },
  ) {
    return this.database.sqlite
      .transaction(() => {
        const order = this.mutableOrder(orderId, input.expectedVersion);
        const item = this.orderItem(orderId, itemId);
        const now = new Date();
        this.database.db
          .update(orderItems)
          .set({
            quantity: input.quantity,
            notes:
              input.notes === undefined
                ? item.notes
                : normalizeNotes(input.notes),
            lineTotalMinor: item.unitPriceMinor * input.quantity,
            updatedAt: now,
          })
          .where(eq(orderItems.id, itemId))
          .run();
        this.recalculate(orderId, order.version, now);
        this.event(orderId, actorId, 'ITEM_UPDATED', {
          orderItemId: itemId,
          quantity: input.quantity,
        });
        return this.get(orderId);
      })
      .immediate();
  }
  removeItem(
    orderId: string,
    itemId: string,
    actorId: string,
    expectedVersion: number,
  ) {
    return this.database.sqlite
      .transaction(() => {
        const order = this.mutableOrder(orderId, expectedVersion);
        this.orderItem(orderId, itemId);
        this.database.db
          .delete(orderItems)
          .where(eq(orderItems.id, itemId))
          .run();
        const now = new Date();
        this.recalculate(orderId, order.version, now);
        this.event(orderId, actorId, 'ITEM_REMOVED', { orderItemId: itemId });
        return this.get(orderId);
      })
      .immediate();
  }
  cancel(
    orderId: string,
    actorId: string,
    reason: string,
    expectedVersion: number,
  ) {
    return this.database.sqlite
      .transaction(() => {
        const order = this.mutableOrder(orderId, expectedVersion);
        const now = new Date();
        const result = this.database.db
          .update(orders)
          .set({
            status: 'CANCELLED',
            cancelledAt: now,
            cancelledByUserId: actorId,
            cancellationReason: reason.trim(),
            updatedAt: now,
            version: order.version + 1,
          })
          .where(and(eq(orders.id, orderId), eq(orders.version, order.version)))
          .run();
        if (result.changes !== 1)
          throw new OrderError(
            409,
            'VERSION_CONFLICT',
            'Order was changed by another user. Refresh and try again.',
          );
        this.event(orderId, actorId, 'ORDER_CANCELLED', {
          reason: reason.trim(),
        });
        return this.get(orderId);
      })
      .immediate();
  }
  discardEmpty(orderId: string, expectedVersion: number) {
    this.database.sqlite
      .transaction(() => {
        const order = this.mutableOrder(orderId, expectedVersion);
        const itemCount = this.database.db
          .select({ value: count() })
          .from(orderItems)
          .where(eq(orderItems.orderId, orderId))
          .get()!.value;
        if (itemCount !== 0 || order.totalMinor !== 0)
          throw new OrderError(
            409,
            'ORDER_NOT_EMPTY',
            'Only an empty open order can be discarded.',
          );
        this.database.db
          .delete(idempotencyRecords)
          .where(eq(idempotencyRecords.orderId, orderId))
          .run();
        this.database.db
          .delete(orderEvents)
          .where(eq(orderEvents.orderId, orderId))
          .run();
        const deleted = this.database.db
          .delete(orders)
          .where(
            and(
              eq(orders.id, orderId),
              eq(orders.version, expectedVersion),
              eq(orders.status, 'OPEN'),
            ),
          )
          .run();
        if (deleted.changes !== 1)
          throw new OrderError(
            409,
            'VERSION_CONFLICT',
            'Order was changed by another user. Refresh and try again.',
          );
      })
      .immediate();
  }
  private withActorNames<
    T extends {
      id: string;
      createdByUserId: string;
      cancelledByUserId: string | null;
    },
  >(order: T) {
    const createdBy = this.database.sqlite
      .prepare('SELECT display_name AS displayName FROM users WHERE id = ?')
      .get(order.createdByUserId) as { displayName: string } | undefined;
    const cancelledBy = order.cancelledByUserId
      ? (this.database.sqlite
          .prepare('SELECT display_name AS displayName FROM users WHERE id = ?')
          .get(order.cancelledByUserId) as { displayName: string } | undefined)
      : undefined;
    const receipt = this.database.db
      .select({ id: receipts.id, receiptNumber: receipts.receiptNumber })
      .from(receipts)
      .where(eq(receipts.orderId, order.id))
      .get();
    return {
      ...order,
      createdByDisplayName: createdBy?.displayName ?? 'مستخدم غير متاح',
      cancelledByDisplayName: cancelledBy?.displayName ?? null,
      receiptId: receipt?.id ?? null,
      receiptNumber: receipt?.receiptNumber ?? null,
    };
  }
  private mutableOrder(id: string, version: number) {
    const order = this.database.db
      .select()
      .from(orders)
      .where(eq(orders.id, id))
      .get();
    if (!order)
      throw new OrderError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    if (order.status !== 'OPEN')
      throw new OrderError(
        409,
        'ORDER_NOT_OPEN',
        'Only open orders can be changed.',
      );
    if (order.version !== version)
      throw new OrderError(
        409,
        'VERSION_CONFLICT',
        'Order was changed by another user. Refresh and try again.',
      );
    return order;
  }
  private orderItem(orderId: string, id: string) {
    const item = this.database.db
      .select()
      .from(orderItems)
      .where(and(eq(orderItems.id, id), eq(orderItems.orderId, orderId)))
      .get();
    if (!item)
      throw new OrderError(
        404,
        'ORDER_ITEM_NOT_FOUND',
        'Order item not found.',
      );
    return item;
  }
  private recalculate(orderId: string, version: number, now: Date) {
    const total =
      this.database.db
        .select({
          value: sql<number>`coalesce(sum(${orderItems.lineTotalMinor}), 0)`,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
        .get()?.value ?? 0;
    const changed = this.database.db
      .update(orders)
      .set({
        subtotalMinor: total,
        totalMinor: total,
        version: version + 1,
        updatedAt: now,
      })
      .where(and(eq(orders.id, orderId), eq(orders.version, version)))
      .run();
    if (changed.changes !== 1)
      throw new OrderError(
        409,
        'VERSION_CONFLICT',
        'Order was changed by another user. Refresh and try again.',
      );
  }
  private event(
    orderId: string,
    actorUserId: string,
    eventType: string,
    metadata: unknown,
  ) {
    this.database.db
      .insert(orderEvents)
      .values({
        id: randomUUID(),
        orderId,
        actorUserId,
        eventType,
        metadataJson: JSON.stringify(metadata),
        createdAt: new Date(),
      })
      .run();
  }
  private idempotent(operation: string, key: string) {
    return this.database.db
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.operationType, operation),
          eq(idempotencyRecords.idempotencyKey, key),
        ),
      )
      .get()?.orderId;
  }
  private remember(
    operationType: string,
    idempotencyKey: string,
    orderId: string,
  ) {
    this.database.db
      .insert(idempotencyRecords)
      .values({
        id: randomUUID(),
        operationType,
        idempotencyKey,
        orderId,
        createdAt: new Date(),
      })
      .run();
  }
}
function normalizeNotes(value: string | null | undefined) {
  const notes = value?.trim().replace(/\s+/g, ' ');
  return notes || null;
}
export class OrderError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}
