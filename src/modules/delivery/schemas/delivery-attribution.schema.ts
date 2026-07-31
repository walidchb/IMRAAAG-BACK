import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type DeliveryAttributionDocument = DeliveryAttribution & Document;

@Schema({ timestamps: true })
export class DeliveryAttribution {
  @Prop({ type: Types.ObjectId, ref: 'User' })
  vendorId: Types.ObjectId;

  @Prop({ required: true })
  vendorEmail: string;

  @Prop({ type: Map, of: String })
  attributions: Record<string, string>;
}

export const DeliveryAttributionSchema = SchemaFactory.createForClass(DeliveryAttribution);

DeliveryAttributionSchema.index({ vendorEmail: 1 }, { unique: true });
DeliveryAttributionSchema.index({ vendorId: 1 });
