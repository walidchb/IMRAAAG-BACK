import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ProductDocument = Product & Document;

@Schema({ timestamps: true })
export class Product {
  /** @deprecated Migration shim — use `storeId`. Retained until store-id migration completes. */
  @Prop({ required: true, trim: true })
  vendorEmail: string;

  /** @deprecated Migration shim — use `storeId`. Retained until store-id migration completes. */
  @Prop({ trim: true })
  vendorId: string;

  /** Canonical owner reference. Populated by backfill + dual-write during migration. */
  @Prop({ type: Types.ObjectId, ref: 'Store' })
  storeId?: Types.ObjectId;

  /** @deprecated Use `storeId` instead */
  @Prop({ type: Types.ObjectId, ref: 'Store' })
  storeId_vendorEmail?: Types.ObjectId;
  @Prop({ required: true, trim: true })
  nameEn: string;

  @Prop({ required: true, trim: true })
  nameAr: string;

  @Prop({ required: true, trim: true })
  nameFr: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  slug: string;

  @Prop()
  storyEn: string;

  @Prop()
  storyAr: string;

  @Prop()
  storyFr: string;

  @Prop({ type: Types.ObjectId, ref: 'Category', required: true })
  category: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'SubCategory' })
  subCategory: Types.ObjectId;

  @Prop({ required: true, min: 0 })
  originalPrice: number;

  @Prop({ required: true, min: 0 })
  price: number;

  /**
   * Stock no longer lives on the product. Every product carries a variant matrix and its
   * sellable quantities live in `InventoryBalance` rows reached through the variants
   * (`Product -> Variant -> Inventory`). Simple-search results, order lines and listing
   * availability all go through `InventoryReadService.getStockSource`.
   *
   * The old `stock` and `hasVariants` fields were removed when variant mode became
   * universal: legacy documents are migrated by `scripts/migrate-simple-to-default-variant.js`
   * (creates a default variant + balance for those still carrying a `stock` figure, then
   * `$unset`s both fields).
   */

  /** Product-level low-stock alert threshold. Variant/balance overrides beat this. */
  @Prop({ type: Number, default: null })
  lowStockThreshold?: number | null;

  @Prop({ required: true, min: 0, default: 1 })
  weight: number;

  @Prop()
  image: string;

  @Prop([String])
  images: string[];

  /** The single visibility flag. `true` = shown to customers; `false` = hidden (a "draft"). */
  @Prop({ default: false })
  published: boolean;

  /**
   * The embedded `variants` array that used to live here is gone.
   *
   * It was a list of *option groups* (`{ nameEn: 'Size', options: [{ nameEn: 'S' }] }`), not a
   * list of sellable variants: it carried no `_id` per unit, no `sku`, no price and no stock,
   * so it could never be the thing an inventory row is built from. Worse, it was writable
   * straight from `POST /products`, which let a product hold a full variant-shaped array while
   * still reporting `hasVariants: false` and being read as a simple product.
   *
   * Every product is now a variant product. Options and values live only in `ProductOption` /
   * `ProductOptionValue`, and stock only in `InventoryBalance`, all reached through the matrix
   * API. `scripts/migrate-legacy-variants.js` converted the old documents and
   * `scripts/migrate-simple-to-default-variant.js` converted the remaining simple ones.
   */
}

export const ProductSchema = SchemaFactory.createForClass(Product);

// Deliberately NO `text` index: none of the search paths query `$text`. Storefront search,
// the inventory list and the product autocomplete all match with escaped `$regex` (see
// `products.service.ts` `escapeRegex` / `inventory-read.service.ts`), because substring
// prefix-matching across name+story fields is the behaviour they need and `$text` cannot do
// it (tokenized, stemmed, no partial matches). A text index would still tax every insert
// (tokenize + index six language fields) for zero reads — Phase 8 dropped it. Add it back
// only if a genuine full-text query is introduced (likely a dedicated storefront search
// collection, not this catalog collection).
ProductSchema.index({ vendorEmail: 1 });
ProductSchema.index({ vendorId: 1 });
ProductSchema.index({ storeId: 1 });
ProductSchema.index({ category: 1, subCategory: 1 });
ProductSchema.index({ price: 1 });
ProductSchema.index({ published: 1 });
// Cursor pagination indexes
ProductSchema.index({ published: 1, createdAt: -1, _id: -1 });
ProductSchema.index({ published: 1, category: 1, createdAt: -1, _id: -1 });
ProductSchema.index({ published: 1, vendorEmail: 1, createdAt: -1, _id: -1 });
ProductSchema.index({ published: 1, storeId: 1, createdAt: -1, _id: -1 });
ProductSchema.index({ published: 1, price: 1, createdAt: -1, _id: -1 });
