import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DeliveryCompanyDocument = DeliveryCompany & Document;

@Schema({ timestamps: true })
export class DeliveryCompany {
  @Prop({ required: true, unique: true })
  slug: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  displayName: string;

  @Prop({ default: '' })
  logoPath: string;

  @Prop({ type: [{ key: { type: String }, label: { type: String }, fieldType: { type: String, default: 'text' } }], default: [] })
  credentialFields: { key: string; label: string; fieldType: string }[];

  @Prop({ default: false })
  hasHandler: boolean;

  @Prop({ default: false })
  hasPickupPoints: boolean;

  @Prop({ default: false })
  hasFeeSync: boolean;

  @Prop({ type: Object, default: {} })
  feeFetchCredentials: Record<string, string>;

  @Prop({ default: true })
  isActive: boolean;
}

export const DeliveryCompanySchema = SchemaFactory.createForClass(DeliveryCompany);
