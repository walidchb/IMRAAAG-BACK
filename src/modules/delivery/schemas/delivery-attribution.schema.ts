import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type DeliveryAttributionDocument = DeliveryAttribution & Document;

@Schema({ timestamps: true })
export class DeliveryAttribution {
  @Prop({ type: Types.ObjectId, ref: 'User' })
  vendorId: Types.ObjectId;

  /** @deprecated Migration shim — use `storeId`. Retained until store-id migration completes. */
  @Prop({ required: true })
  vendorEmail: string;

  /** Canonical owner reference. Populated by backfill + dual-write during migration. */
  @Prop({ type: Types.ObjectId, ref: 'Store' })
  storeId?: Types.ObjectId;

  @Prop({ type: Map, of: String })
  attributions: Record<string, string>;
}

export const DeliveryAttributionSchema = SchemaFactory.createForClass(DeliveryAttribution);

DeliveryAttributionSchema.index({ vendorEmail: 1 }, { unique: true });
DeliveryAttributionSchema.index({ vendorId: 1 });
DeliveryAttributionSchema.index({ storeId: 1 }, { unique: true, sparse: true });
