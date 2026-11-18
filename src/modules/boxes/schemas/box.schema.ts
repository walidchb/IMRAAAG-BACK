import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BoxDocument = Box & Document;

/**
 * A seller-defined promotional Box: the customer picks exactly `requiredQuantity` units
 * from an explicit variant set and pays one fixed `price` per complete Box.
 *
 * There is deliberately no stock field. A Box has no inventory of its own — availability is
 * computed from the eligible variants' real balances on every read (BR11 / D5), and stock is
 * deducted from those variants by the ordinary order lines a Box expands into.
 */
@Schema({ timestamps: true })
export class Box {
  @Prop({ type: 'ObjectId', ref: 'Store', required: true, index: true })
  storeId: Types.ObjectId;

  /** Legacy dual-write only; never accepted from a client as an ownership key. */
  @Prop({ required: true, trim: true })
  vendorEmail: string;

  /** Globally unique, matching `Product.slug`. A collision gets a `-<timestamp>-<rand>` suffix. */
  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug: string;

  @Prop({ required: true, trim: true })
  nameEn: string;

  @Prop({ required: true, trim: true })
  nameAr: string;

  @Prop({ required: true, trim: true })
  nameFr: string;

  @Prop()
  descriptionEn?: string;

  @Prop()
  descriptionAr?: string;

  @Prop()
  descriptionFr?: string;

  @Prop()
  image?: string;

  @Prop({ type: [String], default: [] })
  images: string[];

  /** Fixed integer DZD price per complete Box. Never recomputed from component prices. */
  @Prop({ required: true, min: 0 })
  price: number;

  /** Exactly how many physical items one Box contains. Positive integer, 1–50. */
  @Prop({ required: true, min: 1, max: 50 })
  requiredQuantity: number;

  /** When true a single variant may fill more than one unit of a Box. */
  @Prop({ type: Boolean, default: true })
  allowDuplicates: boolean;

  /**
   * Explicit variant-level eligibility: one entry per product, each naming the exact
   * variants the customer may pick. "All variants" is a UI action that expands to every
   * active variant at save time — a later variant is never silently eligible (D3).
   */
  @Prop([
    {
      _id: false,
      productId: { type: 'ObjectId', ref: 'Product', required: true },
      variantIds: { type: ['ObjectId'], required: true },
    },
  ])
  eligibleItems: Array<{ productId: Types.ObjectId; variantIds: Types.ObjectId[] }>;

  @Prop({ type: Boolean, default: false })
  published: boolean;

  @Prop({ type: Boolean, default: false })
  isArchived: boolean;

  @Prop({ type: Date, default: null })
  archivedAt: Date | null;

  @Prop({ type: String, default: null })
  archivedBy: string | null;
}

export const BoxSchema = SchemaFactory.createForClass(Box);

// Vendor listing (active/draft newest-first and archived newest-first).
BoxSchema.index({ storeId: 1, isArchived: 1, createdAt: -1, _id: -1 });
BoxSchema.index({ storeId: 1, isArchived: 1, archivedAt: -1, _id: -1 });
// Public storefront listing (published, non-archived, newest-first).
BoxSchema.index({ storeId: 1, published: 1, isArchived: 1, createdAt: -1, _id: -1 });
// Eligibility drift / delete-guard lookups.
BoxSchema.index({ 'eligibleItems.productId': 1 });
BoxSchema.index({ 'eligibleItems.variantIds': 1 });
