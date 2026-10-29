import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types, ClientSession } from 'mongoose';
import { ReservationsService, OrderInventoryContext, ReturnLineInput } from './reservations.service';
import { MovementsService } from './movements.service';
import { InventoryReservation, InventoryReservationDocument } from '../schemas/inventory-reservation.schema';
import { InventoryBalance, InventoryBalanceDocument } from '../schemas/inventory-balance.schema';
import { ProductVariant, ProductVariantDocument } from '../schemas/product-variant.schema';
import { Order, OrderDocument } from '../../orders/schemas/order.schema';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';

/**
 * Inventory correctness for order lifecycle transitions (PLAN_INVENTORY §7).
 *
 * These tests pin the four rules the reservations engine is built on, because each one is
 * a defect that only shows up under load or retry, never in a happy-path click-through:
 *
 *  1. The reservation row is the exactly-once gate — a repeated confirmation cannot reserve
 *     twice, and a retried dispatch cannot deduct twice.
 *  2. A cancel that lands after dispatch must NOT put stock back (it writes a zero-delta
 *     correction instead).
 *  3. Every balance change is a guarded compare-and-set that refuses to drive `reserved` or
 *     `onHand` below zero.
 *  4. The status→inventory mapping lives in exactly one place (`onStatusChange`), so
 *     `update`, `bulkAction` and `bulkShip` cannot drift apart.
 *
 * All public methods are called with an explicit session so `withOptionalSession` runs the
 * work inline — no replica-set probe, and the assertions are about inventory logic rather
 * than transaction plumbing.
 */

const STORE_ID = new Types.ObjectId();
const OTHER_STORE_ID = new Types.ObjectId();
const ORDER_ID = new Types.ObjectId();
const VARIANT_ID = new Types.ObjectId();
const BALANCE_ID = new Types.ObjectId();
const RESERVATION_ID = new Types.ObjectId();
const ACTOR_ID = new Types.ObjectId();
const SESSION = {} as ClientSession;

const ORDER_NO = 'ORD-2026-000123';

/** A query-chain stub: every mongoose builder method returns itself, `.exec()` resolves. */
const query = (result: unknown) => {
  const q: any = {};
  for (const m of ['sort', 'limit', 'skip', 'select', 'lean', 'populate', 'session']) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.exec = jest.fn().mockResolvedValue(result);
  return q;
};

