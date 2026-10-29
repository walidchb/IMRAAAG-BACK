import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ProductOptionValueDocument = ProductOptionValue & Document;

@Schema({ timestamps: true })
export class ProductOptionValue {
  @Prop({ type: 'ObjectId', ref: 'Store', required: true })
  storeId: Types.ObjectId;

  /**
   * Denormalised from the owning option so "all values on product X" is a single
   * indexed query instead of a join.
   */
  @Prop({ type: 'ObjectId', ref: 'Product', required: true, index: true })
  productId: Types.ObjectId;

  @Prop({ type: 'ObjectId', ref: 'ProductOption', required: true, index: true })
  optionId: Types.ObjectId;

  /**
   * Canonical machine value, unique per option. This participates in a variant's
   * `combinationKey`, so renaming a *label* below is safe while changing `value` is not.
   *
   * Derived by the service from the English label when the client omits it.
   */
  @Prop({ type: String, required: true, trim: true })
  value: string;

  @Prop({ type: String })
  valueEn?: string;

  @Prop({ type: String })
  valueAr?: string;

  @Prop({ type: String })
  valueFr?: string;

  /**
   * Display-only hex colour, present when the owning option's `type` is `color`.
   * It renders a swatch dot on the storefront and is never used as identity, in a
   * variant label, or in order lines - the real value of an option is its
   * (multilingual) text name above.
   */
  @Prop({ type: String, default: null })
  color?: string | null;

  @Prop({ type: Number, default: 0 })
  position: number;

  /**
   * Retired values are deactivated, never deleted - a variant still references this
   * `_id` through `combinationKey`, and so does every historical order line.
   */
  @Prop({ type: Boolean, default: true })
  isActive: boolean;
}

export const ProductOptionValueSchema = SchemaFactory.createForClass(ProductOptionValue);

ProductOptionValueSchema.index({ optionId: 1, position: 1 });
ProductOptionValueSchema.index({ optionId: 1, value: 1 }, { unique: true });