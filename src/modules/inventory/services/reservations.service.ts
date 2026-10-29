import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { AppException } from '../../../common/errors/app-exception';
import { AppErrorCode } from '../../../common/errors/error-codes.enum';
import { OrderStatus } from '../../../common/constants/order-statuses.const';
import { Order, OrderDocument } from '../../orders/schemas/order.schema';
import { Product } from '../../products/schemas/product.schema';
import {
  InventoryBalance,
  InventoryBalanceDocument,
} from '../schemas/inventory-balance.schema';
import {
  InventoryReservation,
  InventoryReservationDocument,
  ReservationStatus,
} from '../schemas/inventory-reservation.schema';
import { ProductVariant, ProductVariantDocument } from '../schemas/product-variant.schema';
import { MovementsService } from './movements.service';
import { withOptionalSession } from './session.util';

/**
 * The subset of an order this service needs.
 *
 * Deliberately a plain interface rather than the `Order` document: `OrdersService` owns the
 * order model and passes this in, so the inventory module never reaches back into the orders
 * service (which would be a circular dependency between two modules that both import each
 * other's schemas).
 */
export interface OrderInventoryContext {
  orderId: Types.ObjectId;
  orderNo: string;
  /** `null` only on an un-migrated pre-store-id order, which can never reserve. */
  storeId: Types.ObjectId | null;
  items: Array<{
    lineId?: string | null;
    variantId?: string | null;
    productId?: string | null;
    quantity: number;
  }>;
}

export interface ReturnLineInput {
  orderItemIndex: number;
  /** Defaults to the full reserved quantity; a partial receipt is allowed. */
  quantity?: number;
  disposition: 'restock' | 'write_off';
  /** Free text from the operator recording the receipt; persisted on the ledger movement. */
  note?: string;
}

export interface ReturnResult {
  orderItemIndex: number;
  variantId: string;
  disposition: 'restock' | 'write_off';
  quantity: number;
  applied: boolean;
  reason?: string;
}

export interface OrderInventoryDiagnostic {
  orderNo: string;
  storeId: string | null;
  inventoryState: {
    reservedAt: string | null;
    releasedAt: string | null;
    fulfilledAt: string | null;
    receivedAt: string | null;
  };
  lines: Array<{
    orderItemIndex: number;
    lineId: string | null;
    variantId: string | null;
    sku: string | null;
    quantity: number;
    status: ReservationStatus | null;
    reservedQuantity: number;
    movementTypes: string[];
  }>;
}

export interface AdvisoryLine {
  orderItemIndex: number;
  variantId: string;
  sku: string | null;
  requested: number;
  available: number;
  isShort: boolean;
}

/**
 * Reservations, exactly-once fulfilment, and the order-status side effects that drive them
 * (spec §7).
 *
 * Three rules shape everything here:
 *
 *  1. **Every line carries a `variantId`.** Every product is a variant product and order
 *     lines are required to name the variant they bought (see `CreateOrderDto`), so the
 *     balance is always reachable. The `variantId`-less skip below is defensive only - it
 *     exists for malformed/legacy documents and never triggers on a validated order.
 *  2. **The reservation row is the exactly-once gate.** `status` is only ever advanced by a
 *     conditional write carrying the status it is moving *from* (`active` -> `released` /
 *     `consumed`). The loser of a concurrent race gets `null` and skips its balance work, so
 *     a movement can never be written twice for one line.
 *  3. **Every balance change writes its ledger row in the same transaction.** `OrdersService`
 *     passes its own session so a status claim and the inventory work it triggers commit
 *     together (spec §7.2 rule 4); internal callers get a self-contained transaction.
 */
