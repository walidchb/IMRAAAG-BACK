import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type InventoryMovementDocument = InventoryMovement & Document;

/**
 * The nine movement types from spec section 6.4. The spec says "at least", so this is a
 * floor rather than a ceiling — adding a type is a deliberate schema change.
 */
export const INVENTORY_MOVEMENT_TYPES = [
  'initial_stock',
  'manual_increase',
  'manual_decrease',
  'order_reservation',
  'reservation_release',
  'fulfillment_deduction',
  'return_restock',
  'damage_write_off',
  'correction',
] as const;

export type InventoryMovementType = (typeof INVENTORY_MOVEMENT_TYPES)[number];

/**
 * Append-only ledger. There is no `updatedAt`: a movement is a statement of something
 * that happened, so editing one would falsify history. Corrections are new rows.
 *
 * This collection grows faster than any other in the system — every read must be
 * cursor-paginated and index-covered, never loaded unbounded.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class InventoryMovement {
  @Prop({ type: 'ObjectId', ref: 'Store', required: true })
  storeId: Types.ObjectId;

  @Prop({ type: 'ObjectId', ref: 'ProductVariant', required: true })
  variantId: Types.ObjectId;

  /** Null today (single location); present for future multi-location. */
  @Prop({ type: 'ObjectId', default: null })
  locationId?: Types.ObjectId | null;

  @Prop({ type: String, required: true, enum: INVENTORY_MOVEMENT_TYPES })
  type: InventoryMovementType;

  /** Signed. Reservations move `reserved`, not `onHand`, so their delta may be zero. */
  @Prop({ type: Number, required: true })
  quantityDelta: number;

  /** Both sides recorded, not just the delta, so the ledger can be replayed. */
  @Prop({ type: Number, required: true })
  onHandBefore: number;

  @Prop({ type: Number, required: true })
  onHandAfter: number;

  @Prop({ type: Number, required: true })
  reservedBefore: number;

  @Prop({ type: Number, required: true })
  reservedAfter: number;

  /** Seller-supplied on manual adjustments; system-set on automatic ones. */
  @Prop({ type: String, default: null })
  reason?: string | null;

  @Prop({ type: 'ObjectId', ref: 'Order', default: null })
  orderId?: Types.ObjectId | null;

  /**
   * Convenience pointer to the order line. `Order.items[].lineId` is the stable key —
   * see §4.4, option O-A — but the index in `inventory_reservations` is on
   * `orderItemIndex`, so both are kept.
   */
  @Prop({ type: Number, default: null })
  orderItemIndex?: number | null;

  @Prop({ type: 'ObjectId', ref: 'InventoryReservation', default: null })
  reservationId?: Types.ObjectId | null;

  /** Null only for system actions. */
  @Prop({ type: 'ObjectId', ref: 'User', default: null })
  actorUserId?: Types.ObjectId | null;

  /**
   * Seller-visible free text. Must never receive customer PII — spec section 12.
   * No phone number, name, or address may be written here.
   */
  @Prop({ type: String, default: null })
  note?: string | null;

  /**
   * A retry with the same key is a no-op rather than a double count.
   *
   * Deliberately **no default**. The unique index below filters on `type: 'string'`, and a
   * `default: null` would write the field on every row as an explicit null — which the index
   * would still treat as a value, making the *second* movement without a key collide with the
   * first (`E11000`). A sparse index would not help: sparse skips only *missing* fields, and
   * a default makes the field present.
   */
  @Prop({ type: String })
  idempotencyKey?: string | null;

  /** Declared explicitly: `timestamps` is applied by Mongoose, not by the type. */
  createdAt: Date;
}

export const InventoryMovementSchema = SchemaFactory.createForClass(InventoryMovement);

InventoryMovementSchema.index({ storeId: 1, variantId: 1, createdAt: -1 });
InventoryMovementSchema.index({ storeId: 1, createdAt: -1 });
// Every ledger read (`listForVariant`, `listForStore`, `listForOrder`) sorts `{_id: -1}` and
// paginates with `_id < cursor`. The `createdAt` indexes above cover equality + date windows
// but force an in-memory sort for the `_id` ordering and cannot bound the cursor predicate,
// so the ledger reads get `_id`-sorted compound indexes: filter, sort and cursor all resolved
// by the index for the store as a whole, for one variant, and for one order. `_id` and
// `createdAt` are both insertion-monotonic, so these cover the same reads the date indexes do
// without the sort they would have had to pay (Phase 8, LO-5).
InventoryMovementSchema.index({ orderId: 1, _id: -1 });
InventoryMovementSchema.index({ storeId: 1, _id: -1 });
InventoryMovementSchema.index({ storeId: 1, variantId: 1, _id: -1 });
// Only real keys participate. `partialFilterExpression` rather than `sparse` because MongoDB
// rejects an index that sets both, and `sparse` alone cannot exclude an explicit null.
InventoryMovementSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);