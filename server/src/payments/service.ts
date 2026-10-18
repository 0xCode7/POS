import { and, asc, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import {
  idempotencyRecords,
  orderEvents,
  orderItems,
  orders,
  payments,
  printAttempts,
  receipts,
} from '../db/schema.js';
import { OrderError } from '../orders/service.js';

export class PaymentService {
  constructor(private readonly database: AppDatabase) {}

  checkout(
    orderId: string,
    actorId: string,
    key: string,
    input: { cashTenderedMinor: number; expectedVersion: number },
  ) {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    return this.database.sqlite
      .transaction(() => {
        const prior = this.database.db
          .select()
          .from(idempotencyRecords)
          .where(
            and(
              eq(idempotencyRecords.operationType, 'CHECKOUT'),
              eq(idempotencyRecords.idempotencyKey, key),
            ),
          )
          .get();
        if (prior) {
          if (
            prior.requestFingerprint !== fingerprint ||
            prior.orderId !== orderId
          )
            throw new OrderError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This idempotency key was already used with a different checkout request.',
            );
          return this.byOrder(prior.orderId);
        }
        const order = this.database.db
          .select()
          .from(orders)
          .where(eq(orders.id, orderId))
          .get();
        if (!order)
          throw new OrderError(404, 'ORDER_NOT_FOUND', 'Order not found.');
        if (order.status !== 'OPEN')
          throw new OrderError(
            409,
            'ORDER_NOT_OPEN',
            'Only open orders can be paid.',
          );
        if (order.version !== input.expectedVersion)
          throw new OrderError(
            409,
            'VERSION_CONFLICT',
            'Order was changed by another user. Refresh and try again.',
          );
        const items = this.database.db
          .select()
          .from(orderItems)
          .where(eq(orderItems.orderId, orderId))
          .orderBy(asc(orderItems.createdAt))
          .all();
        if (items.length === 0)
          throw new OrderError(
            409,
            'EMPTY_ORDER',
            'An empty order cannot be paid.',
          );
        const total = items.reduce(
          (sum, item) => sum + item.unitPriceMinor * item.quantity,
          0,
        );
        if (input.cashTenderedMinor < total)
          throw new OrderError(
            400,
            'INSUFFICIENT_CASH',
            'Cash tendered is less than the order total.',
          );
        const now = new Date();
        const paymentId = randomUUID();
        const receiptId = randomUUID();
        const sequence = this.database.sqlite
          .prepare(
            'SELECT next_value AS value FROM receipt_number_sequence WHERE singleton = 1',
          )
          .get() as { value: number };
        this.database.sqlite
          .prepare(
            'UPDATE receipt_number_sequence SET next_value = next_value + 1 WHERE singleton = 1',
          )
          .run();
        const receiptNumber = `RCP-${String(sequence.value).padStart(6, '0')}`;
        const changeMinor = input.cashTenderedMinor - total;
        this.database.db
          .insert(payments)
          .values({
            id: paymentId,
            orderId,
            method: 'CASH',
            amountDueMinor: total,
            cashTenderedMinor: input.cashTenderedMinor,
            changeMinor,
            processedByUserId: actorId,
            createdAt: now,
          })
          .run();
        const snapshot = {
          receiptNumber,
          orderNumber: order.orderNumber,
          paidAt: now.toISOString(),
          items: items.map((item) => ({
            name: item.itemNameSnapshot,
            unitPriceMinor: item.unitPriceMinor,
            quantity: item.quantity,
            lineTotalMinor: item.unitPriceMinor * item.quantity,
            notes: item.notes,
          })),
          subtotalMinor: total,
          totalMinor: total,
          cashTenderedMinor: input.cashTenderedMinor,
          changeMinor,
          paymentMethod: 'CASH' as const,
        };
        this.database.db
          .insert(receipts)
          .values({
            id: receiptId,
            receiptNumber,
            orderId,
            paymentId,
            snapshotJson: JSON.stringify(snapshot),
            createdAt: now,
          })
          .run();
        const changed = this.database.db
          .update(orders)
          .set({
            status: 'PAID',
            subtotalMinor: total,
            totalMinor: total,
            version: order.version + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(orders.id, orderId),
              eq(orders.version, order.version),
              eq(orders.status, 'OPEN'),
            ),
          )
          .run();
        if (changed.changes !== 1)
          throw new OrderError(
            409,
            'VERSION_CONFLICT',
            'Order was changed by another user. Refresh and try again.',
          );
        this.database.db
          .insert(orderEvents)
          .values({
            id: randomUUID(),
            orderId,
            actorUserId: actorId,
            eventType: 'ORDER_PAID',
            metadataJson: JSON.stringify({
              paymentId,
              receiptId,
              totalMinor: total,
              cashTenderedMinor: input.cashTenderedMinor,
              changeMinor,
            }),
            createdAt: now,
          })
          .run();
        this.database.db
          .insert(idempotencyRecords)
          .values({
            id: randomUUID(),
            operationType: 'CHECKOUT',
            idempotencyKey: key,
            orderId,
            requestFingerprint: fingerprint,
            createdAt: now,
          })
          .run();
        return this.byOrder(orderId);
      })
      .immediate();
  }

  get(receiptId: string) {
    const receipt = this.database.db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptId))
      .get();
    if (!receipt)
      throw new OrderError(404, 'RECEIPT_NOT_FOUND', 'Receipt not found.');
    const payment = this.database.db
      .select()
      .from(payments)
      .where(eq(payments.id, receipt.paymentId))
      .get()!;
    const attempts = this.database.db
      .select()
      .from(printAttempts)
      .where(eq(printAttempts.receiptId, receiptId))
      .orderBy(asc(printAttempts.createdAt))
      .all();
    return {
      ...receipt,
      snapshot: JSON.parse(receipt.snapshotJson) as unknown,
      snapshotJson: undefined,
      payment,
      printAttempts: attempts,
    };
  }

  recordPrint(
    receiptId: string,
    actorId: string,
    input: { outcome: 'DIALOG_OPENED' | 'ERROR'; errorMessage?: string | null },
  ) {
    this.get(receiptId);
    this.database.db
      .insert(printAttempts)
      .values({
        id: randomUUID(),
        receiptId,
        actorUserId: actorId,
        outcome: input.outcome,
        errorMessage: input.errorMessage?.trim().slice(0, 500) || null,
        createdAt: new Date(),
      })
      .run();
    return this.get(receiptId);
  }

  private byOrder(orderId: string) {
    const receipt = this.database.db
      .select()
      .from(receipts)
      .where(eq(receipts.orderId, orderId))
      .get();
    if (!receipt)
      throw new OrderError(
        500,
        'SETTLEMENT_INCOMPLETE',
        'Settlement record is incomplete.',
      );
    return this.get(receipt.id);
  }
}