@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    @InjectModel(InventoryReservation.name)
    private readonly reservationModel: Model<InventoryReservationDocument>,
    @InjectModel(InventoryBalance.name)
    private readonly balanceModel: Model<InventoryBalanceDocument>,
    @InjectModel(ProductVariant.name)
    private readonly variantModel: Model<ProductVariantDocument>,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    private readonly movementsService: MovementsService,
  ) {}

  /**
   * Single entry point for every status transition that affects stock (roadmap 4.8).
   *
   * Kept separate from `OrdersService` so the three call sites - `update`, `bulkAction`,
   * `bulkShip` - cannot drift apart in how they map a status onto an inventory effect. That
   * divergence is precisely the defect the roadmap is trying to avoid.
   */
  async onStatusChange(
    ctx: OrderInventoryContext,
    fromSlug: string,
    toSlug: string,
    actorUserId?: Types.ObjectId | null,
    session?: ClientSession | null,
  ): Promise<void> {
    if (toSlug === OrderStatus.CONFIRMED) {
      // Spec §7.1 rule 2: confirmation is the reservation point.
      await this.reserve(ctx, actorUserId, session);
      return;
    }

    if (toSlug === OrderStatus.CANCELLED) {
      // A cancel that lands before dispatch has stock still reserved, so it releases it. One
      // that lands after dispatch already deducted the units, and putting them back would
      // inflate stock for goods that left the warehouse (G-1).
      const preDispatch = fromSlug === OrderStatus.PLACED || fromSlug === OrderStatus.CONFIRMED;
      if (preDispatch) {
        await this.release(ctx, actorUserId, session);
      } else {
        await this.recordPostDispatchCancellation(ctx, actorUserId, session);
      }
      return;
    }

    if (toSlug === OrderStatus.DISPATCHED) {
      // Spec §7.1 rule 4: the recommended deduction point.
      await this.consume(ctx, actorUserId, session);
      return;
    }

    // `in-transit`, `delivered` and `returned` carry no stock effect: the units were already
    // deducted when the order was dispatched (spec §7.1 rules 4 and 5).
  }

  /**
   * Reserves every variant line of an order, all of it or none of it.
   *
   * Availability is re-read from the database on the server (spec §7.2 rules 3, 8 and 9) and
   * every increment is a compare-and-set on the values just read. Pinning both `onHand` and
   * `reserved` in the predicate is what makes concurrent reservations for the last unit
   * safe: the second writer matches nothing, retries inside `withTransaction` against a
   * fresh snapshot, and then fails the availability check.
   */
  async reserve(
    ctx: OrderInventoryContext,
    actorUserId?: Types.ObjectId | null,
    session?: ClientSession | null,
  ): Promise<void> {
    const lines = await this.reservableLines(ctx);

    // A simple-product order, or one whose product has no stock left to reserve against.
    if (lines.length === 0) return;

    await withOptionalSession(this.balanceModel, this.logger, session, async (tx) => {
      for (const line of lines) {
        const existing = await this.reservationModel
          .findOne({ orderId: ctx.orderId, orderItemIndex: line.orderItemIndex })
          .session(tx)
          .exec();

        // Spec §7.2 rules 6 and 7: a line already holding a reservation is left alone, so a
        // repeated confirmation cannot reserve twice. Deliberately not an error - the spec
        // asks for idempotent confirmation, not a 409 the caller would have to handle.
        if (existing) continue;

        await this.claimReserved(ctx, line, actorUserId, tx);
      }

      await this.orderModel
        .updateOne({ _id: ctx.orderId }, { $set: { 'inventoryState.reservedAt': new Date() } }, { session: tx })
        .exec();
    });
  }

  /**
   * Releases every still-active reservation for an order. `onHand` is never touched: the
   * units were never removed from it, only promised (spec §7.1 rule 6).
   *
   * An order with no active reservation is a no-op rather than an error, which is what makes
   * cancelling an order that was never confirmed safe (spec §7.2 rule 10).
   */
  async release(
    ctx: OrderInventoryContext,
    actorUserId?: Types.ObjectId | null,
    session?: ClientSession | null,
  ): Promise<void> {
    await withOptionalSession(this.balanceModel, this.logger, session, async (tx) => {
      const active = await this.reservationModel
        .find({ orderId: ctx.orderId, status: 'active' })
        .session(tx)
        .exec();

      if (active.length === 0) {
        this.logger.debug(`release: order ${ctx.orderNo} has no active reservation; nothing to do`);
        return;
      }

      const now = new Date();

      for (const reservation of active) {
        const claimed = await this.reservationModel
          .findOneAndUpdate(
            { _id: reservation._id, status: 'active' },
            { $set: { status: 'released', releasedAt: now } },
            { new: true, session: tx },
          )
          .exec();

        // Lost the race to a concurrent release. That caller is decrementing the same
        // quantity, so doing it again would double-release.
        if (!claimed) continue;

        await this.applyBalanceChange(
          {
            variantId: claimed.variantId,
            storeId: claimed.storeId,
            reservedDelta: -claimed.quantity,
            onHandDelta: 0,
            type: 'reservation_release',
            idempotencyKey: `release:${String(claimed._id)}`,
            ctx,
            orderItemIndex: claimed.orderItemIndex,
            reservationId: claimed._id as Types.ObjectId,
            actorUserId,
          },
          tx,
        );
      }

      await this.orderModel
        .updateOne({ _id: ctx.orderId }, { $set: { 'inventoryState.releasedAt': now } }, { session: tx })
        .exec();
    });
  }

  /**
   * Brings an order's active reservations back in line with its lines, for a seller who edits
   * them while the order is still `confirmed` (and therefore still holding stock).
   *
   * `inventory_reservations` is uniquely keyed on `{orderId, orderItemIndex}` and a released row
   * is kept rather than removed, so a line that changes its variant or its quantity cannot simply
   * be reserved again - the old row still owns the key. Each changed line is therefore released,
   * its row deleted to free the key, and the new line reserved through the same compare-and-set
   * path a first confirmation uses. Lines whose variant and quantity are untouched are left
   * alone, so a save that only reprices a line moves no stock at all.
   *
   * Runs inside the caller's transaction. A line the new items cannot cover throws from
   * `claimReserved` and takes the whole edit - including the order write - down with it, which is
   * what keeps a confirmed order from ending up with half its stock promised against lines it no
   * longer holds.
   */
  async reconcileEditedLines(
    ctx: OrderInventoryContext,
    actorUserId?: Types.ObjectId | null,
    session?: ClientSession | null,
  ): Promise<void> {
    // Validates every line exactly as a confirmation would: active variant, same store,
    // whole quantity of at least 1.
    const lines = await this.reservableLines(ctx);

    await withOptionalSession(this.balanceModel, this.logger, session, async (tx) => {
      const active = await this.reservationModel
        .find({ orderId: ctx.orderId, status: 'active' })
        .session(tx)
        .exec();

      const wantedByIndex = new Map(lines.map((line) => [line.orderItemIndex, line]));
      const releasedIds = new Set<string>();
      const now = new Date();
      let touched = false;

      // 1) Drop every active line that the new items no longer describe (removed, re-pointed at
      //    another variant, or a different quantity).
      for (const reservation of active) {
        const wanted = wantedByIndex.get(reservation.orderItemIndex);
        const unchanged =
          wanted &&
          String(wanted.variantId) === String(reservation.variantId) &&
          wanted.quantity === reservation.quantity;
        if (unchanged) continue;

        const released = await this.reservationModel
          .findOneAndUpdate(
            { _id: reservation._id, status: 'active' },
            { $set: { status: 'released', releasedAt: now } },
            { new: true, session: tx },
          )
          .exec();

        // A concurrent cancel already released this one and decremented the balance.
        if (!released) continue;

        await this.applyBalanceChange(
          {
            variantId: released.variantId,
            storeId: released.storeId,
            reservedDelta: -released.quantity,
            onHandDelta: 0,
            type: 'reservation_release',
            idempotencyKey: `release:${String(released._id)}`,
            ctx,
            orderItemIndex: released.orderItemIndex,
            reservationId: released._id as Types.ObjectId,
            actorUserId,
          },
          tx,
        );

        // Free the `{orderId, orderItemIndex}` key so the line can be reserved again below.
        await this.reservationModel.deleteOne({ _id: released._id }).session(tx).exec();
        releasedIds.add(String(released._id));
        touched = true;
      }

      const stillActiveByIndex = new Map(
        active
          .filter((reservation: any) => !releasedIds.has(String(reservation._id)))
          .map((reservation: any) => [reservation.orderItemIndex, reservation]),
      );

      // 2) Reserve every line that is new or changed. Any line that cannot be covered throws
      //    here and rolls the transaction back - including the releases just performed.
      for (const line of lines) {
        const current = stillActiveByIndex.get(line.orderItemIndex);
        const unchanged =
          current &&
          String(current.variantId) === String(line.variantId) &&
          current.quantity === line.quantity;
        if (unchanged) continue;

        await this.claimReserved(ctx, line, actorUserId, tx);
        touched = true;
      }

      if (touched) {
        await this.orderModel
          .updateOne(
            { _id: ctx.orderId },
            { $set: { 'inventoryState.reservedAt': now, 'inventoryState.releasedAt': now } },
            { session: tx },
          )
          .exec();
      }
    });
  }

  /**
   * Consumes active reservations at dispatch: `reserved` and `onHand` both fall by the
   * fulfilled quantity, and the reservation becomes `consumed`.
   *
   * Exactly once, by construction. The `active` -> `consumed` conditional write is the gate:
   * only the caller that flips it performs the balance change, so a retried dispatch finds
   * the reservation already consumed, matches nothing, and writes nothing (spec §7.2 rule 11,
   * acceptance §15.11).
   *
   * An order with no active reservation - confirmed before this feature existed - is left
   * alone and logged. Its units were never promised against a balance, so deducting now
   * would invent a deduction nobody can reconcile against the ledger.
   */
  async consume(
    ctx: OrderInventoryContext,
    actorUserId?: Types.ObjectId | null,
    session?: ClientSession | null,
  ): Promise<void> {
    await withOptionalSession(this.balanceModel, this.logger, session, async (tx) => {
      const active = await this.reservationModel
        .find({ orderId: ctx.orderId, status: 'active' })
        .session(tx)
        .exec();

      if (active.length === 0) {
        this.logger.warn(
          `consume: order ${ctx.orderNo} has no active reservation; no stock deducted. ` +
            'Orders confirmed before reservations existed keep their historical behaviour.',
        );
        return;
      }

      const now = new Date();

      for (const reservation of active) {
        const claimed = await this.reservationModel
          .findOneAndUpdate(
            { _id: reservation._id, status: 'active' },
            { $set: { status: 'consumed', consumedAt: now } },
            { new: true, session: tx },
          )
          .exec();

        if (!claimed) continue;

        await this.applyBalanceChange(
          {
            variantId: claimed.variantId,
            storeId: claimed.storeId,
            reservedDelta: -claimed.quantity,
            onHandDelta: -claimed.quantity,
            type: 'fulfillment_deduction',
            idempotencyKey: `consume:${String(claimed._id)}`,
            ctx,
            orderItemIndex: claimed.orderItemIndex,
            reservationId: claimed._id as Types.ObjectId,
            actorUserId,
          },
          tx,
        );
      }

      await this.orderModel
        .updateOne({ _id: ctx.orderId }, { $set: { 'inventoryState.fulfilledAt': now } }, { session: tx })
        .exec();
    });
  }

  /**
   * Records a cancellation that arrives after dispatch (roadmap 4.4, G-1).
   *
   * No stock changes. The goods already left the warehouse and `consume` already reduced
   * `onHand`; returning them to the seller's sellable stock because a parcel was refused
   * would inflate stock with items nobody has counted back in. What the ledger needs is an
   * explanation, so a zero-delta `correction` row is appended against each consumed
   * reservation so a later reconciliation can see why on-hand is lower than the order count
   * suggests.
   *
   * Written without a transaction of its own benefit: it touches no balance, so it only
   * needs the same session to keep the audit trail next to the status change.
   */
  async recordPostDispatchCancellation(
    ctx: OrderInventoryContext,
    actorUserId?: Types.ObjectId | null,
    session?: ClientSession | null,
  ): Promise<void> {
    await withOptionalSession(this.balanceModel, this.logger, session, async (tx) => {
      const consumed = await this.reservationModel
        .find({ orderId: ctx.orderId, status: 'consumed' })
        .session(tx)
        .exec();

      if (consumed.length === 0) return;

      for (const reservation of consumed) {
        const balance = await this.balanceModel
          .findOne({ variantId: reservation.variantId })
          .session(tx)
          .exec();

        if (!balance) continue;

        await this.movementsService.append({
          storeId: reservation.storeId,
          variantId: reservation.variantId,
          type: 'correction',
          quantityDelta: 0,
          onHandBefore: balance.onHand,
          onHandAfter: balance.onHand,
          reservedBefore: balance.reserved,
          reservedAfter: balance.reserved,
          reason: 'post_dispatch_cancellation',
          note: `Order ${ctx.orderNo} cancelled after dispatch; stock already deducted and not returned`,
          orderId: ctx.orderId,
          orderItemIndex: reservation.orderItemIndex,
          reservationId: reservation._id as Types.ObjectId,
          actorUserId: actorUserId ?? null,
          idempotencyKey: `correction:cancel:${String(reservation._id)}`,
          session: tx,
        });
      }
    });
  }

  /**
   * Records physical receipt of returned goods (roadmap 4.5, spec §7.1 rule 7).
   *
   * Returned goods are not automatically sellable. The seller inspects them and then chooses
   * per line: `restock` puts the units back into `onHand`, `write_off` records them as
   * damaged and leaves `onHand` alone, because damaged goods must not become sellable stock
   * (which is exactly why the disposition is a choice rather than a default).
   *
   * Idempotency is per line: a retried receipt finds the movement the previous attempt
   * wrote, under the same idempotency key, and skips. That also means one disposition per
   * reservation - restocking a line and later writing it off is not supported, because the
   * first receipt already consumed the line's one allowed disposition.
   */
  async receiveReturn(
    ctx: OrderInventoryContext,
    items: ReturnLineInput[],
    actorUserId?: Types.ObjectId | null,
    session?: ClientSession | null,
  ): Promise<ReturnResult[]> {
    if (items.length === 0) {
      throw new AppException(AppErrorCode.INVALID_QUANTITY, { reason: 'no_return_lines' });
    }

    const seen = new Set<number>();
    for (const item of items) {
      if (seen.has(item.orderItemIndex)) {
        throw new AppException(AppErrorCode.INVALID_QUANTITY, {
          orderItemIndex: item.orderItemIndex,
          reason: 'duplicate_order_item_index',
        });
      }
      seen.add(item.orderItemIndex);
    }

    return withOptionalSession(this.balanceModel, this.logger, session, async (tx) => {
      const results: ReturnResult[] = [];
      let recordedAt: Date | null = null;

      for (const item of items) {
        const reservation = await this.reservationModel
          .findOne({ orderId: ctx.orderId, orderItemIndex: item.orderItemIndex })
          .session(tx)
          .exec();

        if (!reservation) {
          throw new AppException(AppErrorCode.RESERVATION_NOT_FOUND, {
            orderNo: ctx.orderNo,
            orderItemIndex: item.orderItemIndex,
          });
        }

        if (reservation.status !== 'consumed') {
          throw new AppException(AppErrorCode.ORDER_ALREADY_FULFILLED, {
            orderNo: ctx.orderNo,
            orderItemIndex: item.orderItemIndex,
            status: reservation.status,
            reason: 'only_dispatched_lines_can_be_received',
          });
        }

        const quantity = item.quantity ?? reservation.quantity;
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > reservation.quantity) {
          throw new AppException(AppErrorCode.INVALID_QUANTITY, {
            orderItemIndex: item.orderItemIndex,
            quantity,
            reservedQuantity: reservation.quantity,
          });
        }

        // Disposition-independent on purpose. The key identifies the *receipt*, not the decision it
        // recorded, so a line can only be received once. Including the disposition would let a
        // retried `restock` be replayed as a `write_off` (or vice versa) against the same
        // reservation - a write-off after restocking would quietly zero the stock that had
        // already been made sellable again. The chosen disposition is recorded on the movement.
        const idempotencyKey = `return:${String(reservation._id)}`;

        const alreadyRecorded = await this.movementsService.hasMovement(idempotencyKey, tx);
        if (alreadyRecorded) {
          results.push({
            orderItemIndex: item.orderItemIndex,
            variantId: String(reservation.variantId),
            disposition: item.disposition,
            quantity,
            applied: false,
            reason: 'already_recorded',
          });
          continue;
        }

        if (item.disposition === 'restock') {
          await this.applyBalanceChange(
            {
              variantId: reservation.variantId,
              storeId: reservation.storeId,
              reservedDelta: 0,
              onHandDelta: quantity,
              type: 'return_restock',
              idempotencyKey,
              ctx,
              orderItemIndex: reservation.orderItemIndex,
              reservationId: reservation._id as Types.ObjectId,
              actorUserId,
              note: item.note,
            },
            tx,
          );
        } else {
          const balance = await this.balanceModel
            .findOne({ variantId: reservation.variantId })
            .session(tx)
            .exec();
          if (!balance) continue;

          // Zero delta on purpose: the units were removed from `onHand` at dispatch and are
          // not returning to sellable stock. The row exists so the ledger records that the
          // goods were seen and judged damaged rather than lost.
          await this.movementsService.append({
            storeId: reservation.storeId,
            variantId: reservation.variantId,
            type: 'damage_write_off',
            quantityDelta: 0,
            onHandBefore: balance.onHand,
            onHandAfter: balance.onHand,
            reservedBefore: balance.reserved,
            reservedAfter: balance.reserved,
            reason: 'return_received_damaged',
            note:
              `Order ${ctx.orderNo} returned ${quantity} unit(s) written off as damaged` +
              (item.note ? ` - ${item.note}` : ''),
            orderId: ctx.orderId,
            orderItemIndex: reservation.orderItemIndex,
            reservationId: reservation._id as Types.ObjectId,
            actorUserId: actorUserId ?? null,
            idempotencyKey,
            session: tx,
          });
        }

        if (!recordedAt) recordedAt = new Date();
        results.push({
          orderItemIndex: item.orderItemIndex,
          variantId: String(reservation.variantId),
          disposition: item.disposition,
          quantity,
          applied: true,
        });
      }

      if (recordedAt) {
        await this.orderModel
          .updateOne({ _id: ctx.orderId }, { $set: { 'inventoryState.receivedAt': recordedAt } }, { session: tx })
          .exec();
      }

      return results;
    });
  }

  /**
   * Read-only availability report for an order's variant lines (roadmap 4.7).
   *
   * Advisory by design. A storefront may legitimately sell a combination that has just gone
   * out of stock, and the platform sells COD in a market where stock counts drift, so this
   * never blocks checkout. It exists so the vendor is told at order time instead of
   * discovering the shortfall when confirmation fails.
   */
  async checkAdvisoryAvailability(ctx: OrderInventoryContext): Promise<AdvisoryLine[]> {
    const variantIds = ctx.items
      .map((item) => this.toObjectId(item.variantId))
      .filter((id): id is Types.ObjectId => id !== null);

    if (variantIds.length === 0) return [];

    const [balances, variants] = await Promise.all([
      this.balanceModel.find({ variantId: { $in: variantIds } }).exec(),
      this.variantModel.find({ _id: { $in: variantIds } }).select('sku').lean().exec(),
    ]);

    const availableByVariant = new Map<string, number>(
      balances.map((b) => [String(b.variantId), b.onHand - b.reserved]),
    );
    const skuByVariant = new Map<string, string | null>(
      variants.map((v: any) => [String(v._id), v.sku ?? null]),
    );

    const report: AdvisoryLine[] = [];

    ctx.items.forEach((item, orderItemIndex) => {
      const variantId = this.toObjectId(item.variantId);
      if (!variantId) return;
      const available = availableByVariant.get(String(variantId)) ?? 0;
      report.push({
        orderItemIndex,
        variantId: String(variantId),
        sku: skuByVariant.get(String(variantId)) ?? null,
        requested: item.quantity,
        available,
        isShort: available < item.quantity,
      });
    });

    const short = report.filter((line) => line.isShort);
    if (short.length > 0) {
      this.logger.warn(
        `Order ${ctx.orderNo} placed with insufficient stock on ${short.length} line(s): ` +
          short.map((l) => `#${l.orderItemIndex} needs ${l.requested}, available ${l.available}`).join('; '),
      );
    }

    return report;
  }

  /**
   * Hard gate: refuses any line whose variant has nothing left to ship (`onHand - reserved <= 0`).
   *
   * The inverse of `checkAdvisoryAvailability`, which deliberately never blocks. Both readings
   * are right for their own caller: a storefront may legitimately sell a combination that sold
   * out moments ago (COD, drifting counts), but a vendor entering an order by hand — or editing
   * the lines of a `placed` one — can see that a variant is empty, so accepting the line would
   * file an order that cannot be fulfilled without a correction first.
   *
   * Only *zero* stock is refused. A line that wants more than is available stays the vendor's
   * call (restock, split, or accept the shortfall) and is reported by the advisory check as
   * before, so this never tightens the storefront contract or the confirmation-time reserve.
   */
  async assertLinesInStock(
    items: Array<{ variantId?: string | null; quantity?: number }>,
  ): Promise<void> {
    const variantIds = items
      .map((item) => this.toObjectId(item.variantId))
      .filter((id): id is Types.ObjectId => id !== null);
    if (variantIds.length === 0) return;

    const [balances, variants] = await Promise.all([
      this.balanceModel.find({ variantId: { $in: variantIds } }).exec(),
      this.variantModel.find({ _id: { $in: variantIds } }).select('sku').lean().exec(),
    ]);

    const availableByVariant = new Map<string, number>(
      balances.map((b) => [String(b.variantId), b.onHand - b.reserved]),
    );
    const skuByVariant = new Map<string, string | null>(
      variants.map((v: any) => [String(v._id), v.sku ?? null]),
    );

    for (const item of items) {
      const variantId = this.toObjectId(item.variantId);
      if (!variantId) continue;
      const available = availableByVariant.get(String(variantId)) ?? 0;
      if (available <= 0) {
        throw new AppException(AppErrorCode.ORDER_ITEM_OUT_OF_STOCK, {
          variantId: String(variantId),
          sku: skuByVariant.get(String(variantId)) ?? null,
          requested: item.quantity ?? 0,
          available,
        });
      }
    }
  }

  /**
   * Reservation state for one order (roadmap §4.5 `GET /orders/:orderId/inventory`).
   *
   * Diagnostic rather than authoritative: balances are the truth, this explains them.
   */
  async describeOrder(ctx: OrderInventoryContext): Promise<OrderInventoryDiagnostic> {
    const [reservations, movements] = await Promise.all([
      this.reservationModel.find({ orderId: ctx.orderId }).sort({ orderItemIndex: 1 }).lean().exec(),
      this.movementsService.listForOrder(ctx.orderId),
    ]);

    const skuByVariant = await this.skusFor(ctx.items.map((i) => i.variantId));

    const movementsByIndex = new Map<number, string[]>();
    for (const movement of movements) {
      if (movement.orderItemIndex === null) continue;
      const list = movementsByIndex.get(movement.orderItemIndex) ?? [];
      if (!list.includes(movement.type)) list.push(movement.type);
      movementsByIndex.set(movement.orderItemIndex, list);
    }

    const order = await this.orderModel
      .findById(ctx.orderId)
      .select('inventoryState')
      .lean()
      .exec();

    return {
      orderNo: ctx.orderNo,
      storeId: ctx.storeId ? String(ctx.storeId) : null,
      inventoryState: {
        reservedAt: this.toIso(order?.inventoryState?.reservedAt),
        releasedAt: this.toIso(order?.inventoryState?.releasedAt),
        fulfilledAt: this.toIso(order?.inventoryState?.fulfilledAt),
        receivedAt: this.toIso(order?.inventoryState?.receivedAt),
      },
      lines: ctx.items.map((item, orderItemIndex) => {
        const reservation = reservations.find((r) => r.orderItemIndex === orderItemIndex);
        return {
          orderItemIndex,
          lineId: item.lineId ?? null,
          variantId: item.variantId ?? null,
          sku: item.variantId ? (skuByVariant.get(item.variantId) ?? null) : null,
          quantity: item.quantity,
          status: reservation?.status ?? null,
          reservedQuantity: reservation?.quantity ?? 0,
          movementTypes: movementsByIndex.get(orderItemIndex) ?? [],
        };
      }),
    };
  }

  /** SKU lookup for the diagnostics view; a missing variant reports null, never a throw. */
  private async skusFor(variantIds: Array<string | null | undefined>): Promise<Map<string, string | null>> {
    const ids = variantIds
      .map((id) => this.toObjectId(id))
      .filter((id): id is Types.ObjectId => id !== null);
    if (ids.length === 0) return new Map();
    const variants = await this.variantModel.find({ _id: { $in: ids } }).select('sku').lean().exec();
    return new Map<string, string | null>(variants.map((v: any) => [String(v._id), v.sku ?? null]));
  }

  /**
   * Blocks deleting a variant while an order still holds stock against it (spec §7.5).
   *
   * Deactivation is the soft alternative and stays available; a hard delete would orphan the
   * reservation and its balance with no compensating record.
   */
  async assertNoActiveReservation(variantId: string, storeId?: string | null): Promise<void> {
    const active = await this.reservationModel
      .find({
        variantId: this.toObjectId(variantId) ?? new Types.ObjectId(variantId),
        status: 'active',
        ...(storeId ? { storeId: new Types.ObjectId(storeId) } : {}),
      })
      .select('orderId')
      .lean()
      .exec();

    if (active.length > 0) {
      throw new AppException(AppErrorCode.VARIANT_HAS_RESERVED_STOCK, {
        variantId,
        activeOrders: active.length,
      });
    }
  }

  /** Variant ids on this order that carry inventory, validated as reservable up front. */
  private async reservableLines(
    ctx: OrderInventoryContext,
  ): Promise<Array<{ orderItemIndex: number; variantId: Types.ObjectId; quantity: number; storeId: Types.ObjectId; sku: string | null }>> {
    if (!ctx.storeId) return [];

    const lines: Array<{
      orderItemIndex: number;
      variantId: Types.ObjectId;
      quantity: number;
      storeId: Types.ObjectId;
      sku: string | null;
    }> = [];

    for (let orderItemIndex = 0; orderItemIndex < ctx.items.length; orderItemIndex += 1) {
      const item = ctx.items[orderItemIndex];
      const variantId = this.toObjectId(item.variantId);
      if (!variantId) continue; // simple product - no inventory work (roadmap 4.3)

      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        throw new AppException(AppErrorCode.INVALID_QUANTITY, {
          orderNo: ctx.orderNo,
          orderItemIndex,
          quantity: item.quantity,
        });
      }

      // Spec §7.2 rule 1: only active, existing variants, and the tenant check doubles as
      // the non-enumeration guard so an order cannot reserve another store's variant.
      const variant = await this.variantModel
        .findOne({ _id: variantId, isDeleted: { $ne: true } })
        .select('_id storeId isActive sku')
        .lean()
        .exec();

      if (!variant || String(variant.storeId) !== String(ctx.storeId)) {
        throw new AppException(AppErrorCode.VARIANT_NOT_FOUND, {
          orderNo: ctx.orderNo,
          orderItemIndex,
          variantId: item.variantId,
        });
      }

      if (!variant.isActive) {
        throw new AppException(AppErrorCode.VARIANT_INACTIVE, {
          orderNo: ctx.orderNo,
          orderItemIndex,
          variantId: item.variantId,
          sku: variant.sku ?? null,
        });
      }

      lines.push({
        orderItemIndex,
        variantId,
        quantity: item.quantity,
        storeId: ctx.storeId,
        sku: variant.sku ?? null,
      });
    }

    return lines;
  }

  /**
   * One line of a reservation: a compare-and-set increment of `reserved`, the reservation
   * row, and the ledger row, in that order.
   *
   * The balance row is written before the reservation row so a failed reservation never
   * leaves a dangling promise in the balance, and the CAS predicate pins the values just
   * read so a concurrent writer for the same last unit cannot also match.
   */
  private async claimReserved(
    ctx: OrderInventoryContext,
    line: { orderItemIndex: number; variantId: Types.ObjectId; quantity: number; storeId: Types.ObjectId; sku: string | null },
    actorUserId: Types.ObjectId | null | undefined,
    tx: ClientSession,
  ): Promise<void> {
    const balance = await this.balanceModel
      .findOne({ variantId: line.variantId, storeId: line.storeId })
      .session(tx)
      .exec();

    if (!balance) {
      throw new AppException(AppErrorCode.VARIANT_NOT_FOUND, {
        variantId: String(line.variantId),
        sku: line.sku,
        reason: 'no_stock_record',
      });
    }

    const available = balance.onHand - balance.reserved;
    if (available < line.quantity) {
      throw new AppException(AppErrorCode.INSUFFICIENT_STOCK, {
        variantId: String(line.variantId),
        sku: line.sku,
        available,
        requested: line.quantity,
      });
    }

    const updated = await this.balanceModel
      .findOneAndUpdate(
        { _id: balance._id, onHand: balance.onHand, reserved: balance.reserved },
        { $inc: { reserved: line.quantity } },
        { new: true, session: tx },
      )
      .exec();

    if (!updated) {
      // The row moved between the read and the write. Inside a transaction this normally
      // surfaces as a WriteConflict that `withTransaction` retries against a fresh snapshot;
      // reaching here means the predicate genuinely did not match, which is the same class
      // of conflict `InventoryService.adjustByDelta` reports.
      throw new AppException(AppErrorCode.RESERVED_STOCK_CONFLICT, {
        variantId: String(line.variantId),
        message: 'balance changed concurrently',
      });
    }

    let reservation: InventoryReservationDocument;
    try {
      reservation = await new this.reservationModel({
        storeId: line.storeId,
        orderId: ctx.orderId,
        variantId: line.variantId,
        orderItemIndex: line.orderItemIndex,
        quantity: line.quantity,
        status: 'active',
      }).save({ session: tx });
    } catch (err: any) {
      if (err?.code === 11000) {
        // Unique `{ orderId, orderItemIndex }`. The pre-check above already covers a retry,
        // so this is a genuine concurrent race, and the transaction is aborted by the driver.
        throw new AppException(AppErrorCode.ORDER_ALREADY_RESERVED, {
          orderNo: ctx.orderNo,
          orderItemIndex: line.orderItemIndex,
        });
      }
      throw err;
    }

    await this.movementsService.append({
      storeId: line.storeId,
      variantId: line.variantId,
      // Zero delta: a reservation promises stock, it does not move it.
      type: 'order_reservation',
      quantityDelta: 0,
      onHandBefore: balance.onHand,
      onHandAfter: updated.onHand,
      reservedBefore: balance.reserved,
      reservedAfter: updated.reserved,
      reason: 'order_confirmed',
      note: `Order ${ctx.orderNo} line ${line.orderItemIndex} reserved`,
      orderId: ctx.orderId,
      orderItemIndex: line.orderItemIndex,
      reservationId: reservation._id as Types.ObjectId,
      actorUserId: actorUserId ?? null,
      // Keyed on the reservation row, not the line: `{orderId, orderItemIndex}` would collide
      // with the first reservation's ledger row whenever a released line is reserved again
      // (editing a confirmed order's items does exactly that), and the dedupe would silently
      // drop the second movement while the balance still moved.
      idempotencyKey: `reserve:${String(reservation._id)}`,
      session: tx,
    });
  }

  /**
   * Applies a signed change to `reserved` and/or `onHand` and records it in the ledger.
   *
   * The predicate is the whole safety argument: it refuses to take `onHand` or `reserved`
   * below zero, and - for a release - refuses to remove more `reserved` than the row
   * actually holds. A caller that computed its numbers from a stale read fails here instead
   * of writing a balance that claims more is promised than exists.
   */
  private async applyBalanceChange(
    change: {
      variantId: Types.ObjectId;
      storeId: Types.ObjectId;
      reservedDelta: number;
      onHandDelta: number;
      type: 'reservation_release' | 'fulfillment_deduction' | 'return_restock';
      idempotencyKey: string;
      ctx: OrderInventoryContext;
      orderItemIndex: number;
      reservationId: Types.ObjectId;
      actorUserId?: Types.ObjectId | null;
      /** Operator note from the receipt; kept on the ledger so the decision is auditable. */
      note?: string;
    },
    tx: ClientSession,
  ): Promise<void> {
    const filter: Record<string, any> = {
      variantId: change.variantId,
      storeId: change.storeId,
    };

    if (change.onHandDelta < 0) filter.onHand = { $gte: -change.onHandDelta };
    if (change.reservedDelta < 0) filter.reserved = { $gte: -change.reservedDelta };

    const inc: Record<string, number> = {};
    if (change.reservedDelta !== 0) inc.reserved = change.reservedDelta;
    if (change.onHandDelta !== 0) inc.onHand = change.onHandDelta;

    const after = await this.balanceModel.findOneAndUpdate(filter, { $inc: inc }, { new: true, session: tx }).exec();

    if (!after) {
      throw new AppException(
        change.onHandDelta < 0 ? AppErrorCode.INSUFFICIENT_STOCK : AppErrorCode.RESERVED_STOCK_CONFLICT,
        {
          variantId: String(change.variantId),
          onHandDelta: change.onHandDelta,
          reservedDelta: change.reservedDelta,
          orderNo: change.ctx.orderNo,
          orderItemIndex: change.orderItemIndex,
        },
      );
    }

    await this.movementsService.append({
      storeId: change.storeId,
      variantId: change.variantId,
      type: change.type,
      quantityDelta: change.onHandDelta,
      onHandBefore: after.onHand - change.onHandDelta,
      onHandAfter: after.onHand,
      reservedBefore: after.reserved - change.reservedDelta,
      reservedAfter: after.reserved,
      reason: change.type,
      note: `Order ${change.ctx.orderNo} line ${change.orderItemIndex}${change.note ? ` - ${change.note}` : ''}`,
      orderId: change.ctx.orderId,
      orderItemIndex: change.orderItemIndex,
      reservationId: change.reservationId,
      actorUserId: change.actorUserId ?? null,
      idempotencyKey: change.idempotencyKey,
      session: tx,
    });
  }

  private toObjectId(raw?: string | null): Types.ObjectId | null {
    if (!raw || !Types.ObjectId.isValid(raw)) return null;
    return new Types.ObjectId(raw);
  }

  private toIso(value?: Date | null): string | null {
    return value ? new Date(value).toISOString() : null;
  }
}