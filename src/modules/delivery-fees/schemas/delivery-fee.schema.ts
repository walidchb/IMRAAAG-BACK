import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import * as mongoose from 'mongoose';

export type DeliveryFeeDocument = DeliveryFee & Document;

const FeeSubSchema = new mongoose.Schema({
  homeDeliveryFee: { type: Number, default: 0 },
  stopDeskDeliveryFee: { type: Number, default: 0 },
}, { _id: false });

@Schema({ timestamps: true })
export class DeliveryFee {
  @Prop({ type: Types.ObjectId, ref: 'User' })
  vendorId: Types.ObjectId;

  @Prop({ required: true })
  vendorEmail: string;

  @Prop({ type: Map, of: FeeSubSchema, default: {} })
  fees: Record<string, { homeDeliveryFee: number; stopDeskDeliveryFee: number }>;
}

export const DeliveryFeeSchema = SchemaFactory.createForClass(DeliveryFee);

DeliveryFeeSchema.index({ vendorEmail: 1 }, { unique: true });
DeliveryFeeSchema.index({ vendorId: 1 });
