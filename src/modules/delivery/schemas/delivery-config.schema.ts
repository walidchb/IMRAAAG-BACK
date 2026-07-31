import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type DeliveryConfigDocument = DeliveryConfig & Document;

@Schema({ timestamps: true })
export class DeliveryConfig {
  @Prop({ type: Types.ObjectId, ref: 'User' })
  vendorId: Types.ObjectId;

  @Prop({ required: true, unique: true })
  vendorEmail: string;

  @Prop({ type: Object, default: {} })
  companies: Record<string, {
    credentials: Record<string, string>;
    isDefault: boolean;
    status: 'enabled' | 'disabled';
  }>;
}

export const DeliveryConfigSchema = SchemaFactory.createForClass(DeliveryConfig);

DeliveryConfigSchema.index({ vendorId: 1 });
