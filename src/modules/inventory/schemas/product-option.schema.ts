import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ProductOptionDocument = ProductOption & Document;

/**
 * The supported variant types.
 * `color` means the option's values are shown as swatches; `size` is handled like color with auto names.
 * Presentation only - the option's identity is the `key` and its values' multilingual names.
 */
export type OptionType = 'text' | 'color' | 'size';

const OPTION_TYPES = ['text', 'color', 'size'] as const;

@Schema({ timestamps: true })
export class ProductOption {
  /** Canonical owner reference — the key every read and write selects on. */
  @Prop({ type: 'ObjectId', ref: 'Store', required: true, index: true })
  storeId: Types.ObjectId;

  @Prop({ type: 'ObjectId', ref: 'Product', required: true })
  productId: Types.ObjectId;

  /**
   * Machine key, slugified, unique per product - e.g. `size`, `color`, `shoe_size`.
   *
   * Derived from the English name by the service when the client omits it. This is part of
   * a variant's identity via its values, so renaming a *label* (`nameEn/nameAr/nameFr`) is
   * safe while changing a `key` is not.
   */
  @Prop({ type: String, required: true, trim: true })
  key: string;
  /** `text`, `color`, or `size`. See `OptionType`.
   */
  @Prop({ type: String, default: 'text', enum: OPTION_TYPES })
  type: OptionType;

  /** Labels, following the repo's per-language i18n convention. */
  @Prop({ type: String })
  nameEn?: string;

  @Prop({ type: String })
  nameAr?: string;

  @Prop({ type: String })
  nameFr?: string;

  /** Ordering is presentation only. */
  @Prop({ type: Number, default: 0 })
  position: number;

  /**
   * True only for the auto-seeded "Default > One Size" scaffold a new product gets until it
   * grows real options. Distinct from `key === 'default'`: a seller's own option named
   * "Default" legitimately wants that key, and must never be mistaken for the scaffold.
   */
  @Prop({ type: Boolean, default: false })
  isDefault?: boolean;
}

export const ProductOptionSchema = SchemaFactory.createForClass(ProductOption);

ProductOptionSchema.index({ productId: 1, position: 1 });
ProductOptionSchema.index({ productId: 1, key: 1 }, { unique: true });