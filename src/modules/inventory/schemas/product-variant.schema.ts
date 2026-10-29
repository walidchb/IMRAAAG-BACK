import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ProductVariantDocument = ProductVariant & Document;

@Schema({ timestamps: true })
export class ProductVariant {
  // NOTE: `type` is the string alias, not `mongoose.Types.ObjectId`. Under Mongoose 9 the
  // constructor form resolves to `Mixed`, so nothing casts `storeId`/`productId` and a caller
  // passing a hex string writes a BSON string - which then never matches the `Store._id`
  // ObjectId it is compared against.
  @Prop({ type: 'ObjectId', ref: 'Store', required: true, index: true })
  storeId: Types.ObjectId;

  @Prop({ type: 'ObjectId', ref: 'Product', required: true, index: true })
  productId: Types.ObjectId;

  /**
   * `sha1` of the sorted, `:`-joined optionValueIds.
   *
   * Deliberately order-independent: the seller may list dimensions in any order, and
   * reordering them must not produce a second, duplicate variant for the same
   * combination. The unique index below is what actually enforces uniqueness - this
   * field only makes the comparison cheap.
   */
  @Prop({ type: String, required: true })
  combinationKey: string;

  /** Nullable/sparse; unique per store when present (see the sparse index below). */
  @Prop({ type: String, default: null })
  sku?: string | null;

  @Prop({ type: String, default: null })
  barcode?: string | null;

  /** When null, price is inherited from `Product.price`. */
  @Prop({ type: Number, default: null })
  priceOverride?: number | null;

  @Prop({ type: Number, default: null })
  compareAtPrice?: number | null;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  /** Overrides `Product.lowStockThreshold` when set. */
  @Prop({ type: Number, default: null })
  lowStockThreshold?: number | null;

  @Prop({ type: String, default: null })
  image?: string | null;

  /** Matrix row/column order. */
  @Prop({ type: Number, default: 0 })
  position: number;

  /**
   * Soft delete only, matching the `Order.isDeleted` convention. Hard-deleting a
   * variant would orphan its balance, its join rows, and every movement that references
   * it, none of which carry a compensating record.
   */
  @Prop({ type: Boolean, default: false })
  isDeleted: boolean;

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export const ProductVariantSchema = SchemaFactory.createForClass(ProductVariant);

ProductVariantSchema.index({ productId: 1, combinationKey: 1 }, { unique: true });

// Per-store SKU uniqueness. The partial filter keeps every null/missing-SKU variant out
// of the index, so unlimited variants without a SKU are allowed. `partialFilterExpression`
// alone is used: MongoDB rejects an index spec that also sets `sparse`.
ProductVariantSchema.index(
  { storeId: 1, sku: 1 },
  {
    unique: true,
    partialFilterExpression: { sku: { $type: 'string' } },
  },
);

ProductVariantSchema.index({ productId: 1, isActive: 1 });

// POS barcode lookup (roadmap Phase 1) *and* per-store barcode uniqueness (Barcode/SKU/Label
// plan): a barcode is only meaningful within a store, so the store leads; the partial filter
// keeps every barcode-less variant (the common case) out of the index entirely.
ProductVariantSchema.index(
  { storeId: 1, barcode: 1 },
  {
    unique: true,
    partialFilterExpression: { barcode: { $type: 'string' } },
  },
);

// LO-5: the inventory list pipeline filters `storeId + isDeleted` first
// (`inventory-read.service.ts`), and every list query joins through `storeId + productId`.
// These compound indexes keep those reads from falling back to the single-field indexes.
ProductVariantSchema.index({ storeId: 1, isDeleted: 1 });
ProductVariantSchema.index({ storeId: 1, productId: 1 });