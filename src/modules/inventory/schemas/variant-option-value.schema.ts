import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type VariantOptionValueDocument = VariantOptionValue & Document;

/**
 * Join row: which option values make up one variant.
 *
 * Kept as documents rather than an array on the variant because `optionValueId` must be
 * indexed in its own right — "which variants use this value?" is the query behind
 * deactivating a value safely.
 */
@Schema({ timestamps: false })
export class VariantOptionValue {
  @Prop({ type: 'ObjectId', ref: 'Store', required: true, index: true })
  storeId: Types.ObjectId;

  @Prop({ type: 'ObjectId', ref: 'ProductVariant', required: true })
  variantId: Types.ObjectId;

  /**
   * There is no foreign key here: MongoDB cannot enforce that this value belongs to the
   * same product as `variantId`. `VariantsService` checks it on write, and
   * `scripts/verify-inventory-integrity.js` re-checks it across the live database.
   */
  @Prop({ type: 'ObjectId', ref: 'ProductOptionValue', required: true, index: true })
  optionValueId: Types.ObjectId;
}

export const VariantOptionValueSchema = SchemaFactory.createForClass(VariantOptionValue);

VariantOptionValueSchema.index({ variantId: 1, optionValueId: 1 }, { unique: true });