describe('ReservationsService', () => {
  let service: ReservationsService;

  let reservationModel: any;
  let balanceModel: any;
  let variantModel: any;
  let orderModel: any;
  let movementsService: { append: jest.Mock; hasMovement: jest.Mock; listForOrder: jest.Mock };

  const ctx = (overrides: Partial<OrderInventoryContext> = {}): OrderInventoryContext => ({
    orderId: ORDER_ID,
    orderNo: ORDER_NO,
    storeId: STORE_ID,
    items: [
      { lineId: 'line-1', variantId: VARIANT_ID.toString(), productId: 'p-1', quantity: 3 },
    ],
    ...overrides,
  });

  const balance = (over: Record<string, unknown> = {}) => ({
    _id: BALANCE_ID,
    storeId: STORE_ID,
    variantId: VARIANT_ID,
    onHand: 10,
    reserved: 2,
    ...over,
  });

  const reservation = (over: Record<string, unknown> = {}) => ({
    _id: RESERVATION_ID,
    storeId: STORE_ID,
    orderId: ORDER_ID,
    variantId: VARIANT_ID,
    orderItemIndex: 0,
    quantity: 3,
    status: 'active',
    ...over,
  });

  beforeEach(async () => {
    reservationModel = jest.fn().mockImplementation((data: any) => ({
      ...data,
      save: jest.fn().mockResolvedValue({ ...data, _id: RESERVATION_ID }),
    }));
    reservationModel.find = jest.fn();
    reservationModel.findOne = jest.fn();
    reservationModel.findOneAndUpdate = jest.fn();
    reservationModel.deleteOne = jest.fn().mockReturnValue(query(undefined));

    balanceModel = { find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() };
    variantModel = { find: jest.fn(), findOne: jest.fn() };
    orderModel = { findById: jest.fn(), updateOne: jest.fn() };

    movementsService = {
      append: jest.fn().mockResolvedValue(undefined),
      hasMovement: jest.fn().mockResolvedValue(false),
      listForOrder: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReservationsService,
        { provide: getModelToken(InventoryReservation.name), useValue: reservationModel },
        { provide: getModelToken(InventoryBalance.name), useValue: balanceModel },
        { provide: getModelToken(ProductVariant.name), useValue: variantModel },
        { provide: getModelToken(Order.name), useValue: orderModel },
        { provide: MovementsService, useValue: movementsService },
      ],
    }).compile();

    service = module.get<ReservationsService>(ReservationsService);
  });

  describe('onStatusChange() — the single status→inventory mapping', () => {
    it('routes confirmation to reserve()', async () => {
      (service as any).reserve = jest.fn().mockResolvedValue(undefined);

      await service.onStatusChange(ctx(), 'placed', 'confirmed', ACTOR_ID, SESSION);

      expect((service as any).reserve).toHaveBeenCalledWith(ctx(), ACTOR_ID, SESSION);
    });

    it('routes a pre-dispatch cancel to release()', async () => {
      (service as any).release = jest.fn().mockResolvedValue(undefined);

      await service.onStatusChange(ctx(), 'confirmed', 'cancelled', null, SESSION);

      expect((service as any).release).toHaveBeenCalledWith(ctx(), null, SESSION);
    });

    it('routes a post-dispatch cancel to the zero-delta correction, not release()', async () => {
      (service as any).release = jest.fn().mockResolvedValue(undefined);
      (service as any).recordPostDispatchCancellation = jest.fn().mockResolvedValue(undefined);

      await service.onStatusChange(ctx(), 'dispatched', 'cancelled', null, SESSION);

      expect((service as any).recordPostDispatchCancellation).toHaveBeenCalledWith(ctx(), null, SESSION);
      expect((service as any).release).not.toHaveBeenCalled();
    });

    it('routes dispatch to consume()', async () => {
      (service as any).consume = jest.fn().mockResolvedValue(undefined);

      await service.onStatusChange(ctx(), 'confirmed', 'dispatched', ACTOR_ID, SESSION);

      expect((service as any).consume).toHaveBeenCalledWith(ctx(), ACTOR_ID, SESSION);
    });

    it('gives in-transit, delivered and returned no stock effect', async () => {
      (service as any).reserve = jest.fn();
      (service as any).release = jest.fn();
      (service as any).consume = jest.fn();
      (service as any).recordPostDispatchCancellation = jest.fn();

      await service.onStatusChange(ctx(), 'dispatched', 'in-transit', null, SESSION);
      await service.onStatusChange(ctx(), 'in-transit', 'delivered', null, SESSION);
      await service.onStatusChange(ctx(), 'delivered', 'returned', null, SESSION);

      expect((service as any).reserve).not.toHaveBeenCalled();
      expect((service as any).release).not.toHaveBeenCalled();
      expect((service as any).consume).not.toHaveBeenCalled();
      expect((service as any).recordPostDispatchCancellation).not.toHaveBeenCalled();
    });
  });

  describe('reserve()', () => {
    it('reserves each variant line: CAS increment, reservation row, ledger row, stamp', async () => {
      variantModel.findOne.mockReturnValue(
        query({ _id: VARIANT_ID, storeId: STORE_ID, isActive: true, sku: 'SKU-1' }),
      );
      reservationModel.findOne.mockReturnValue(query(null));
      balanceModel.findOne.mockReturnValue(query(balance()));
      balanceModel.findOneAndUpdate.mockReturnValue(query(balance({ reserved: 5 })));
      orderModel.updateOne.mockReturnValue(query(undefined));

      await service.reserve(ctx(), ACTOR_ID, SESSION);

      expect(variantModel.findOne).toHaveBeenCalledWith({
        _id: VARIANT_ID,
        isDeleted: { $ne: true },
      });

      // The CAS predicate pins the values just read: a concurrent writer for the last unit
      // matches nothing instead of double-reserving.
      expect(balanceModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: BALANCE_ID, onHand: 10, reserved: 2 },
        { $inc: { reserved: 3 } },
        { new: true, session: SESSION },
      );

      expect(reservationModel).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: STORE_ID,
          orderId: ORDER_ID,
          variantId: VARIANT_ID,
          orderItemIndex: 0,
          quantity: 3,
          status: 'active',
        }),
      );

      expect(movementsService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'order_reservation',
          quantityDelta: 0,
          // Keyed on the reservation row, so re-reserving a line the same order released
          // (editing a confirmed order's items) cannot be swallowed by the first
          // confirmation's dedupe key.
          idempotencyKey: `reserve:${RESERVATION_ID.toString()}`,
        }),
      );

      expect(orderModel.updateOne).toHaveBeenCalledWith(
        { _id: ORDER_ID },
        { $set: { 'inventoryState.reservedAt': expect.any(Date) } },
        { session: SESSION },
      );
    });

    it('is idempotent: a line that already holds a reservation is skipped', async () => {
      variantModel.findOne.mockReturnValue(
        query({ _id: VARIANT_ID, storeId: STORE_ID, isActive: true, sku: 'SKU-1' }),
      );
      reservationModel.findOne.mockReturnValue(query(reservation()));
      balanceModel.findOneAndUpdate.mockReturnValue(query(balance()));
      orderModel.updateOne.mockReturnValue(query(undefined));

      await service.reserve(ctx(), ACTOR_ID, SESSION);

      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(reservationModel).not.toHaveBeenCalled();
      expect(movementsService.append).not.toHaveBeenCalled();
    });

    it('refuses to reserve when availability is short (INSUFFICIENT_STOCK)', async () => {
      variantModel.findOne.mockReturnValue(
        query({ _id: VARIANT_ID, storeId: STORE_ID, isActive: true, sku: 'SKU-1' }),
      );
      reservationModel.findOne.mockReturnValue(query(null));
      // 5 on hand, 4 already promised → 1 available against a requested 3.
      balanceModel.findOne.mockReturnValue(query(balance({ onHand: 5, reserved: 4 })));

      await expect(service.reserve(ctx(), ACTOR_ID, SESSION)).rejects.toMatchObject({
        errorCode: AppErrorCode.INSUFFICIENT_STOCK,
      });

      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(movementsService.append).not.toHaveBeenCalled();
    });

    it("refuses another store's variant (VARIANT_NOT_FOUND)", async () => {
      variantModel.findOne.mockReturnValue(
        query({ _id: VARIANT_ID, storeId: OTHER_STORE_ID, isActive: true, sku: 'SKU-1' }),
      );

      await expect(service.reserve(ctx(), ACTOR_ID, SESSION)).rejects.toMatchObject({
        errorCode: AppErrorCode.VARIANT_NOT_FOUND,
      });

      expect(balanceModel.findOne).not.toHaveBeenCalled();
    });

    it('refuses an inactive variant (VARIANT_INACTIVE)', async () => {
      variantModel.findOne.mockReturnValue(
        query({ _id: VARIANT_ID, storeId: STORE_ID, isActive: false, sku: 'SKU-1' }),
      );

      await expect(service.reserve(ctx(), ACTOR_ID, SESSION)).rejects.toMatchObject({
        errorCode: AppErrorCode.VARIANT_INACTIVE,
      });

      expect(balanceModel.findOne).not.toHaveBeenCalled();
    });

    it('refuses a non-integer or non-positive quantity (INVALID_QUANTITY)', async () => {
      await expect(
        service.reserve(ctx({ items: [{ variantId: VARIANT_ID.toString(), quantity: 0 }] }), null, SESSION),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.INVALID_QUANTITY });
    });

    it('is a no-op for an un-migrated order with no storeId', async () => {
      await service.reserve(ctx({ storeId: null }), ACTOR_ID, SESSION);

      expect(variantModel.findOne).not.toHaveBeenCalled();
      expect(balanceModel.findOne).not.toHaveBeenCalled();
      expect(orderModel.updateOne).not.toHaveBeenCalled();
    });

    it('is a no-op when the order has no variant lines', async () => {
      await service.reserve(
        ctx({ items: [{ lineId: 'line-1', variantId: null, quantity: 1 }] }),
        ACTOR_ID,
        SESSION,
      );

      expect(variantModel.findOne).not.toHaveBeenCalled();
      expect(orderModel.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('reconcileEditedLines() — a confirmed order edited in place', () => {
    const OTHER_VARIANT_ID = new Types.ObjectId();

    const swappedCtx = ctx({
      items: [
        { lineId: 'line-1', variantId: OTHER_VARIANT_ID.toString(), productId: 'p-1', quantity: 1 },
        { lineId: 'line-2', variantId: VARIANT_ID.toString(), productId: 'p-2', quantity: 2 },
      ],
    });

    it('releases the changed line, frees its key and reserves the replacement', async () => {
      const changed = reservation({ orderItemIndex: 0, variantId: VARIANT_ID, quantity: 2 });
      const untouched = reservation({
        _id: new Types.ObjectId(),
        orderItemIndex: 1,
        variantId: VARIANT_ID,
        quantity: 2,
      });

      variantModel.findOne.mockReturnValue(
        query({ _id: OTHER_VARIANT_ID, storeId: STORE_ID, isActive: true, sku: 'SKU-NEW' }),
      );
      reservationModel.find.mockReturnValue(query([changed, untouched]));
      reservationModel.findOneAndUpdate.mockReturnValue(
        query(reservation({ ...changed, status: 'released', releasedAt: new Date() })),
      );
      // The rows the balance reads: one for the release (reserved 2 → 0) and one for the new
      // claim against the replacement variant.
      balanceModel.findOne.mockReturnValue(query(balance()));
      balanceModel.findOneAndUpdate.mockReturnValue(query(balance({ reserved: 0 })));
      orderModel.updateOne.mockReturnValue(query(undefined));

      await service.reconcileEditedLines(swappedCtx, ACTOR_ID, SESSION);

      // Only line 0 is touched; line 2 still matches its active row on variant + quantity.
      expect(reservationModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(reservationModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: changed._id, status: 'active' },
        { $set: { status: 'released', releasedAt: expect.any(Date) } },
        { new: true, session: SESSION },
      );

      // The released row is deleted, not just flipped: the unique key on
      // {orderId, orderItemIndex} is what the re-reservation below has to claim.
      expect(reservationModel.deleteOne).toHaveBeenCalledWith({ _id: changed._id });

      // Exactly one new reservation, for the replacement line.
      expect(reservationModel).toHaveBeenCalledTimes(1);
      expect(reservationModel).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: ORDER_ID,
          orderItemIndex: 0,
          variantId: OTHER_VARIANT_ID,
          quantity: 1,
          status: 'active',
        }),
      );

      const appendTypes = movementsService.append.mock.calls.map((c: any[]) => c[0].type);
      expect(appendTypes).toEqual(['reservation_release', 'order_reservation']);

      // Both ledger rows are keyed on their reservation row, never on
      // {orderId, orderItemIndex}: a second reservation for the same index must not be
      // swallowed by the first confirmation's dedupe key.
      expect(movementsService.append).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          idempotencyKey: `release:${String(changed._id)}`,
        }),
      );
      expect(movementsService.append).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          type: 'order_reservation',
          // The replacement's own reservation row — a second `reserve:` for the same
          // {orderId, orderItemIndex} gets its own key instead of colliding with the
          // first confirmation's.
          idempotencyKey: `reserve:${RESERVATION_ID.toString()}`,
        }),
      );

      expect(orderModel.updateOne).toHaveBeenCalledWith(
        { _id: ORDER_ID },
        { $set: { 'inventoryState.reservedAt': expect.any(Date), 'inventoryState.releasedAt': expect.any(Date) } },
        { session: SESSION },
      );
    });

    it('moves no stock at all when only a price changed (variant and quantity untouched)', async () => {
      const active = reservation();

      variantModel.findOne.mockReturnValue(
        query({ _id: VARIANT_ID, storeId: STORE_ID, isActive: true, sku: 'SKU-1' }),
      );
      reservationModel.find.mockReturnValue(query([active]));

      await service.reconcileEditedLines(ctx(), ACTOR_ID, SESSION);

      expect(reservationModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(reservationModel.deleteOne).not.toHaveBeenCalled();
      expect(reservationModel).not.toHaveBeenCalled();
      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(movementsService.append).not.toHaveBeenCalled();
      expect(orderModel.updateOne).not.toHaveBeenCalled();
    });

    it('surfaces the claim failure so the caller aborts the whole edit', async () => {
      const changed = reservation({ orderItemIndex: 0, variantId: VARIANT_ID, quantity: 2 });

      variantModel.findOne.mockReturnValue(
        query({ _id: OTHER_VARIANT_ID, storeId: STORE_ID, isActive: true, sku: 'SKU-NEW' }),
      );
      reservationModel.find.mockReturnValue(query([changed]));
      reservationModel.findOneAndUpdate.mockReturnValue(
        query(reservation({ status: 'released', releasedAt: new Date() })),
      );
      // The replacement line asks for 3 against a balance that can cover 1.
      balanceModel.findOne.mockReturnValue(query(balance({ onHand: 5, reserved: 4 })));
      balanceModel.findOneAndUpdate.mockReturnValue(query(balance({ reserved: 2 })));
      orderModel.updateOne.mockReturnValue(query(undefined));

      await expect(service.reconcileEditedLines(
        ctx({ items: [{ lineId: 'line-1', variantId: OTHER_VARIANT_ID.toString(), productId: 'p-1', quantity: 3 }] }),
        ACTOR_ID,
        SESSION,
      )).rejects.toMatchObject({ errorCode: AppErrorCode.INSUFFICIENT_STOCK });

      // The stamp is the commit marker; it never lands, and the caller's transaction takes
      // the release below it down with it.
      expect(orderModel.updateOne).not.toHaveBeenCalled();
    });

    it('refuses a line that names a variant from another store', async () => {
      variantModel.findOne.mockReturnValue(
        query({ _id: OTHER_VARIANT_ID, storeId: OTHER_STORE_ID, isActive: true, sku: 'SKU-X' }),
      );

      await expect(service.reconcileEditedLines(swappedCtx, ACTOR_ID, SESSION)).rejects.toMatchObject({
        errorCode: AppErrorCode.VARIANT_NOT_FOUND,
      });

      expect(reservationModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(reservationModel).not.toHaveBeenCalled();
    });
  });

  describe('release()', () => {
    it('releases an active reservation: flips the row, decrements reserved only, stamps', async () => {
      reservationModel.find.mockReturnValue(query([reservation()]));
      reservationModel.findOneAndUpdate.mockReturnValue(
        query(reservation({ status: 'released', releasedAt: new Date() })),
      );
      balanceModel.findOneAndUpdate.mockReturnValue(query(balance({ reserved: 0 })));
      orderModel.updateOne.mockReturnValue(query(undefined));

      await service.release(ctx(), ACTOR_ID, SESSION);

      expect(reservationModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: RESERVATION_ID, status: 'active' },
        { $set: { status: 'released', releasedAt: expect.any(Date) } },
        { new: true, session: SESSION },
      );

      // onHand is untouched: the units were never removed, only promised.
      expect(balanceModel.findOneAndUpdate).toHaveBeenCalledWith(
        { variantId: VARIANT_ID, storeId: STORE_ID, reserved: { $gte: 3 } },
        { $inc: { reserved: -3 } },
        { new: true, session: SESSION },
      );

      expect(movementsService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reservation_release',
          quantityDelta: 0,
          idempotencyKey: `release:${RESERVATION_ID.toString()}`,
        }),
      );
    });

    it('is a no-op rather than an error when nothing is reserved', async () => {
      reservationModel.find.mockReturnValue(query([]));

      await service.release(ctx(), ACTOR_ID, SESSION);

      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(movementsService.append).not.toHaveBeenCalled();
      expect(orderModel.updateOne).not.toHaveBeenCalled();
    });

    it('writes no balance change when it loses the release race', async () => {
      reservationModel.find.mockReturnValue(query([reservation()]));
      reservationModel.findOneAndUpdate.mockReturnValue(query(null));
      orderModel.updateOne.mockReturnValue(query(undefined));

      await service.release(ctx(), ACTOR_ID, SESSION);

      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(movementsService.append).not.toHaveBeenCalled();
    });
  });

  describe('consume()', () => {
    it('deducts reserved AND onHand exactly once and stamps fulfilledAt', async () => {
      reservationModel.find.mockReturnValue(query([reservation()]));
      reservationModel.findOneAndUpdate.mockReturnValue(
        query(reservation({ status: 'consumed', consumedAt: new Date() })),
      );
      balanceModel.findOneAndUpdate.mockReturnValue(query(balance({ onHand: 7, reserved: 0 })));
      orderModel.updateOne.mockReturnValue(query(undefined));

      await service.consume(ctx(), ACTOR_ID, SESSION);

      expect(balanceModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          variantId: VARIANT_ID,
          storeId: STORE_ID,
          onHand: { $gte: 3 },
          reserved: { $gte: 3 },
        },
        { $inc: { reserved: -3, onHand: -3 } },
        { new: true, session: SESSION },
      );

      expect(movementsService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fulfillment_deduction',
          quantityDelta: -3,
          idempotencyKey: `consume:${RESERVATION_ID.toString()}`,
        }),
      );

      expect(orderModel.updateOne).toHaveBeenCalledWith(
        { _id: ORDER_ID },
        { $set: { 'inventoryState.fulfilledAt': expect.any(Date) } },
        { session: SESSION },
      );
    });

    it('deducts nothing when there is no active reservation (legacy confirm)', async () => {
      reservationModel.find.mockReturnValue(query([]));

      await service.consume(ctx(), ACTOR_ID, SESSION);

      expect(reservationModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(movementsService.append).not.toHaveBeenCalled();
      expect(orderModel.updateOne).not.toHaveBeenCalled();
    });

    it('is exactly-once: a retried dispatch finds the row already consumed and skips', async () => {
      reservationModel.find.mockReturnValue(query([reservation()]));
      // The `active` predicate no longer matches a row that is already `consumed`.
      reservationModel.findOneAndUpdate.mockReturnValue(query(null));
      orderModel.updateOne.mockReturnValue(query(undefined));

      await service.consume(ctx(), ACTOR_ID, SESSION);

      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(movementsService.append).not.toHaveBeenCalled();
    });
  });

  describe('recordPostDispatchCancellation()', () => {
    it('writes a zero-delta correction per consumed line and never touches the balance', async () => {
      reservationModel.find.mockReturnValue(
        query([reservation({ status: 'consumed', consumedAt: new Date() })]),
      );
      balanceModel.findOne.mockReturnValue(query(balance({ onHand: 7, reserved: 0 })));

      await service.recordPostDispatchCancellation(ctx(), ACTOR_ID, SESSION);

      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(movementsService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'correction',
          quantityDelta: 0,
          reason: 'post_dispatch_cancellation',
          idempotencyKey: `correction:cancel:${RESERVATION_ID.toString()}`,
        }),
      );
    });

    it('writes nothing when no line was consumed', async () => {
      reservationModel.find.mockReturnValue(query([]));

      await service.recordPostDispatchCancellation(ctx(), ACTOR_ID, SESSION);

      expect(balanceModel.findOne).not.toHaveBeenCalled();
      expect(movementsService.append).not.toHaveBeenCalled();
    });
  });

  describe('receiveReturn()', () => {
    const line = (over: Partial<ReturnLineInput> = {}): ReturnLineInput => ({
      orderItemIndex: 0,
      disposition: 'restock',
      ...over,
    });

    it('rejects an empty receipt (INVALID_QUANTITY)', async () => {
      await expect(service.receiveReturn(ctx(), [], null, SESSION)).rejects.toMatchObject({
        errorCode: AppErrorCode.INVALID_QUANTITY,
      });
    });

    it('rejects the same line twice in one receipt (INVALID_QUANTITY)', async () => {
      await expect(
        service.receiveReturn(ctx(), [line(), line()], null, SESSION),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.INVALID_QUANTITY });
    });

    it('rejects a line with no reservation (RESERVATION_NOT_FOUND)', async () => {
      reservationModel.findOne.mockReturnValue(query(null));

      await expect(service.receiveReturn(ctx(), [line()], null, SESSION)).rejects.toMatchObject({
        errorCode: AppErrorCode.RESERVATION_NOT_FOUND,
      });
    });

    it('rejects a line that was never dispatched (ORDER_ALREADY_FULFILLED)', async () => {
      reservationModel.findOne.mockReturnValue(query(reservation({ status: 'active' })));

      await expect(service.receiveReturn(ctx(), [line()], null, SESSION)).rejects.toMatchObject({
        errorCode: AppErrorCode.ORDER_ALREADY_FULFILLED,
      });
    });

    it('rejects a quantity above what was reserved (INVALID_QUANTITY)', async () => {
      reservationModel.findOne.mockReturnValue(query(reservation({ status: 'consumed', quantity: 3 })));

      await expect(
        service.receiveReturn(ctx(), [line({ quantity: 99 })], null, SESSION),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.INVALID_QUANTITY });
    });

    it('restocks: onHand goes up, ledger records return_restock, receipt is stamped', async () => {
      reservationModel.findOne.mockReturnValue(query(reservation({ status: 'consumed' })));
      movementsService.hasMovement.mockResolvedValue(false);
      balanceModel.findOneAndUpdate.mockReturnValue(query(balance({ onHand: 13, reserved: 0 })));
      orderModel.updateOne.mockReturnValue(query(undefined));

      const results = await service.receiveReturn(ctx(), [line({ quantity: 3 })], ACTOR_ID, SESSION);

      expect(balanceModel.findOneAndUpdate).toHaveBeenCalledWith(
        { variantId: VARIANT_ID, storeId: STORE_ID },
        { $inc: { onHand: 3 } },
        { new: true, session: SESSION },
      );
      expect(movementsService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'return_restock',
          quantityDelta: 3,
          idempotencyKey: `return:${RESERVATION_ID.toString()}`,
        }),
      );
      expect(results).toEqual([
        { orderItemIndex: 0, variantId: VARIANT_ID.toString(), disposition: 'restock', quantity: 3, applied: true },
      ]);
      expect(orderModel.updateOne).toHaveBeenCalledWith(
        { _id: ORDER_ID },
        { $set: { 'inventoryState.receivedAt': expect.any(Date) } },
        { session: SESSION },
      );
    });

    it('writes off: zero-delta damage row, onHand untouched', async () => {
      reservationModel.findOne.mockReturnValue(query(reservation({ status: 'consumed' })));
      movementsService.hasMovement.mockResolvedValue(false);
      balanceModel.findOne.mockReturnValue(query(balance({ onHand: 7, reserved: 0 })));
      orderModel.updateOne.mockReturnValue(query(undefined));

      const results = await service.receiveReturn(
        ctx(),
        [line({ disposition: 'write_off', note: 'torn packaging' })],
        ACTOR_ID,
        SESSION,
      );

      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(movementsService.append).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'damage_write_off',
          quantityDelta: 0,
          reason: 'return_received_damaged',
          idempotencyKey: `return:${RESERVATION_ID.toString()}`,
        }),
      );
      expect(results[0]).toMatchObject({ disposition: 'write_off', applied: true });
    });

    it('is idempotent: a retried receipt reports applied:false and writes nothing', async () => {
      reservationModel.findOne.mockReturnValue(query(reservation({ status: 'consumed' })));
      movementsService.hasMovement.mockResolvedValue(true);

      const results = await service.receiveReturn(ctx(), [line()], ACTOR_ID, SESSION);

      expect(balanceModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(movementsService.append).not.toHaveBeenCalled();
      expect(results[0]).toMatchObject({ applied: false, reason: 'already_recorded' });
      expect(orderModel.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('assertNoActiveReservation()', () => {
    it('blocks deleting a variant that an order still holds stock against', async () => {
      reservationModel.find.mockReturnValue(query([{ orderId: ORDER_ID }]));

      await expect(
        service.assertNoActiveReservation(VARIANT_ID.toString(), STORE_ID.toString()),
      ).rejects.toMatchObject({ errorCode: AppErrorCode.VARIANT_HAS_RESERVED_STOCK });

      expect(reservationModel.find).toHaveBeenCalledWith({
        variantId: VARIANT_ID,
        status: 'active',
        storeId: STORE_ID,
      });
    });

    it('allows the delete when nothing is reserved', async () => {
      reservationModel.find.mockReturnValue(query([]));

      await expect(
        service.assertNoActiveReservation(VARIANT_ID.toString(), STORE_ID.toString()),
      ).resolves.toBeUndefined();
    });
  });

  describe('checkAdvisoryAvailability()', () => {
    it('reports a shortfall without ever blocking the order', async () => {
      balanceModel.find.mockReturnValue(query([balance({ onHand: 5, reserved: 4 })]));
      variantModel.find.mockReturnValue(query([{ _id: VARIANT_ID, sku: 'SKU-1' }]));

      const report = await service.checkAdvisoryAvailability(ctx());

      expect(report).toEqual([
        {
          orderItemIndex: 0,
          variantId: VARIANT_ID.toString(),
          sku: 'SKU-1',
          requested: 3,
          available: 1,
          isShort: true,
        },
      ]);
    });

    it('returns nothing for an order with no variant ids', async () => {
      await expect(
        service.checkAdvisoryAvailability(ctx({ items: [{ variantId: null, quantity: 1 }] })),
      ).resolves.toEqual([]);

      expect(balanceModel.find).not.toHaveBeenCalled();
    });
  });

  describe('describeOrder()', () => {
    it('joins reservations, ledger types and the order stamp into one diagnostic', async () => {
      reservationModel.find.mockReturnValue(query([reservation({ status: 'consumed' })]));
      movementsService.listForOrder.mockResolvedValue([
        { orderItemIndex: 0, type: 'order_reservation' },
        { orderItemIndex: 0, type: 'fulfillment_deduction' },
        { orderItemIndex: null, type: 'correction' },
      ]);
      variantModel.find.mockReturnValue(query([{ _id: VARIANT_ID, sku: 'SKU-1' }]));
      orderModel.findById.mockReturnValue(
        query({ inventoryState: { reservedAt: new Date('2026-10-01T00:00:00Z') } }),
      );

      const diagnostic = await service.describeOrder(ctx());

      expect(diagnostic.inventoryState.reservedAt).toBe('2026-10-01T00:00:00.000Z');
      expect(diagnostic.inventoryState.releasedAt).toBeNull();
      expect(diagnostic.lines).toEqual([
        {
          orderItemIndex: 0,
          lineId: 'line-1',
          variantId: VARIANT_ID.toString(),
          sku: 'SKU-1',
          quantity: 3,
          status: 'consumed',
          reservedQuantity: 3,
          movementTypes: ['order_reservation', 'fulfillment_deduction'],
        },
      ]);
    });
  });
});
