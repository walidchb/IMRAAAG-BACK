import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { StoreStatus } from './store-status.enum';

export type StoreDocument = Store & Document;

@Schema({ timestamps: true })
export class Store {
  @Prop({ type: Types.ObjectId, ref: 'User' })
  vendorId: Types.ObjectId;

  @Prop({ required: true, lowercase: true, trim: true })
  vendorEmail: string;

  @Prop({ required: true, trim: true, unique: true })
  storeName: string;

  /** @deprecated Use `storeId` instead */
  @Prop({ type: Types.ObjectId, ref: 'Store' })
  storeId?: Types.ObjectId;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  storeSlug: string;

  // Optional: only `storeName`, `storeSlug` (derived from the name) and the contact
  // identity (`vendorEmail`) are mandatory. Every other attribute - description, logo,
  // cover, location, socials - is optional.
  @Prop()
  description: string;

  @Prop()
  storeLogo: string;

  @Prop()
  coverImage: string;

  @Prop()
  contactEmail: string;

  @Prop()
  contactPhone: string;

  @Prop({ type: [String], default: [] })
  contactPhones: string[];

  @Prop()
  wilaya: string;

  @Prop()
  commune: string;

  @Prop({ type: [String], default: [] })
  categories: string[];

  @Prop()
  tagline: string;

  @Prop({ type: Object, default: {} })
  socialMedia: Record<string, string>;

  @Prop({ type: String, default: StoreStatus.ACTIVE, enum: Object.values(StoreStatus) })
  status: StoreStatus;

  /**
   * Per-store rollout switch for variant inventory.
   *
   * `false` for every existing store, so nothing changes until a vendor opts in. This is not
   * the per-product variant mode or a per-product stock source: with inventory enabled the
   * whole store's stock is managed through the inventory module. (The old `hasVariants`
   * field that used to select a stock source per product is gone - every product is a
   * variant product now.)
   */
  @Prop({ default: false })
  inventoryEnabled: boolean;

  /** @deprecated Use `wilaya` and `commune` root-level fields instead */
  @Prop({
    type: {
      street: String,
      city: String,
      state: String,
      country: String,
      postalCode: String
    }
  })
  address: {
    street?: string;
    city?: string;
    state?: string;
    country?: string;
    postalCode?: string;
  };

  @Prop({ default: 0 })
  totalProducts: number;

  @Prop({ default: 0 })
  totalOrders: number;

  /**
   * Barcode/SKU plan (Phase 1): monotonic source for collision-free EAN-13 barcode bodies.
   *
   * Advanced with an atomic `$inc` each time a barcode is generated for this store, so two
   * concurrent generations can never share a body. Defaults to 0, which is why every existing
   * store needs no migration - the first generated barcode simply gets body `0000000001`.
   * Nothing reads this field until Phase 3.
   */
  @Prop({ default: 0 })
  barcodeSeq: number;
}

export const StoreSchema = SchemaFactory.createForClass(Store);

// Indexes
StoreSchema.index({ storeName: 'text', description: 'text' });
StoreSchema.index({ storeName: 1 });
StoreSchema.index({ storeSlug: 1 });
StoreSchema.index({ vendorEmail: 1 });
StoreSchema.index({ vendorId: 1 });
StoreSchema.index({ status: 1 });
