import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type InventoryBalanceDocument = InventoryBalance & Document;

/**
 * Authoritative stock for one variant.
 *
 * Every product is a variant product, so one balance row exists per sellable variant and is
 * the only stock source for it. The old `Product.stock` field and the `hasVariants` switch
 * that used to select between the two were removed when variant mode became universal.
 */
@Schema({ timestamps: true })
export class InventoryBalance {
  @Prop({ type: 'ObjectId', ref: 'Store', required: true, index: true })
  storeId: Types.ObjectId;

  /**
   * One balance per variant. Multi-location is a spec non-goal, so `variantId` alone is
   * unique; `inventory_movements.locationId` is the door left open for that later.
   */
  @Prop({ type: 'ObjectId', ref: 'ProductVariant', required: true, unique: true })
  variantId: Types.ObjectId;

  /** Physical units held. Includes units that are reserved but not yet shipped. */
  @Prop({ type: Number, default: 0, min: 0 })
  onHand: number;

  /** Units held against an active order reservation. Never above `onHand`. */
  @Prop({ type: Number, default: 0, min: 0 })
  reserved: number;

  /**
   * Per-variant low-stock override. Beats the variant's own `lowStockThreshold`, which
   * in turn beats `Product.lowStockThreshold`.
   */
  @Prop({ type: Number, default: null })
  lowStockThreshold?: number | null;
}

export const InventoryBalanceSchema = SchemaFactory.createForClass(InventoryBalance);

InventoryBalanceSchema.index({ storeId: 1, onHand: 1 });

/**
 * `available` is deliberately **not stored** — it is always `onHand - reserved`, derived
 * on read. Storing it would be a third number that can drift from the other two.
 *
 * `reserved <= onHand` cannot be a MongoDB validator either: a validator cannot compare
 * two fields within the same document. It is enforced by the conditional-update
 * predicates in `InventoryService`, and `scripts/verify-inventory-reconciliation.js`
 * detects violations after the fact.
 */