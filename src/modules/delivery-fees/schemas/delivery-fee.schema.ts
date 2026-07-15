import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DeliveryFeeDocument = DeliveryFee & Document;

@Schema({ timestamps: true, strict: false })
export class DeliveryFee {
  @Prop({ required: true })
  vendorEmail: string;

  @Prop({ type: Object, default: {} })
  fees: Record<string, { homeDeliveryFee: number; stopDeskDeliveryFee: number }>;
}

export const DeliveryFeeSchema = SchemaFactory.createForClass(DeliveryFee);

DeliveryFeeSchema.index({ vendorEmail: 1 }, { unique: true });