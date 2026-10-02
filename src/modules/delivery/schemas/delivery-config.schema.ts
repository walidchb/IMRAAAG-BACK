import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type DeliveryConfigDocument = DeliveryConfig & Document;

@Schema({ timestamps: true })
export class DeliveryConfig {
  @Prop({ type: Types.ObjectId, ref: 'User' })
  vendorId: Types.ObjectId;

  /** @deprecated Migration shim — use `storeId`. Retained until store-id migration completes. */
  @Prop({ required: true, unique: true })
  vendorEmail: string;

  /** Canonical owner reference. Populated by backfill + dual-write during migration. */
  @Prop({ type: Types.ObjectId, ref: 'Store' })
  storeId?: Types.ObjectId;

  @Prop({ type: Object, default: {} })
  companies: Record<string, {
    credentials: Record<string, string>;
    isDefault: boolean;
    status: 'enabled' | 'disabled';
  }>;
}

export const DeliveryConfigSchema = SchemaFactory.createForClass(DeliveryConfig);

DeliveryConfigSchema.index({ vendorId: 1 });
DeliveryConfigSchema.index({ storeId: 1 }, { unique: true, sparse: true });
