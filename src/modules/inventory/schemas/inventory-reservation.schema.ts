import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type InventoryReservationDocument = InventoryReservation & Document;

export const RESERVATION_STATUSES = ['active', 'released', 'consumed'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class InventoryReservation {
  @Prop({ type: 'ObjectId', ref: 'Store', required: true })
  storeId: Types.ObjectId;

  @Prop({ type: 'ObjectId', ref: 'Order', required: true })
  orderId: Types.ObjectId;

  @Prop({ type: 'ObjectId', ref: 'ProductVariant', required: true })
  variantId: Types.ObjectId;

  /**
   * Convenience pointer to the order line. The unique index below is what makes
   * "reserve once per line" idempotent, so a retried confirmation cannot double-reserve.
   */
  @Prop({ type: Number, required: true })
  orderItemIndex: number;

  @Prop({ type: Number, required: true, min: 1 })
  quantity: number;

  @Prop({ type: String, required: true, enum: RESERVATION_STATUSES, default: 'active' })
  status: ReservationStatus;

  @Prop({ type: Date, default: null })
  releasedAt?: Date | null;

  @Prop({ type: Date, default: null })
  consumedAt?: Date | null;
}

export const InventoryReservationSchema = SchemaFactory.createForClass(InventoryReservation);

// The idempotency key for "reserve once per order line". A duplicate insert raises
// E11000, which the service treats as "already reserved" rather than as a failure.
InventoryReservationSchema.index({ orderId: 1, orderItemIndex: 1 }, { unique: true });
InventoryReservationSchema.index({ storeId: 1, status: 1 });