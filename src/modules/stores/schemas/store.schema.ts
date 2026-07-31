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

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  storeSlug: string;

  @Prop({ required: true })
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

  @Prop({ default: StoreStatus.ACTIVE, enum: StoreStatus })
  status: StoreStatus;

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
}

export const StoreSchema = SchemaFactory.createForClass(Store);

// Indexes
StoreSchema.index({ storeName: 'text', description: 'text' });
StoreSchema.index({ storeName: 1 });
StoreSchema.index({ storeSlug: 1 });
StoreSchema.index({ vendorEmail: 1 });
StoreSchema.index({ vendorId: 1 });
StoreSchema.index({ status: 1 });
